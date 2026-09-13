import { createEffect, createSignal, Index, mergeProps, on, onCleanup, Show, type JSX } from 'solid-js'
import type { ColumnInfo, RowOperation, TableData } from './types'
import { Alert, ArrowDown, ArrowUp, Check, Code, Columns, X } from './icons'

export type PendingOperation = RowOperation & { id: string }

// Paged table data stays well under this, so only large result sets — the SQL
// console returns up to 1000 rows with no paging — pay for windowed rendering.
const VIRTUAL_ROW_THRESHOLD = 120
const OVERSCAN_ROWS = 8

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

function formatCell(value: unknown): JSX.Element {
  if (value === null || value === undefined) return <span class="null-value">NULL</span>
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

export default function DataGrid(raw: DataGridProps) {
  const props = mergeProps({ compact: false, editable: false, rowMeta: [] as GridRowMeta[], rowOffset: 0 }, raw)
  const selected = () => props.selected ?? new Set<string>()
  const [order, setOrder] = createSignal<string[]>(props.data.columns)
  const [widths, setWidths] = createSignal<Record<string, number>>({})
  const [dragging, setDragging] = createSignal('')
  const [editing, setEditing] = createSignal<{ row: number; column: string; text: string; original: unknown } | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [jsonCell, setJsonCell] = createSignal<{ row: number; column: string; value: unknown } | null>(null)
  let cancelBlur = false
  let scroller!: HTMLDivElement
  let body!: HTMLTableSectionElement
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewport, setViewport] = createSignal(0)
  const [rowHeight, setRowHeight] = createSignal(props.compact ? 29 : 34)

  // Reload the stored layout whenever the tab's identity or column set changes.
  createEffect(on(() => [props.layoutKey, props.data.columns.join('\u0000')] as const, ([layoutKey]) => {
    let savedOrder: string[] = []
    let savedWidths: Record<string, number> = {}
    if (layoutKey) {
      try {
        const saved = JSON.parse(localStorage.getItem(`querynest:grid:${layoutKey}`) ?? '{}')
        savedOrder = Array.isArray(saved.order) ? saved.order : []
        savedWidths = saved.widths && typeof saved.widths === 'object' ? saved.widths : {}
      } catch { /* Ignore a corrupt local preference. */ }
    }
    const valid = savedOrder.filter(column => props.data.columns.includes(column))
    setOrder([...valid, ...props.data.columns.filter(column => !valid.includes(column))])
    setWidths(savedWidths)
  }))

  createEffect(() => {
    const layoutKey = props.layoutKey
    const currentOrder = order()
    const currentWidths = widths()
    if (layoutKey && currentOrder.length) localStorage.setItem(`querynest:grid:${layoutKey}`, JSON.stringify({ order: currentOrder, widths: currentWidths }))
  })

  const totalRows = () => props.data.rows.length
  const virtualized = () => totalRows() > VIRTUAL_ROW_THRESHOLD
  const firstRow = () => virtualized() ? Math.max(0, Math.floor(scrollTop() / rowHeight()) - OVERSCAN_ROWS) : 0
  const lastRow = () => {
    if (!virtualized()) return totalRows()
    const span = Math.ceil((viewport() || rowHeight() * 20) / rowHeight()) + OVERSCAN_ROWS * 2
    return Math.min(totalRows(), firstRow() + span)
  }
  const visibleRows = () => virtualized() ? props.data.rows.slice(firstRow(), lastRow()) : props.data.rows
  const padTop = () => firstRow() * rowHeight()
  const padBottom = () => Math.max(0, (totalRows() - lastRow()) * rowHeight())

  // A result with no columns renders the fallback instead of the scroll
  // container, so tracking has to wait for the element to exist and re-attach if
  // the grid is later replaced.
  createEffect(() => {
    if (!props.data.columns.length) return
    const element = scroller
    if (!element) return
    const onScroll = () => setScrollTop(element.scrollTop)
    const resize = new ResizeObserver(() => setViewport(element.clientHeight))
    element.addEventListener('scroll', onScroll, { passive: true })
    resize.observe(element)
    setViewport(element.clientHeight)
    onCleanup(() => { element.removeEventListener('scroll', onScroll); resize.disconnect() })
  })

  // Measure a rendered row so the spacers follow the stylesheet rather than a copy of it.
  createEffect(on(() => [virtualized(), props.compact] as const, ([isVirtual]) => {
    if (!isVirtual) return
    queueMicrotask(() => {
      const height = body?.querySelector<HTMLElement>('tr:not(.grid-spacer)')?.getBoundingClientRect().height
      if (height) setRowHeight(height)
    })
  }))

  const shown = () => order().map(column => ({ column, source: props.data.columns.indexOf(column) })).filter(item => item.source >= 0)
  const columnWidth = (column: string) => widths()[column] ?? 160
  const lastRowNumber = () => Math.max(1, props.data.total ?? 0, props.rowOffset + props.data.rows.length)
  const rowNumberWidth = () => Math.max(52, 28 + String(lastRowNumber()).length * 8)
  const tableWidth = () => rowNumberWidth() + shown().reduce((total, { column }) => total + columnWidth(column), 0)

  function resize(event: PointerEvent, column: string) {
    event.preventDefault(); event.stopPropagation()
    const start = event.clientX; const initial = columnWidth(column)
    const move = (next: PointerEvent) => setWidths(current => ({ ...current, [column]: Math.max(72, Math.min(600, initial + next.clientX - start)) }))
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }

  function dropColumn(target: string) {
    const held = dragging()
    if (!held || held === target) return setDragging('')
    setOrder(current => {
      const next = current.filter(column => column !== held)
      next.splice(next.indexOf(target), 0, held)
      return next
    })
    setDragging('')
  }

  async function commitEdit() {
    const active = editing()
    if (!active || !props.onUpdate || active.text === String(active.original ?? '')) return setEditing(null)
    setSaving(true)
    try { await props.onUpdate(active.column, active.row, editedValue(active.text, active.original)); setEditing(null) }
    catch { /* Parent surfaces the update error while keeping the editor open. */ }
    finally { setSaving(false) }
  }

  // A resize handle must never sort or reorder the column it sits on. Native listeners
  // stop the event before Solid's delegated header handlers can see it.
  const resizerFor = (column: () => string) => ({
    class: 'column-resizer',
    draggable: false,
    'on:click': (event: Event) => event.stopPropagation(),
    'on:dblclick': (event: Event) => event.stopPropagation(),
    'on:dragstart': (event: Event) => { event.preventDefault(); event.stopPropagation() },
    'on:pointerdown': (event: PointerEvent) => resize(event, column()),
  })

  return (
    <Show when={props.data.columns.length} fallback={<div class="empty-grid">No result columns</div>}>
      <div ref={scroller} class={`grid-scroll ${props.compact ? 'compact' : ''}`}>
        <table class="data-grid" style={{ width: `${tableWidth()}px`, 'min-width': `${tableWidth()}px` }} aria-rowcount={virtualized() ? totalRows() + 1 : undefined}>
          <colgroup><col class="row-col" style={{ width: `${rowNumberWidth()}px` }}/><Index each={shown()}>{item => <col style={{ width: `${columnWidth(item().column)}px` }}/>}</Index></colgroup>
          <thead><tr><th class="row-number">#</th><Index each={shown()}>{(item, columnIndex) => (
            <th
              aria-sort={props.onSort ? props.sortColumn === item().column ? props.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none' : undefined}
              onClick={() => props.onSort?.(item().column)}
              draggable={Boolean(props.layoutKey)}
              onDragStart={() => setDragging(item().column)}
              onDragOver={event => event.preventDefault()}
              onDrop={() => dropColumn(item().column)}
              class={`${props.onSort ? 'sortable' : ''} ${dragging() === item().column ? 'dragging' : ''}`}
            >
              <Show when={props.layoutKey && columnIndex > 0}>
                <i {...resizerFor(() => shown()[columnIndex - 1].column)} class="column-resizer column-resizer-left"/>
              </Show>
              <span>{item().column}</span>
              <Show when={props.sortColumn === item().column}>{props.sortDirection === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/>}</Show>
              <Show when={props.layoutKey}>
                <i {...resizerFor(() => item().column)} class="column-resizer column-resizer-right"/>
              </Show>
            </th>
          )}</Index></tr></thead>
          <tbody ref={body}>
          <Show when={padTop() > 0}><tr class="grid-spacer" aria-hidden="true"><td colspan={shown().length + 1} style={{ height: `${padTop()}px` }}/></tr></Show>
          <Index each={visibleRows()}>{(row, offset) => {
            // Windowed rendering keeps the absolute row index authoritative: drafts,
            // selection, the editor and the row number all address rows by it.
            const rowIndex = () => firstRow() + offset
            const meta = () => props.rowMeta[rowIndex()]
            const rowID = () => meta()?.id ?? ''
            return <tr class={`draft-${meta()?.kind ?? 'clean'} ${selected().has(rowID()) ? 'selected' : ''} ${rowIndex() % 2 ? 'even' : ''}`} style={{ '--stagger': String(offset) }} aria-rowindex={virtualized() ? rowIndex() + 2 : undefined}>
              <td class="row-number"><button class="row-selector" disabled={!props.onSelect || (meta()?.kind !== 'insert' && !meta()?.canEdit)} onClick={() => { const current = meta(); if (current) props.onSelect?.(current.id) }}>{selected().has(rowID()) ? <Check size={11}/> : props.rowOffset + rowIndex() + 1}</button></td>
              <Index each={shown()}>{item => {
                const value = () => row()[item().source]
                const text = () => String(value() ?? '')
                const isStatus = () => item().column.toLowerCase() === 'status'
                const json = () => jsonText(value())
                const active = () => { const state = editing(); return state && state.row === rowIndex() && state.column === item().column ? state : null }
                const canEdit = () => props.editable && (meta()?.canEdit ?? true)
                return <td class={canEdit() ? 'editable-cell' : ''} onDblClick={() => { if (canEdit() && props.onUpdate) { cancelBlur = false; setEditing({ row: rowIndex(), column: item().column, text: String(value() ?? ''), original: value() }) } }}>
                  <Show when={active()} fallback={
                    <Show when={json()} fallback={<span class={isStatus() ? `status-pill ${text().toLowerCase()}` : ''}>{formatCell(value())}</span>}>
                      <button class="json-cell" title={JSON.stringify(JSON.parse(json()!))} onClick={() => setJsonCell({ row: rowIndex(), column: item().column, value: value() })}><Code size={13}/><span class="json-preview">{JSON.stringify(JSON.parse(json()!))}</span></button>
                    </Show>
                  }>{state => <input
                    class="cell-editor"
                    ref={el => queueMicrotask(() => el.focus())}
                    disabled={saving()}
                    value={state().text}
                    onInput={event => setEditing(current => current ? { ...current, text: event.currentTarget.value } : current)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') { cancelBlur = true; setEditing(null); event.currentTarget.blur() }
                    }}
                    onBlur={() => {
                      if (cancelBlur) { cancelBlur = false; return }
                      if (!saving()) void commitEdit()
                    }}
                  />}</Show>
                </td>
              }}</Index>
            </tr>
          }}</Index>
          <Show when={padBottom() > 0}><tr class="grid-spacer" aria-hidden="true"><td colspan={shown().length + 1} style={{ height: `${padBottom()}px` }}/></tr></Show>
          </tbody>
        </table>
        <Show when={jsonCell()}>{cell => <JsonModal value={cell().value} editable={props.editable && (props.rowMeta[cell().row]?.canEdit ?? true)} onClose={() => setJsonCell(null)} onSave={props.onUpdate ? async value => { await props.onUpdate!(cell().column, cell().row, value); setJsonCell(null) } : undefined}/>}</Show>
      </div>
    </Show>
  )
}

