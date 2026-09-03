import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, isDesktop, windowAction } from './bridge'
import type { ColumnInfo, ConnectionStatus, PostgresConfig, QueryResult, RowOperation, SavedConnection, TableData, TableSummary } from './types'
import { Alert, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Clock, Code, Columns, Database, Eye, File, Filter, Key, More, PanelLeft, Play, Plus, Redo, Refresh, Save, Search, Table, Trash, Undo, X } from './icons'

const EMPTY_STATUS: ConnectionStatus = { connected: false, name: '', path: '', driver: '', readOnly: false }
const EMPTY_DATA: TableData = { columns: [], rows: [], total: 0, durationMs: 0 }
const PAGE_SIZE = 50
const tableKey = (item: TableSummary) => `${item.schema}\u0000${item.name}`
type PendingOperation = RowOperation & { id: string }
type GridRowMeta = { id: string; kind: 'clean' | 'update' | 'insert' | 'delete'; canEdit: boolean; primaryKey: Record<string, unknown>; baseIndex?: number }
type DraftHistory = { past: PendingOperation[][]; present: PendingOperation[]; future: PendingOperation[][] }

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

function buildDraftGrid(data: TableData, schema: ColumnInfo[], operations: PendingOperation[], page: number): { data: TableData; meta: GridRowMeta[] } {
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

function DataGrid({ data, sortColumn, sortDirection, onSort, compact = false, layoutKey, editable = false, onUpdate, rowMeta = [], selected = new Set(), onSelect }: {
  data: Pick<TableData, 'columns' | 'rows'>
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
}) {
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
  const tableWidth = 44 + shown.reduce((total, { column }) => total + (widths[column] ?? 160), 0)

  function resize(event: React.PointerEvent, column: string) {
    event.preventDefault(); event.stopPropagation()
    const start = event.clientX; const initial = event.currentTarget.parentElement?.getBoundingClientRect().width ?? widths[column] ?? 160
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
        <colgroup><col className="row-col"/>{shown.map(({ column }) => <col key={column} style={{ width: widths[column] ?? 160 }}/>)}</colgroup>
        <thead><tr><th className="row-number">#</th>{shown.map(({ column }) => (
          <th key={column} onClick={() => onSort?.(column)} draggable={Boolean(layoutKey)} onDragStart={() => setDragging(column)} onDragOver={event => event.preventDefault()} onDrop={() => dropColumn(column)} className={`${onSort ? 'sortable' : ''} ${dragging === column ? 'dragging' : ''}`}>
            <span>{column}</span>
            {sortColumn === column && (sortDirection === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/>)}
            {layoutKey && <i className="column-resizer" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onPointerDown={event => resize(event, column)}/>} 
          </th>
        ))}</tr></thead>
        <tbody>{data.rows.map((row, rowIndex) => <tr key={rowMeta[rowIndex]?.id ?? rowIndex} className={`draft-${rowMeta[rowIndex]?.kind ?? 'clean'} ${selected.has(rowMeta[rowIndex]?.id ?? '') ? 'selected' : ''}`}>
          <td className="row-number"><button className="row-selector" disabled={!onSelect || (rowMeta[rowIndex]?.kind !== 'insert' && !rowMeta[rowIndex]?.canEdit)} onClick={() => rowMeta[rowIndex] && onSelect?.(rowMeta[rowIndex].id)}>{selected.has(rowMeta[rowIndex]?.id ?? '') ? <Check size={11}/> : rowIndex + 1}</button></td>
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

function Welcome({ onOpen, onPostgres, onDemo, busy }: { onOpen: () => void; onPostgres: () => void; onDemo: () => void; busy: boolean }) {
  return <main className="welcome">
    <div className="welcome-glow" />
    <div className="welcome-content">
      <div className="welcome-mark"><Database size={34}/></div>
      <p className="eyebrow">DATABASE WORKSPACE</p>
      <h1>Your data, without<br/><span>the noise.</span></h1>
      <p className="welcome-copy">A fast, focused database browser for inspecting schemas, exploring records, and running safe queries.</p>
      <div className="welcome-actions">
        <button className="primary large" onClick={onOpen} disabled={busy}><File size={17}/> Open SQLite database</button>
        <button className="secondary large postgres-button" onClick={onPostgres} disabled={busy}><Database size={16}/> Connect PostgreSQL</button>
      </div>
      <button className="demo-link" onClick={onDemo} disabled={busy}><Play size={13}/> Explore with demo data</button>
      <div className="welcome-features">
        <span><Check size={14}/> Native desktop app</span><span><Check size={14}/> Read-only by default</span><span><Check size={14}/> Data stays local</span>
      </div>
    </div>
  </main>
}

function TitleBar() {
  return <div className="titlebar" onDoubleClick={() => windowAction('maximise')}>
    <div className="traffic-lights">
      <button aria-label="Close" onClick={() => windowAction('close')}/>
      <button aria-label="Minimise" onClick={() => windowAction('minimise')}/>
      <button aria-label="Maximise" onClick={() => windowAction('maximise')}/>
    </div>
    <div className="drag-title">QueryNest</div>
    <div className="build-tag">{isDesktop() ? 'LOCAL' : 'BROWSER PREVIEW'}</div>
  </div>
}

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>(EMPTY_STATUS)
  const [tables, setTables] = useState<TableSummary[]>([])
  const [activeTable, setActiveTable] = useState('')
  const [tabs, setTabs] = useState<string[]>([])
  const [data, setData] = useState<TableData>(EMPTY_DATA)
  const [schema, setSchema] = useState<ColumnInfo[]>([])
  const [view, setView] = useState<'data' | 'structure'>('data')
  const [filter, setFilter] = useState('')
  const [sidebarFilter, setSidebarFilter] = useState('')
  const [page, setPage] = useState(0)
  const [sortColumn, setSortColumn] = useState('')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [loading, setLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [queryOpen, setQueryOpen] = useState(false)
  const [query, setQuery] = useState("SELECT status, COUNT(*) AS count\nFROM customers\nGROUP BY status\nORDER BY count DESC;")
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [queryRunning, setQueryRunning] = useState(false)
  const [error, setError] = useState('')
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [draftsByTable, setDraftsByTable] = useState<Record<string, DraftHistory>>({})
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [guardedAction, setGuardedAction] = useState<{ table: string; title: string; message: string; run: () => void | Promise<void> } | null>(null)
  const activeSummary = tables.find(item => tableKey(item) === activeTable)
  const activeHistory = draftsByTable[activeTable] ?? { past: [], present: [], future: [] }
  const activeOperations = activeHistory.present
  const draftGrid = useMemo(() => buildDraftGrid(data, schema, activeOperations, page), [data, schema, activeOperations, page])

  const loadTables = useCallback(async () => {
    const next = await api().ListTables()
    setTables(next ?? [])
    if (!activeTable && next?.length) openTable(next[0])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTable])

  useEffect(() => {
    api().GetStatus().then(async next => {
      setStatus(next)
      if (next.connected) await loadTables()
    }).catch(e => setError(String(e))).finally(() => setLoading(false))
  }, [loadTables])

  useEffect(() => {
    if (!activeTable || !status.connected) return
    const selected = tables.find(item => tableKey(item) === activeTable)
    if (!selected) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const [nextData, nextSchema] = await Promise.all([
          api().GetTableData(selected.schema, selected.name, PAGE_SIZE, page * PAGE_SIZE, filter, sortColumn, sortDirection),
          api().GetTableSchema(selected.schema, selected.name),
        ])
        if (!cancelled) { setData(nextData); setSchema(nextSchema) }
      } catch (e) { if (!cancelled) setError(String(e)) }
      finally { if (!cancelled) setLoading(false) }
    }, filter ? 250 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeTable, filter, page, sortColumn, sortDirection, status.connected, tables])

  useEffect(() => { setSelectedRows(new Set()) }, [activeTable, page])

  function openTable(item: TableSummary) {
    const key = tableKey(item)
    setActiveTable(key); setTabs(current => current.includes(key) ? current : [...current, key])
    setPage(0); setFilter(''); setSortColumn(''); setView('data'); setQueryOpen(false)
  }

  function closeTabNow(name: string) {
    const next = tabs.filter(tab => tab !== name)
    setTabs(next)
    if (activeTable === name) setActiveTable(next.at(-1) ?? '')
  }

  function closeTab(name: string) {
    guardUnsaved(name, 'Close this tab?', 'This tab has changes that have not been saved.', () => closeTabNow(name))
  }

  async function connect(kind: 'file' | 'demo') {
    setLoading(true); setError('')
    try {
      const next = kind === 'file' ? await api().ChooseSQLiteFile() : await api().ConnectDemo()
      setStatus(next)
      if (next.connected) {
        const found = await api().ListTables()
        setTables(found ?? [])
        if (found?.length) openTable(found[0])
        setConnectionOpen(false)
      }
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  async function connectPostgres(config: PostgresConfig) {
    setLoading(true); setError('')
    try {
      const next = await api().ConnectPostgres(config)
      setStatus(next)
      const found = await api().ListTables()
      setTables(found ?? []); setTabs([]); setActiveTable(''); setConnectionOpen(false)
      if (found?.length) openTable(found[0])
    } catch (e) { setError(String(e)); throw e }
    finally { setLoading(false) }
  }

  async function connectSaved(id: string, password: string) {
    setLoading(true); setError('')
    try {
      const next = await api().ConnectSavedConnection(id, password)
      setStatus(next)
      const found = await api().ListTables()
      setTables(found ?? []); setTabs([]); setActiveTable(''); setConnectionOpen(false)
      if (found?.length) openTable(found[0])
    } catch (e) { setError(String(e)); throw e }
    finally { setLoading(false) }
  }

  async function disconnectNow() {
    await api().Disconnect(); setStatus(EMPTY_STATUS); setTables([]); setTabs([]); setActiveTable(''); setData(EMPTY_DATA)
  }

  function disconnect() {
    if (activeTable) guardUnsaved(activeTable, 'Disconnect database?', 'Unsaved changes in this tab will be lost.', disconnectNow)
    else void disconnectNow()
  }

  async function refreshNow() {
    setLoading(true); setError('')
    try { await loadTables(); if (activeSummary) setData(await api().GetTableData(activeSummary.schema, activeSummary.name, PAGE_SIZE, page * PAGE_SIZE, filter, sortColumn, sortDirection)) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  function refresh() {
    guardUnsaved(activeTable, 'Refresh table?', 'Refreshing will replace the rows that contain unsaved changes.', refreshNow)
  }

  function changeSortNow(column: string) {
    if (sortColumn === column) setSortDirection(value => value === 'asc' ? 'desc' : 'asc')
    else { setSortColumn(column); setSortDirection('asc') }
    setPage(0)
  }

  function changeSort(column: string) {
    guardUnsaved(activeTable, 'Change sorting?', 'Sorting may replace rows that contain unsaved changes.', () => changeSortNow(column))
  }

  async function executeQuery() {
    setQueryRunning(true); setError('')
    try { setQueryResult(await api().ExecuteQuery(query)) }
    catch (e) { setError(String(e)) }
    finally { setQueryRunning(false) }
  }

  function changeDraft(key: string, change: (operations: PendingOperation[]) => PendingOperation[]) {
    if (!key) return
    setDraftsByTable(current => {
      const history = current[key] ?? { past: [], present: [], future: [] }
      const nextOperations = change(history.present)
      if (JSON.stringify(nextOperations) === JSON.stringify(history.present)) return current
      return {
        ...current,
        [key]: {
          past: [...history.past, history.present].slice(-100),
          present: nextOperations,
          future: [],
        },
      }
    })
  }

  function clearDraft(key: string) {
    setDraftsByTable(current => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function undoDraft(key = activeTable) {
    setDraftsByTable(current => {
      const history = current[key]
      if (!history?.past.length) return current
      const previous = history.past[history.past.length - 1]
      return { ...current, [key]: { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future].slice(0, 100) } }
    })
    setSelectedRows(new Set())
  }

  function redoDraft(key = activeTable) {
    setDraftsByTable(current => {
      const history = current[key]
      if (!history?.future.length) return current
      const nextOperations = history.future[0]
      return { ...current, [key]: { past: [...history.past, history.present].slice(-100), present: nextOperations, future: history.future.slice(1) } }
    })
    setSelectedRows(new Set())
  }

  async function updateCell(column: string, rowIndex: number, value: unknown) {
    const meta = draftGrid.meta[rowIndex]
    if (!meta || meta.kind === 'delete') return
    changeDraft(activeTable, current => {
      const operations = [...current]
      const index = operations.findIndex(operation => operation.id === meta.id)
      if (meta.kind === 'insert') {
        if (index >= 0) operations[index] = { ...operations[index], values: { ...operations[index].values, [column]: value } }
      } else {
        const sourceIndex = data.columns.indexOf(column)
        const original = meta.baseIndex === undefined ? undefined : data.rows[meta.baseIndex]?.[sourceIndex]
        const values = index >= 0 && operations[index].type === 'update' ? { ...operations[index].values } : {}
        if (JSON.stringify(value) === JSON.stringify(original)) delete values[column]
        else values[column] = value
        if (index >= 0) operations.splice(index, 1)
        if (Object.keys(values).length) operations.push({ id: meta.id, type: 'update', values, primaryKey: meta.primaryKey })
      }
      return operations
    })
  }

  function addRecord() {
    const id = `new:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
    changeDraft(activeTable, current => [...current, { id, type: 'insert', values: {}, primaryKey: {} }])
    setView('data')
  }

  function toggleSelected(id: string) {
    setSelectedRows(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }

  function deleteSelected() {
    if (!selectedRows.size) return
    changeDraft(activeTable, current => {
      let operations = [...current]
      for (const id of selectedRows) {
        const meta = draftGrid.meta.find(item => item.id === id)
        if (!meta) continue
        if (meta.kind === 'insert') operations = operations.filter(operation => operation.id !== id)
        else if (meta.canEdit) {
          operations = operations.filter(operation => operation.id !== id)
          operations.push({ id, type: 'delete', values: {}, primaryKey: meta.primaryKey })
        }
      }
      return operations
    })
    setSelectedRows(new Set())
  }

  function stageTruncateNow() {
    changeDraft(activeTable, () => [{ id: 'truncate', type: 'truncate', values: {}, primaryKey: {} }])
    setSelectedRows(new Set())
  }

  function stageTruncate() {
    if (activeOperations.length && !activeOperations.some(operation => operation.type === 'truncate')) guardUnsaved(activeTable, 'Replace pending changes?', 'Truncate will replace the edits already staged in this tab.', stageTruncateNow)
    else stageTruncateNow()
  }

  async function saveChanges(key = activeTable) {
    const item = tables.find(table => tableKey(table) === key)
    const operations = draftsByTable[key]?.present ?? []
    if (!item || !operations.length) return
    setLoading(true); setError('')
    try {
      await api().ApplyChanges(item.schema, item.name, operations.map(({ id: _id, ...operation }) => operation))
      clearDraft(key)
      if (key === activeTable) {
        setData(await api().GetTableData(item.schema, item.name, PAGE_SIZE, page * PAGE_SIZE, filter, sortColumn, sortDirection))
        setSelectedRows(new Set())
      }
      await loadTables()
    } catch (e) { setError(String(e)); throw e }
    finally { setLoading(false) }
  }

  function discardChanges(key: string) {
    clearDraft(key)
    setSelectedRows(new Set())
  }

  function guardUnsaved(key: string, title: string, message: string, run: () => void | Promise<void>) {
    if ((draftsByTable[key]?.present ?? []).length) setGuardedAction({ table: key, title, message, run })
    else void run()
  }

  function changeFilter(next: string) {
    guardUnsaved(activeTable, 'Apply filter?', 'This filter may hide rows with unsaved changes.', () => { setFilter(next); setPage(0) })
  }

  function changePage(next: number) {
    guardUnsaved(activeTable, 'Change page?', 'Changing page will hide rows with unsaved changes.', () => setPage(next))
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTextEditor = target?.matches('input, textarea, [contenteditable="true"]')
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if ((draftsByTable[activeTable]?.present ?? []).length) void saveChanges(activeTable).catch(() => {})
      } else if (!isTextEditor && !guardedAction && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoDraft(activeTable)
        else undoDraft(activeTable)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTable, draftsByTable, tables, data, filter, page, sortColumn, sortDirection, guardedAction])

  const filteredTables = useMemo(() => tables.filter(table => table.name.toLowerCase().includes(sidebarFilter.toLowerCase())), [tables, sidebarFilter])
  const tableItems = filteredTables.filter(item => item.type === 'table')
  const viewItems = filteredTables.filter(item => item.type === 'view')
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

  if (!status.connected && !loading) {
    return <div className="app-shell"><TitleBar/><Welcome onOpen={() => connect('file')} onPostgres={() => setConnectionOpen(true)} onDemo={() => connect('demo')} busy={loading}/>{connectionOpen && <ConnectionModal onSQLite={() => connect('file')} onPostgres={connectPostgres} onSaved={connectSaved} onClose={() => setConnectionOpen(false)}/>} {error && <Toast message={error} onClose={() => setError('')}/>}</div>
  }

  return <div className="app-shell">
    <TitleBar/>
    <div className="workspace">
      {sidebarOpen && <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Database size={18}/></div><span>QueryNest</span><button className="icon-button"><More size={17}/></button></div>
        <button className="connection-card" title={status.path} onClick={() => setConnectionOpen(true)}>
          <span className={`db-avatar ${status.driver === 'PostgreSQL' ? 'postgres' : ''}`}>{status.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span><span className="connection-text"><b>{status.name}</b><small><i className="online-dot"/> {status.driver} · {status.readOnly ? 'Read-only' : 'Editable'}</small></span><ChevronDown size={15}/>
        </button>
        <div className="side-search"><Search size={14}/><input value={sidebarFilter} onChange={e => setSidebarFilter(e.target.value)} placeholder="Filter objects"/><kbd>⌘K</kbd></div>
        <div className="object-tree">
          <ObjectGroup label="Tables" count={tableItems.length}>{tableItems.map(item => <ObjectRow key={tableKey(item)} item={item} active={activeTable === tableKey(item)} onClick={() => openTable(item)}/>)}</ObjectGroup>
          <ObjectGroup label="Views" count={viewItems.length}>{viewItems.map(item => <ObjectRow key={tableKey(item)} item={item} active={activeTable === tableKey(item)} onClick={() => openTable(item)}/>)}</ObjectGroup>
        </div>
        <div className="sidebar-footer"><button onClick={() => setConnectionOpen(true)}><Plus size={15}/> New connection</button><button onClick={disconnect} className="icon-button" title="Disconnect"><X size={15}/></button></div>
      </aside>}
      <section className="main-panel">
        <div className="top-tabs">
          <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen(value => !value)} title="Toggle sidebar"><PanelLeft size={17}/></button>
          <div className="tabs-scroll">{tabs.map(tab => { const item = tables.find(value => tableKey(value) === tab); const changes = draftsByTable[tab]?.present.length ?? 0; return item ? <button key={tab} onClick={() => setActiveTable(tab)} className={`tab ${activeTable === tab ? 'active' : ''} ${changes ? 'changed' : ''}`}><Table size={14}/><b className="tab-label">{item.name}</b>{changes > 0 && <i className="tab-change-dot" title={`${changes} pending change(s)`}/>}<span onClick={e => { e.stopPropagation(); closeTab(tab) }}><X size={13}/></span></button> : null })}</div>
          <button className={`query-tab ${queryOpen ? 'active' : ''}`} onClick={() => setQueryOpen(value => !value)}><Code size={15}/> SQL</button>
          <button className="icon-button" onClick={() => setConnectionOpen(true)}><Plus size={17}/></button>
        </div>
        {activeTable ? <>
          <header className="content-header">
            <div><div className="breadcrumbs"><span>{status.name}</span><ChevronRight size={13}/><span>{activeSummary?.schema}</span><ChevronRight size={13}/><b>{activeSummary?.name}</b></div><h2>{activeSummary?.name}<span>{activeSummary?.type ?? 'table'}</span></h2></div>
            <div className="header-actions"><button className="secondary" onClick={() => setQueryOpen(true)}><Code size={15}/> Query</button><button className="primary" onClick={refresh}><Refresh size={15} className={loading ? 'spin' : ''}/> Refresh</button></div>
          </header>
          <div className="data-toolbar">
            <div className="view-switch"><button className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}><Table size={14}/> Data</button><button className={view === 'structure' ? 'active' : ''} onClick={() => setView('structure')}><Columns size={14}/> Structure <span>{schema.length}</span></button></div>
            {view === 'data' && !status.readOnly && activeSummary?.type === 'table' && <div className="row-actions"><button onClick={addRecord}><Plus size={14}/> New row</button><button className="danger-action" disabled={!selectedRows.size} onClick={deleteSelected}><Trash size={14}/> Delete</button><button className="danger-action" onClick={stageTruncate}><Trash size={14}/> Truncate</button></div>}
            <div className="toolbar-spacer"/>
            {view === 'data' && <>{!status.readOnly && activeSummary?.type === 'table' && <div className="draft-actions"><button disabled={!activeHistory.past.length} onClick={() => undoDraft()} title="Undo draft change (Ctrl+Z)"><Undo size={14}/> Undo</button><button disabled={!activeHistory.future.length} onClick={() => redoDraft()} title="Redo draft change (Ctrl+Shift+Z)"><Redo size={14}/> Redo</button>{activeOperations.length > 0 && <button className="discard-draft" onClick={() => discardChanges(activeTable)} title="Discard all changes in this table"><X size={14}/> Discard</button>}</div>}<label className="record-search"><Search size={14}/><input value={filter} onChange={e => changeFilter(e.target.value)} placeholder="Search records..."/>{filter && <button onClick={() => changeFilter('')}><X size={13}/></button>}</label><button className="tool-button"><Filter size={14}/> Filter</button><button className="tool-button"><Columns size={14}/> Columns</button>{activeOperations.length > 0 && <button className="save-changes" onClick={() => void saveChanges().catch(() => {})}><Save size={14}/> Save <b>{activeOperations.length}</b><kbd>Ctrl S</kbd></button>}</>}
          </div>
          <div className={`content-body ${queryOpen ? 'with-query' : ''}`}>
            {view === 'data' ? <DataGrid data={draftGrid.data} rowMeta={draftGrid.meta} selected={selectedRows} onSelect={toggleSelected} sortColumn={sortColumn} sortDirection={sortDirection} onSort={changeSort} layoutKey={`${status.driver}:${status.path}:${activeSummary?.schema}.${activeSummary?.name}`} editable={!status.readOnly} onUpdate={updateCell}/> : <SchemaView schema={schema}/>} 
            {loading && <div className="loading-bar"/>}
          </div>
          {!queryOpen && <footer className="pagination"><span>{data.total ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, data.total)} of ${data.total.toLocaleString()} rows` : '0 rows'}</span><span className="query-time"><Clock size={13}/>{data.durationMs} ms</span>{!status.readOnly && schema.some(column => column.primaryKey) && <span className="edit-hint">Double-click a cell to edit</span>}<div className="page-controls"><button disabled={page === 0} onClick={() => changePage(page - 1)}><ChevronRight size={14} className="flip"/></button><span>Page {page + 1} of {totalPages}</span><button disabled={page + 1 >= totalPages} onClick={() => changePage(page + 1)}><ChevronRight size={14}/></button></div></footer>}
          {queryOpen && <QueryPanel query={query} setQuery={setQuery} result={queryResult} running={queryRunning} onRun={executeQuery} onClose={() => setQueryOpen(false)}/>} 
        </> : <div className="no-table"><Table size={30}/><h3>Select a table</h3><p>Choose a table or view from the sidebar.</p></div>}
      </section>
    </div>
    {error && <Toast message={error} onClose={() => setError('')}/>} 
    {connectionOpen && <ConnectionModal onSQLite={() => connect('file')} onPostgres={connectPostgres} onSaved={connectSaved} onClose={() => setConnectionOpen(false)}/>} 
    {guardedAction && <UnsavedModal title={guardedAction.title} message={guardedAction.message} count={(draftsByTable[guardedAction.table]?.present ?? []).length} onCancel={() => setGuardedAction(null)} onDiscard={async () => { const action = guardedAction; discardChanges(action.table); setGuardedAction(null); await action.run() }} onSave={async () => { const action = guardedAction; try { await saveChanges(action.table); setGuardedAction(null); await action.run() } catch { /* Keep dialog open when save fails. */ } }}/>} 
  </div>
}

function ObjectGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return <div className="object-group"><button className="group-title" onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<span>{label}</span><em>{count}</em></button>{open && <div>{children}</div>}</div>
}

function ObjectRow({ item, active, onClick }: { item: TableSummary; active: boolean; onClick: () => void }) {
  return <button title={`${item.schema}.${item.name}`} className={`object-row ${active ? 'active' : ''}`} onClick={onClick}>{item.type === 'view' ? <Eye size={14}/> : <Table size={14}/>}<span>{item.name}</span><small>{item.rows >= 0 ? item.rows.toLocaleString() : '—'}</small></button>
}

function SchemaView({ schema }: { schema: ColumnInfo[] }) {
  return <div className="schema-wrap"><table className="schema-table"><thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>Key</th></tr></thead><tbody>{schema.map(column => <tr key={column.name}><td><span className="field-icon">{column.primaryKey ? <Key size={13}/> : <Columns size={13}/>}</span><b>{column.name}</b></td><td><code>{column.type || 'ANY'}</code></td><td>{column.nullable ? 'YES' : 'NO'}</td><td>{column.default === null ? <span className="muted">—</span> : String(column.default)}</td><td>{column.primaryKey ? <span className="primary-key"><Key size={12}/> PRIMARY</span> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div>
}

function QueryPanel({ query, setQuery, result, running, onRun, onClose }: { query: string; setQuery: (value: string) => void; result: QueryResult | null; running: boolean; onRun: () => void; onClose: () => void }) {
  return <section className="query-panel">
    <div className="query-header"><div><Code size={15}/><b>SQL Query</b><span>Read-only</span></div><div><span className="shortcut">⌘ ↵ to run</span><button className="icon-button" onClick={onClose}><X size={15}/></button></div></div>
    <div className="query-workspace">
      <div className="editor-wrap"><div className="line-numbers">{query.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea value={query} spellCheck={false} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onRun() }}/><button className="run-query" disabled={running} onClick={onRun}><Play size={14}/>{running ? 'Running…' : 'Run query'}</button></div>
      <div className="query-results">{result ? <><div className="result-meta"><Check size={13}/>{result.message}<span>{result.durationMs} ms</span></div><DataGrid data={result} compact/></> : <div className="result-placeholder"><Play size={20}/><span>Run the query to see results</span></div>}</div>
    </div>
  </section>
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

function UnsavedModal({ title, message, count, onCancel, onDiscard, onSave }: { title: string; message: string; count: number; onCancel: () => void; onDiscard: () => Promise<void>; onSave: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<void>) => { setBusy(true); try { await action() } finally { setBusy(false) } }
  return <div className="modal-backdrop unsaved-backdrop">
    <section className="unsaved-modal" role="alertdialog" aria-modal="true">
      <div className="unsaved-icon"><Alert size={21}/></div>
      <h3>{title}</h3>
      <p>{message}</p>
      <div className="pending-summary"><span>{count}</span> pending change{count === 1 ? '' : 's'}</div>
      <footer><button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="discard-button" disabled={busy} onClick={() => void run(onDiscard)}>Discard changes</button><button className="primary" disabled={busy} onClick={() => void run(onSave)}><Save size={14}/> Save & continue</button></footer>
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

function ConnectionModal({ onSQLite, onPostgres, onSaved, onClose }: { onSQLite: () => void; onPostgres: (config: PostgresConfig) => Promise<void>; onSaved: (id: string, password: string) => Promise<void>; onClose: () => void }) {
  const [config, setConfig] = useState<PostgresConfig>({ id: '', name: 'Local PostgreSQL', host: 'localhost', port: 5432, user: 'postgres', password: '', database: 'postgres', sslMode: 'prefer', readOnly: false, saveConnection: true, savePassword: true })
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState<SavedConnection[]>([])
  const update = <K extends keyof PostgresConfig>(key: K, value: PostgresConfig[K]) => setConfig(current => ({ ...current, [key]: value }))

  useEffect(() => { api().ListSavedConnections().then(setSaved).catch(() => setSaved([])) }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSubmitting(true)
    try { await onPostgres(config) } catch { /* Parent displays the connection error. */ }
    finally { setSubmitting(false) }
  }

  async function openSaved(profile: SavedConnection) {
    if (profile.driver === 'PostgreSQL' && !profile.hasPassword) {
      setConfig(current => ({ ...current, id: profile.id, name: profile.name, host: profile.host ?? 'localhost', port: profile.port ?? 5432, user: profile.user ?? 'postgres', database: profile.database ?? 'postgres', sslMode: (profile.sslMode as PostgresConfig['sslMode']) ?? 'prefer', readOnly: profile.readOnly, saveConnection: true, savePassword: true }))
      return
    }
    setSubmitting(true)
    try { await onSaved(profile.id, '') } catch { /* Parent displays the connection error. */ }
    finally { setSubmitting(false) }
  }

  async function removeSaved(event: React.MouseEvent, id: string) {
    event.stopPropagation()
    try { await api().DeleteSavedConnection(id); setSaved(current => current.filter(item => item.id !== id)) } catch { /* Keep the item if deletion fails. */ }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="connection-modal" role="dialog" aria-modal="true" aria-label="New database connection">
      <header><div className="modal-mark"><Database size={19}/></div><div><h3>New connection</h3><p>Connect securely to your database</p></div><button className="icon-button" onClick={onClose}><X size={17}/></button></header>
      {saved.length > 0 && <div className="saved-connections"><div className="saved-title"><span>Saved connections</span><em>{saved.length}</em></div><div className="saved-list">{saved.map(profile => <button key={profile.id} className="saved-row" onClick={() => openSaved(profile)} disabled={submitting}><span className={`kind-logo ${profile.driver === 'PostgreSQL' ? 'postgres' : 'sqlite'}`}>{profile.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span><span><b>{profile.name}</b><small>{profile.driver === 'PostgreSQL' ? `${profile.host}:${profile.port}/${profile.database}` : profile.path}</small></span>{profile.hasPassword && <Key size={13}/>}<i onClick={event => void removeSaved(event, profile.id)}><X size={13}/></i></button>)}</div></div>}
      <div className="connection-kinds">
        <button className="kind-card" onClick={onSQLite}><span className="kind-logo sqlite">SQ</span><span><b>SQLite</b><small>Open a local database file</small></span><ChevronRight size={15}/></button>
        <div className="kind-card active"><span className="kind-logo postgres">PG</span><span><b>PostgreSQL</b><small>Host and credentials</small></span><Check size={15}/></div>
      </div>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="span-2"><span>Connection name</span><input required value={config.name} onChange={e => update('name', e.target.value)} placeholder="Production database"/></label>
          <label className="span-2"><span>Host</span><input required value={config.host} onChange={e => update('host', e.target.value)} placeholder="localhost" autoFocus/></label>
          <label><span>Port</span><input required type="number" min={1} max={65535} value={config.port} onChange={e => update('port', Number(e.target.value))}/></label>
          <label><span>SSL mode</span><select value={config.sslMode} onChange={e => update('sslMode', e.target.value as PostgresConfig['sslMode'])}><option value="prefer">Prefer</option><option value="require">Require</option><option value="verify-ca">Verify CA</option><option value="verify-full">Verify full</option><option value="disable">Disable</option><option value="allow">Allow</option></select></label>
          <label className="span-2"><span>Database</span><input required value={config.database} onChange={e => update('database', e.target.value)} placeholder="postgres"/></label>
          <label><span>User</span><input required value={config.user} onChange={e => update('user', e.target.value)} placeholder="postgres" autoComplete="username"/></label>
          <label><span>Password</span><input type="password" value={config.password} onChange={e => update('password', e.target.value)} placeholder="Optional" autoComplete="current-password"/></label>
        </div>
        <div className="connection-options"><label><input type="checkbox" checked={config.saveConnection} onChange={e => update('saveConnection', e.target.checked)}/><span>Save connection</span></label><label className={!config.saveConnection ? 'disabled' : ''}><input type="checkbox" checked={config.savePassword} disabled={!config.saveConnection} onChange={e => update('savePassword', e.target.checked)}/><span>Save password securely</span></label><label><input type="checkbox" checked={config.readOnly} onChange={e => update('readOnly', e.target.checked)}/><span>Read-only</span></label></div>
        <footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={submitting}>{submitting ? <Refresh size={15} className="spin"/> : <Database size={15}/>} {submitting ? 'Connecting…' : 'Connect'}</button></footer>
      </form>
    </section>
  </div>
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  const clean = message.replace(/^Error:\s*/i, '')
  return <div className="toast"><Alert size={17}/><span>{clean}</span><button onClick={onClose}><X size={14}/></button></div>
}
