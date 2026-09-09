import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { ColumnInfo, RowOperation, TableData } from './types'
import { Alert, ArrowDown, ArrowUp, Check, Code, Columns, X } from './icons'

export type PendingOperation = RowOperation & { id: string }

type GridRowMeta = {
  id: string
  kind: 'clean' | 'update' | 'insert' | 'delete'
  canEdit: boolean
  primaryKey: Record<string, unknown>
  baseIndex?: number
}

type DataGridProps = {
  data: Pick<TableData, 'columns' | 'rows'> & Partial<Pick<TableData, 'total'>>
  sortColumn?: string
  sortDirection?: string
  onSort?: (column: string) => void
  compact?: boolean
  layoutKey?: string
  editable?: boolean
  onUpdate?: (column: string, rowIndex: number, value: unknown) => Promise<void>
  rowMeta?: GridRowMeta[]
  selected?: Set<string>
  onSelect?: (id: string) => void
  rowOffset?: number
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return <span className="null-value">NULL</span>
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function jsonText(value: unknown): string | null {
  if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try { return JSON.stringify(JSON.parse(trimmed), null, 2) } catch { return null }
}

function editedValue(text: string, original: unknown): unknown {
  if (text.trim().toLowerCase() === 'null') return null
  if (typeof original === 'number') { const number = Number(text); return Number.isNaN(number) ? text : number }
  if (typeof original === 'boolean') return text.toLowerCase() === 'true'
  return text
}

function primaryKeyFor(row: unknown[], columns: string[], schema: ColumnInfo[]) {
  const key: Record<string, unknown> = {}
  for (const info of schema.filter(column => column.primaryKey)) {
    const index = columns.indexOf(info.name)
    if (index >= 0) key[info.name] = row[index]
  }
  return key
}

function existingRowID(key: Record<string, unknown>, page: number, index: number) {
  return Object.keys(key).length ? `row:${JSON.stringify(key)}` : `readonly:${page}:${index}`
}

export function buildDraftGrid(data: TableData, schema: ColumnInfo[], operations: PendingOperation[], page: number): { data: TableData; meta: GridRowMeta[] } {
  const truncate = operations.some(operation => operation.type === 'truncate')
  const rows: unknown[][] = []
  const meta: GridRowMeta[] = []
  data.rows.forEach((baseRow, baseIndex) => {
    const primaryKey = primaryKeyFor(baseRow, data.columns, schema)
    const id = existingRowID(primaryKey, page, baseIndex)
    const update = operations.find(operation => operation.id === id && operation.type === 'update')
    const deleted = truncate || operations.some(operation => operation.id === id && operation.type === 'delete')
    const row = data.columns.map((column, index) => update && column in update.values ? update.values[column] : baseRow[index])
    rows.push(row)
    meta.push({ id, kind: deleted ? 'delete' : update ? 'update' : 'clean', canEdit: !deleted && Object.keys(primaryKey).length > 0, primaryKey, baseIndex })
  })
  for (const operation of operations.filter(item => item.type === 'insert')) {
    rows.push(data.columns.map(column => column in operation.values ? operation.values[column] : null))
    meta.push({ id: operation.id, kind: 'insert', canEdit: true, primaryKey: {} })
  }
  return { data: { ...data, rows }, meta }
}

export default function DataGrid({ data, sortColumn, sortDirection, onSort, compact = false, layoutKey, editable = false, onUpdate, rowMeta = [], selected = new Set(), onSelect, rowOffset = 0 }: DataGridProps) {
  const [order, setOrder] = useState<string[]>(data.columns)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [dragging, setDragging] = useState('')
  const [editing, setEditing] = useState<{ row: number; column: string; text: string; original: unknown } | null>(null)
  const [saving, setSaving] = useState(false)
  const [jsonCell, setJsonCell] = useState<{ row: number; column: string; value: unknown } | null>(null)
  const cancelBlurRef = useRef(false)

  useEffect(() => {
    let savedOrder: string[] = []
    let savedWidths: Record<string, number> = {}
    if (layoutKey) {
      try {
        const saved = JSON.parse(localStorage.getItem(`querynest:grid:${layoutKey}`) ?? '{}')
        savedOrder = Array.isArray(saved.order) ? saved.order : []
        savedWidths = saved.widths && typeof saved.widths === 'object' ? saved.widths : {}
      } catch { /* Ignore a corrupt local preference. */ }
    }
    const valid = savedOrder.filter(column => data.columns.includes(column))
    setOrder([...valid, ...data.columns.filter(column => !valid.includes(column))])
    setWidths(savedWidths)
  }, [layoutKey, data.columns.join('\u0000')])

  useEffect(() => {
    if (layoutKey && order.length) localStorage.setItem(`querynest:grid:${layoutKey}`, JSON.stringify({ order, widths }))
  }, [layoutKey, order, widths])

  const shown = order.map(column => ({ column, source: data.columns.indexOf(column) })).filter(item => item.source >= 0)
  const lastRowNumber = Math.max(1, data.total ?? 0, rowOffset + data.rows.length)
  const rowNumberWidth = Math.max(52, 28 + String(lastRowNumber).length * 8)
  const tableWidth = rowNumberWidth + shown.reduce((total, { column }) => total + (widths[column] ?? 160), 0)

  function resize(event: ReactPointerEvent, column: string) {
    event.preventDefault(); event.stopPropagation()
    const start = event.clientX; const initial = widths[column] ?? 160
    const move = (next: PointerEvent) => setWidths(current => ({ ...current, [column]: Math.max(72, Math.min(600, initial + next.clientX - start)) }))
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }

  function dropColumn(target: string) {
    if (!dragging || dragging === target) return setDragging('')
    setOrder(current => {
      const next = current.filter(column => column !== dragging)
      next.splice(next.indexOf(target), 0, dragging)
      return next
    })
    setDragging('')
  }

  async function commitEdit() {
    if (!editing || !onUpdate || editing.text === String(editing.original ?? '')) return setEditing(null)
    setSaving(true)
    try { await onUpdate(editing.column, editing.row, editedValue(editing.text, editing.original)); setEditing(null) }
    catch { /* Parent surfaces the update error while keeping the editor open. */ }
    finally { setSaving(false) }
  }

  if (!data.columns.length) return <div className="empty-grid">No result columns</div>
  return (
    <div className={`grid-scroll ${compact ? 'compact' : ''}`}>
      <table className="data-grid" style={{ width: tableWidth, minWidth: tableWidth }}>
        <colgroup><col className="row-col" style={{ width: rowNumberWidth }}/>{shown.map(({ column }) => <col key={column} style={{ width: widths[column] ?? 160 }}/>)}</colgroup>
        <thead><tr><th className="row-number">#</th>{shown.map(({ column }, columnIndex) => (
          <th key={column} aria-sort={onSort ? sortColumn === column ? sortDirection === 'asc' ? 'ascending' : 'descending' : 'none' : undefined} onClick={() => onSort?.(column)} draggable={Boolean(layoutKey)} onDragStart={() => setDragging(column)} onDragOver={event => event.preventDefault()} onDrop={() => dropColumn(column)} className={`${onSort ? 'sortable' : ''} ${dragging === column ? 'dragging' : ''}`}>
            {layoutKey && columnIndex > 0 && <i className="column-resizer column-resizer-left" draggable={false} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation() }} onPointerDown={event => resize(event, shown[columnIndex - 1].column)}/>}
            <span>{column}</span>
            {sortColumn === column && (sortDirection === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/>)}
            {layoutKey && <i className="column-resizer column-resizer-right" draggable={false} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation() }} onPointerDown={event => resize(event, column)}/>}
          </th>
        ))}</tr></thead>
        <tbody>{data.rows.map((row, rowIndex) => <tr key={rowMeta[rowIndex]?.id ?? rowIndex} className={`draft-${rowMeta[rowIndex]?.kind ?? 'clean'} ${selected.has(rowMeta[rowIndex]?.id ?? '') ? 'selected' : ''}`}>
          <td className="row-number"><button className="row-selector" disabled={!onSelect || (rowMeta[rowIndex]?.kind !== 'insert' && !rowMeta[rowIndex]?.canEdit)} onClick={() => rowMeta[rowIndex] && onSelect?.(rowMeta[rowIndex].id)}>{selected.has(rowMeta[rowIndex]?.id ?? '') ? <Check size={11}/> : rowOffset + rowIndex + 1}</button></td>
          {shown.map(({ column, source }) => {
            const value = row[source]; const text = String(value ?? '')
            const isStatus = column.toLowerCase() === 'status'; const json = jsonText(value)
            const isEditing = editing?.row === rowIndex && editing.column === column
            const canEdit = editable && (rowMeta[rowIndex]?.canEdit ?? true)
            return <td key={column} className={canEdit ? 'editable-cell' : ''} onDoubleClick={() => { if (canEdit && onUpdate) { cancelBlurRef.current = false; setEditing({ row: rowIndex, column, text: String(value ?? ''), original: value }) } }}>
              {isEditing ? <input className="cell-editor" autoFocus disabled={saving} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') { cancelBlurRef.current = true; setEditing(null); event.currentTarget.blur() }
              }} onBlur={() => {
                if (cancelBlurRef.current) { cancelBlurRef.current = false; return }
                if (!saving) void commitEdit()
              }}/>
              : json ? <button className="json-cell" title={JSON.stringify(JSON.parse(json))} onClick={() => setJsonCell({ row: rowIndex, column, value })}><Code size={13}/><span className="json-preview">{JSON.stringify(JSON.parse(json))}</span></button>
              : <span className={isStatus ? `status-pill ${text.toLowerCase()}` : ''}>{formatCell(value)}</span>}
            </td>
          })}
        </tr>)}</tbody>
      </table>
      {jsonCell && <JsonModal value={jsonCell.value} editable={editable && (rowMeta[jsonCell.row]?.canEdit ?? true)} onClose={() => setJsonCell(null)} onSave={onUpdate ? async value => { await onUpdate(jsonCell.column, jsonCell.row, value); setJsonCell(null) } : undefined}/>} 
    </div>
  )
}