function JsonModal(props: { value: unknown; editable: boolean; onClose: () => void; onSave?: (value: string) => Promise<void> }) {
  const [text, setText] = createSignal(jsonText(props.value) ?? '')
  const [editing, setEditing] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [invalid, setInvalid] = createSignal('')

  async function save() {
    try {
      const formatted = JSON.stringify(JSON.parse(text()), null, 2)
      setInvalid(''); setSaving(true)
      await props.onSave?.(formatted)
    } catch (error) {
      if (error instanceof SyntaxError) setInvalid(error.message)
    } finally { setSaving(false) }
  }

  return <div class="modal-backdrop json-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}>
    <section class="json-modal" role="dialog" aria-modal="true" aria-label="JSON viewer">
      <header><div><span class="json-braces">{'{}'}</span><span><h3>JSON value</h3><p>{text().length.toLocaleString()} characters</p></span></div><div><button class="secondary" onClick={() => navigator.clipboard?.writeText(text())}><Columns size={14}/> Copy</button><Show when={props.editable}><button class="secondary" onClick={() => setEditing(value => !value)}>{editing() ? 'Preview' : 'Edit JSON'}</button></Show><button class="icon-button" onClick={props.onClose}><X size={17}/></button></div></header>
      <div class={`json-content ${editing() ? 'editing' : ''}`}>{editing() ? <textarea value={text()} onInput={event => { setText(event.currentTarget.value); setInvalid('') }} spellcheck={false} ref={el => queueMicrotask(() => el.focus())}/> : <pre>{syntaxJSON(text())}</pre>}</div>
      <Show when={invalid()}><div class="json-error"><Alert size={14}/>{invalid()}</div></Show>
      <footer><span>{editing() ? 'Changes are validated before saving' : 'Formatted JSON preview'}</span><div><button class="secondary" onClick={props.onClose}>Close</button><Show when={editing()}><button class="primary" disabled={saving()} onClick={save}>{saving() ? 'Saving…' : 'Save JSON'}</button></Show></div></footer>
    </section>
  </div>
}

function syntaxJSON(text: string) {
  const parts = text.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)
  return parts.map(part => {
    let type = ''
    if (/^".*":$/.test(part)) type = 'json-key'
    else if (/^"/.test(part)) type = 'json-string'
    else if (/^(true|false)$/.test(part)) type = 'json-boolean'
    else if (part === 'null') type = 'json-null'
    else if (/^-?\d/.test(part)) type = 'json-number'
    return type ? <span class={type}>{part}</span> : part
  })
}