function JsonModal({ value, editable, onClose, onSave }: { value: unknown; editable: boolean; onClose: () => void; onSave?: (value: string) => Promise<void> }) {
  const [text, setText] = useState(jsonText(value) ?? '')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [invalid, setInvalid] = useState('')

  async function save() {
    try {
      const formatted = JSON.stringify(JSON.parse(text), null, 2)
      setInvalid(''); setSaving(true)
      await onSave?.(formatted)
    } catch (error) {
      if (error instanceof SyntaxError) setInvalid(error.message)
    } finally { setSaving(false) }
  }

  return <div className="modal-backdrop json-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="json-modal" role="dialog" aria-modal="true" aria-label="JSON viewer">
      <header><div><span className="json-braces">{'{}'}</span><span><h3>JSON value</h3><p>{text.length.toLocaleString()} characters</p></span></div><div><button className="secondary" onClick={() => navigator.clipboard?.writeText(text)}><Columns size={14}/> Copy</button>{editable && <button className="secondary" onClick={() => setEditing(value => !value)}>{editing ? 'Preview' : 'Edit JSON'}</button>}<button className="icon-button" onClick={onClose}><X size={17}/></button></div></header>
      <div className={`json-content ${editing ? 'editing' : ''}`}>{editing ? <textarea value={text} onChange={event => { setText(event.target.value); setInvalid('') }} spellCheck={false} autoFocus/> : <pre>{syntaxJSON(text)}</pre>}</div>
      {invalid && <div className="json-error"><Alert size={14}/>{invalid}</div>}
      <footer><span>{editing ? 'Changes are validated before saving' : 'Formatted JSON preview'}</span><div><button className="secondary" onClick={onClose}>Close</button>{editing && <button className="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save JSON'}</button>}</div></footer>
    </section>
  </div>
}

function syntaxJSON(text: string) {
  const parts = text.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)
  return parts.map((part, index) => {
    let type = ''
    if (/^".*":$/.test(part)) type = 'json-key'
    else if (/^"/.test(part)) type = 'json-string'
    else if (/^(true|false)$/.test(part)) type = 'json-boolean'
    else if (part === 'null') type = 'json-null'
    else if (/^-?\d/.test(part)) type = 'json-number'
    return type ? <span className={type} key={index}>{part}</span> : part
  })
}
