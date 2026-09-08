import { createRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { api, databaseApi, isDesktop, windowAction } from './bridge'
import TabStrip from './TabStrip'
import DatabasePicker from './DatabasePicker'
import useSidebarPreferences from './useSidebarPreferences'
import SidebarResizeHandle, { useCompactSidebar, useSidebarWidth, type SidebarSizing } from './SidebarResizeHandle'
import type { AppearancePreferences, ColumnInfo, ConnectionStatus, PostgresConfig, QueryResult, RowOperation, SavedConnection, TableData, TableSummary } from './types'
import { Alert, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Clock, Code, Columns, Command, Database, Eye, File, Filter, Key, More, PanelLeft, Play, Plus, Redo, Refresh, Save, Search, Settings, Table, Trash, Undo, X } from './icons'

const EMPTY_DATA: TableData = { columns: [], rows: [], total: 0, durationMs: 0 }
const PAGE_SIZE = 50
const ROW_COUNT_CONCURRENCY = 3
const tableKey = (item: TableSummary) => `${item.schema}\u0000${item.name}`
type PendingOperation = RowOperation & { id: string }
type GridRowMeta = { id: string; kind: 'clean' | 'update' | 'insert' | 'delete'; canEdit: boolean; primaryKey: Record<string, unknown>; baseIndex?: number }
type DraftHistory = { past: PendingOperation[][]; present: PendingOperation[]; future: PendingOperation[][] }
type WorkspaceSession = ConnectionStatus & {
  connectionState?: 'connecting' | 'failed'
  profile?: SavedConnection
  returnToID?: string
  retryDatabase?: { sourceID: string; database: string }
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
          <th key={column} aria-sort={onSort ? sortColumn === column ? sortDirection === 'asc' ? 'ascending' : 'descending' : 'none' : undefined} onClick={() => onSort?.(column)} draggable={Boolean(layoutKey)} onDragStart={() => setDragging(column)} onDragOver={event => event.preventDefault()} onDrop={() => dropColumn(column)} className={`${onSort ? 'sortable' : ''} ${dragging === column ? 'dragging' : ''}`}>
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

type SavedConnectionsProps = {
  saved: SavedConnection[]
  busy: boolean
  onSaved: (profile: SavedConnection) => void
  onRemove: (id: string) => void
}

function SavedConnections({ saved, busy, onSaved, onRemove }: SavedConnectionsProps) {
  if (!saved.length) return null
  return <section className="saved-connections" aria-label="Saved connections">
    <div className="saved-title"><span>Saved connections</span><em>{saved.length}</em></div>
    <div className="saved-list">{saved.map(profile => <div key={profile.id} className="saved-item">
      <button className="saved-row" onClick={() => onSaved(profile)} disabled={busy}>
        <span className={`kind-logo ${profile.driver === 'PostgreSQL' ? 'postgres' : 'sqlite'}`}>{profile.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span>
        <span><b>{profile.name}</b><small>{profile.driver === 'PostgreSQL' ? `${profile.host}:${profile.port}/${profile.database}` : profile.path}</small></span>
        {profile.hasPassword && <Key size={13}/>}<ChevronRight size={14}/>
      </button>
      <button className="icon-button saved-remove" aria-label={`Delete ${profile.name}`} onClick={() => onRemove(profile.id)} disabled={busy}><X size={13}/></button>
    </div>)}</div>
  </section>
}

const DEFAULT_POSTGRES_CONFIG: PostgresConfig = { id: '', name: 'Local PostgreSQL', host: 'localhost', port: 5432, user: 'postgres', password: '', database: 'postgres', sslMode: 'prefer', readOnly: false, saveConnection: true, savePassword: true }

function configForSaved(profile: SavedConnection): PostgresConfig {
  return { ...DEFAULT_POSTGRES_CONFIG, id: profile.id, name: profile.name, host: profile.host ?? 'localhost', port: profile.port ?? 5432, user: profile.user ?? 'postgres', database: profile.database ?? 'postgres', sslMode: (profile.sslMode as PostgresConfig['sslMode']) ?? 'prefer', readOnly: profile.readOnly, savePassword: profile.hasPassword }
}

function Welcome({ onOpen, onPostgres, onDemo, busy, saved, onSaved, onRemove }: SavedConnectionsProps & { onOpen: () => void; onPostgres: () => void; onDemo: () => void }) {
  return <main className="welcome">
    <div className="welcome-glow" />
    <div className={`welcome-content ${saved.length ? 'has-saved' : ''}`}>
      <div className="welcome-mark"><Database size={34}/></div>
      <p className="eyebrow">DATABASE WORKSPACE</p>
      <h1>Your data, without<br/><span>the noise.</span></h1>
      <p className="welcome-copy">A fast, focused database browser for inspecting schemas, exploring records, and running safe queries.</p>
      <SavedConnections saved={saved} busy={busy} onSaved={onSaved} onRemove={onRemove}/>
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

const FONT_OPTIONS: { value: AppearancePreferences['fontFamily']; label: string; description: string }[] = [
  { value: 'system', label: 'System', description: 'Clean and familiar' },
  { value: 'humanist', label: 'Humanist', description: 'Warm and readable' },
  { value: 'serif', label: 'Serif', description: 'Classic and distinctive' },
  { value: 'mono', label: 'Monospace', description: 'Technical and precise' },
]

function AppearanceModal({ appearance, ready, onChange, onClose }: {
  appearance: AppearancePreferences
  ready: boolean
  onChange: (next: AppearancePreferences) => void
  onClose: () => void
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  const changeSize = (fontSize: number) => onChange({ ...appearance, fontSize })
  return <div className="modal-backdrop appearance-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="appearance-modal" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
      <header>
        <div className="modal-mark"><Settings size={18}/></div>
        <div><h3 id="appearance-title">Appearance</h3><p>Make QueryNest more comfortable to read.</p></div>
        <button className="icon-button" onClick={onClose} aria-label="Close appearance settings"><X size={16}/></button>
      </header>
      <div className="appearance-content">
        <section className="appearance-section">
          <div className="setting-heading"><div><b>Global font size</b><small>Scales text throughout the application.</small></div><output>{appearance.fontSize} px</output></div>
          <div className="font-size-control">
            <button onClick={() => changeSize(appearance.fontSize - 1)} disabled={!ready || appearance.fontSize <= 14} aria-label="Decrease font size">A−</button>
            <input type="range" min="14" max="20" step="1" value={appearance.fontSize} disabled={!ready} aria-label="Global font size" onChange={event => changeSize(Number(event.target.value))}/>
            <button onClick={() => changeSize(appearance.fontSize + 1)} disabled={!ready || appearance.fontSize >= 20} aria-label="Increase font size">A+</button>
          </div>
          <div className="range-labels" aria-hidden="true"><span>Compact</span><span>Large</span></div>
        </section>
        <section className="appearance-section">
          <div className="setting-heading"><div><b>Global font family</b><small>Choose the typeface used by the interface.</small></div></div>
          <div className="font-options" role="radiogroup" aria-label="Global font family">
            {FONT_OPTIONS.map(option => <button key={option.value} role="radio" aria-checked={appearance.fontFamily === option.value} className={appearance.fontFamily === option.value ? 'active' : ''} disabled={!ready} onClick={() => onChange({ ...appearance, fontFamily: option.value })}>
              <span className={`font-sample ${option.value}`}>Aa</span><span><b>{option.label}</b><small>{option.description}</small></span><i/>
            </button>)}
          </div>
        </section>
        <div className="appearance-preview"><span>Preview</span><p>Query your data with clarity.</p><small>SELECT * FROM customers;</small></div>
      </div>
      <footer><button className="secondary" disabled={!ready} onClick={() => onChange({ fontSize: 17, fontFamily: 'system' })}>Reset defaults</button><button className="primary" onClick={onClose}>Done</button></footer>
    </section>
  </div>
}

function TitleBar({ onSettings }: { onSettings: () => void }) {
  return <div className="titlebar" onDoubleClick={() => windowAction('maximise')}>
    <div className="traffic-lights">
      <button aria-label="Close" onClick={() => windowAction('close')}/>
      <button aria-label="Minimise" onClick={() => windowAction('minimise')}/>
      <button aria-label="Maximise" onClick={() => windowAction('maximise')}/>
    </div>
    <div className="drag-title">QueryNest</div>
    <div className="titlebar-actions"><button className="icon-button appearance-trigger" onClick={onSettings} onDoubleClick={event => event.stopPropagation()} aria-label="Appearance settings" title="Appearance settings"><Settings size={15}/></button><div className="build-tag">{isDesktop() ? 'LOCAL' : 'BROWSER PREVIEW'}</div></div>
  </div>
}

export default function App() {
  const compactSidebar = useCompactSidebar()
  const [sessions, setSessions] = useState<WorkspaceSession[]>([])
  const [activeID, setActiveID] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const sidebarPreferences = useSidebarPreferences(setError)
  const databaseSidebar = useSidebarWidth('databases', 76, sidebarPreferences)
  const tableSidebar = useSidebarWidth('tables', compactSidebar ? 214 : 242, sidebarPreferences)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [failedConnection, setFailedConnection] = useState<WorkspaceSession | null>(null)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [connectionConfig, setConnectionConfig] = useState<PostgresConfig>(DEFAULT_POSTGRES_CONFIG)
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([])
  const workspaceRefs = useRef(new Map<string, React.RefObject<WorkspaceHandle | null>>())
  function workspaceRef(id: string) {
    if (!workspaceRefs.current.has(id)) workspaceRefs.current.set(id, createRef<WorkspaceHandle>())
    return workspaceRefs.current.get(id)!
  }

  const loadSavedConnections = useCallback(async () => {
    try { setSavedConnections(await api().ListSavedConnections() ?? []) }
    catch (e) { setError(String(e)) }
  }, [])

  useEffect(() => {
    let cancelled = false
    api().ListDatabaseSessions().then(next => {
      if (cancelled) return
      setSessions(next ?? []); setActiveID(next?.[0]?.id ?? '')
    }).catch(e => { if (!cancelled) setError(String(e)) }).finally(() => { if (!cancelled) setBusy(false) })
    void loadSavedConnections()
    return () => { cancelled = true }
  }, [loadSavedConnections])

  function beforeLeave(run: () => void | Promise<void>) {
    if (busy) return
    const workspace = workspaceRefs.current.get(activeID)?.current
    if (workspace) workspace.beforeLeave(run)
    else void run()
  }

  function newConnection() { beforeLeave(() => { setError(''); setConnectionOpen(true) }) }

  async function connect(open: () => Promise<ConnectionStatus>) {
    setBusy(true); setError('')
    try {
      const next = await open()
      if (!next.connected) return
      setSessions(current => current.some(item => item.id === next.id) ? current : [...current, next])
      setActiveID(next.id); setConnectionOpen(false); setConnectionConfig(DEFAULT_POSTGRES_CONFIG)
      await loadSavedConnections()
    } finally { setBusy(false) }
  }

  function connectFile() { void connect(() => api().ChooseSQLiteSession()).catch(e => setError(String(e))) }
  function connectDemo() { void connect(() => api().OpenDemoSession()).catch(e => setError(String(e))) }

  async function openLazySession(pending: WorkspaceSession, open: () => Promise<ConnectionStatus>, refreshSaved = false) {
    setError(''); setConnectionOpen(false)
    setSessions(current => [...current, pending]); setActiveID(pending.id)
    try {
      const next = await open()
      if (!next.connected) throw new Error('The database did not accept the connection.')
      setSessions(current => current.some(item => item.id === next.id)
        ? current.filter(item => item.id !== pending.id)
        : current.map(item => item.id === pending.id ? next : item))
      setActiveID(current => current === pending.id ? next.id : current)
      if (refreshSaved) await loadSavedConnections()
    }
    catch (e) {
      const message = String(e).replace(/^Error:\s*/i, '')
      const failed = { ...pending, connectionState: 'failed' as const }
      setSessions(current => current.map(item => item.id === pending.id ? failed : item))
      setFailedConnection(failed); setError(message)
    }
  }

  async function openSaved(profile: SavedConnection) {
    if (profile.driver === 'PostgreSQL' && !profile.hasPassword) {
      setConnectionConfig(configForSaved(profile)); setConnectionOpen(true)
      return
    }
    const pending: WorkspaceSession = {
      id: `pending:${profile.id}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      database: profile.database || profile.name,
      connected: false,
      name: profile.name,
      path: profile.driver === 'PostgreSQL' ? `${profile.host}:${profile.port}/${profile.database}` : profile.path ?? '',
      driver: profile.driver,
      readOnly: profile.readOnly,
      connectionState: 'connecting',
      profile,
      returnToID: activeID,
    }
    await openLazySession(pending, () => api().OpenSavedSession(profile.id, ''), true)
  }

  function removeLazySession(session: WorkspaceSession) {
    const fallback = sessions.find(item => item.id === session.returnToID)?.id ?? sessions.filter(item => item.id !== session.id).at(-1)?.id ?? ''
    setSessions(current => current.filter(item => item.id !== session.id))
    setActiveID(current => current === session.id ? fallback : current)
    workspaceRefs.current.delete(session.id)
  }

  function editFailedConnection() {
    if (!failedConnection) return
    if (failedConnection.retryDatabase) {
      const retry = failedConnection.retryDatabase
      removeLazySession(failedConnection)
      setFailedConnection(null); setError('')
      startDatabaseOpen(retry.sourceID, retry.database)
      return
    }
    if (!failedConnection.profile) return
    const profile = failedConnection.profile
    removeLazySession(failedConnection)
    setFailedConnection(null); setError('')
    if (profile.driver === 'PostgreSQL') { setConnectionConfig(configForSaved(profile)); setConnectionOpen(true) }
    else connectFile()
  }

  function closeFailedConnection() {
    if (!failedConnection) return
    removeLazySession(failedConnection)
    setFailedConnection(null); setError('')
  }

  async function removeSaved(id: string) {
    setBusy(true)
    try { await api().DeleteSavedConnection(id); setSavedConnections(current => current.filter(item => item.id !== id)) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  async function closeSession(id: string) {
    setBusy(true)
    try {
      await api().CloseDatabaseSession(id)
      const remaining = sessions.filter(item => item.id !== id)
      setSessions(remaining); setActiveID(remaining.at(-1)?.id ?? '')
      workspaceRefs.current.delete(id)
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  function startDatabaseOpen(id: string, database: string) {
    const source = sessions.find(item => item.id === id)
    if (!source || source.database === database) return
    const path = source.path.includes('/') ? source.path.replace(/\/[^/]*$/, `/${database}`) : `${source.path}/${database}`
    const pending: WorkspaceSession = {
      ...source,
      id: `pending:database:${id}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      database,
      connected: false,
      path,
      connectionState: 'connecting',
      returnToID: activeID,
      retryDatabase: { sourceID: id, database },
    }
    void openLazySession(pending, () => api().OpenDatabase(id, database))
  }

  function openDatabase(id: string, database: string) {
    if (sessions.find(item => item.id === id)?.database === database) return
    beforeLeave(() => startDatabaseOpen(id, database))
  }

  return <div className="app-shell">
    <TitleBar onSettings={() => setAppearanceOpen(true)}/>
    {!sessions.length ? <Welcome onOpen={connectFile} onPostgres={newConnection} onDemo={connectDemo} busy={busy} saved={savedConnections} onSaved={openSaved} onRemove={removeSaved}/> :
      <div className="session-layout" aria-busy={busy}>
        {sessions.length > 1 && <div className="resizable-database-rail" style={{ width: databaseSidebar.width, flexBasis: databaseSidebar.width }}><nav className="database-rail" aria-label="Open databases">{sessions.map(session => <button key={session.id} className={`database-rail-tab ${activeID === session.id ? 'active' : ''} ${session.connectionState ?? ''}`} aria-label={`Switch to ${session.database} (${session.name})`} aria-pressed={activeID === session.id} title={`${session.database} — ${session.name}\n${session.path}`} disabled={busy} onClick={() => { if (session.id !== activeID) beforeLeave(() => setActiveID(session.id)) }}>{session.connectionState === 'connecting' ? <Refresh size={20} className="spin"/> : session.connectionState === 'failed' ? <Alert size={20}/> : <Database size={20}/>}<span>{session.database}</span></button>)}</nav><SidebarResizeHandle label="Resize database sidebar" sizing={databaseSidebar}/></div>}
        <div className="database-panels" inert={busy || connectionOpen || Boolean(failedConnection)}>{sessions.map(session => session.connectionState
          ? <ConnectionSkeleton key={session.id} session={session} active={session.id === activeID} tableSidebar={tableSidebar}/>
          : <DatabaseWorkspace key={session.id} status={session} active={session.id === activeID} blocked={busy || connectionOpen || Boolean(failedConnection)} tableSidebar={tableSidebar} workspaceRef={workspaceRef(session.id)} onNewConnection={newConnection} onCloseSession={() => closeSession(session.id)} onOpenDatabase={database => openDatabase(session.id, database)}/>)}</div>
      </div>}
    {error && <Toast message={error} onClose={() => setError('')}/>}
    {connectionOpen && <ConnectionModal config={connectionConfig} setConfig={setConnectionConfig} saved={savedConnections} busy={busy} onRemove={removeSaved} onSQLite={connectFile} onPostgres={config => connect(() => api().OpenPostgresSession(config))} onSaved={openSaved} onError={setError} onClose={() => setConnectionOpen(false)}/>}
    {failedConnection && <ConnectionFailureModal session={failedConnection} onEdit={editFailedConnection} onClose={closeFailedConnection}/>}
    {appearanceOpen && <AppearanceModal appearance={sidebarPreferences.appearance} ready={sidebarPreferences.ready} onChange={sidebarPreferences.setAppearance} onClose={() => setAppearanceOpen(false)}/>}
  </div>
}

type WorkspaceHandle = { beforeLeave: (run: () => void | Promise<void>) => void }

function ConnectionSkeleton({ session, active, tableSidebar }: { session: WorkspaceSession; active: boolean; tableSidebar: SidebarSizing }) {
  const failed = session.connectionState === 'failed'
  return <div className={`database-workspace connection-skeleton ${failed ? 'failed' : ''}`} hidden={!active} aria-busy={!failed}>
    <div className="workspace">
      <aside className="sidebar" style={{ width: tableSidebar.width, flexBasis: tableSidebar.width }}>
        <div className="brand"><div className="brand-mark"><Database size={18}/></div><span>QueryNest</span></div>
        <div className="connection-card skeleton-connection-card"><span className={`db-avatar ${session.driver === 'PostgreSQL' ? 'postgres' : ''}`}>{session.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span><span className="connection-text"><b>{session.name}</b><small>{failed ? 'Connection failed' : 'Connecting…'}</small></span>{failed ? <Alert size={16}/> : <Refresh size={16} className="spin"/>}</div>
        <div className="skeleton-sidebar-lines" aria-hidden="true"><i/><i/><i/><i/><i/></div>
      </aside>
      <section className="main-panel">
        <div className="top-tabs"><div className="skeleton-block skeleton-tab"/></div>
        <div className="skeleton-main" role="status" aria-live="polite">
          <div className="skeleton-heading"><div className="skeleton-block"/><div className="skeleton-block"/></div>
          <div className="skeleton-toolbar"><div className="skeleton-block"/><div className="skeleton-block"/><div className="skeleton-block"/></div>
          <div className="skeleton-table" aria-hidden="true">{Array.from({ length: 8 }, (_, row) => <div key={row}>{Array.from({ length: 5 }, (_, column) => <i className="skeleton-block" key={column}/>)}</div>)}</div>
          <span className="sr-only">{failed ? `Could not connect to ${session.name}` : `Connecting to ${session.name}`}</span>
        </div>
      </section>
    </div>
  </div>
}

function DatabaseWorkspace({ status, active, blocked, tableSidebar, workspaceRef, onNewConnection, onCloseSession, onOpenDatabase }: {
  status: ConnectionStatus
  active: boolean
  blocked: boolean
  tableSidebar: SidebarSizing
  workspaceRef: React.Ref<WorkspaceHandle>
  onNewConnection: () => void
  onCloseSession: () => Promise<void>
  onOpenDatabase: (database: string) => void
}) {
  const db = useMemo(() => databaseApi(status.id), [status.id])
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
  const [countingTables, setCountingTables] = useState<Set<string>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [queryOpen, setQueryOpen] = useState(false)
  const [query, setQuery] = useState("SELECT status, COUNT(*) AS count\nFROM customers\nGROUP BY status\nORDER BY count DESC;")
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [queryRunning, setQueryRunning] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const [draftsByTable, setDraftsByTable] = useState<Record<string, DraftHistory>>({})
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [guardedAction, setGuardedAction] = useState<{ table: string; tables?: string[]; title: string; message: string; run: () => void | Promise<void> } | null>(null)
  const sidebarSearchRef = useRef<HTMLInputElement>(null)
  const rowCountGenerationRef = useRef(0)
  const activeSummary = tables.find(item => tableKey(item) === activeTable)
  const activeSchema = activeSummary?.schema
  const activeName = activeSummary?.name
  const activeHistory = draftsByTable[activeTable] ?? { past: [], present: [], future: [] }
  const activeOperations = activeHistory.present
  const draftGrid = useMemo(() => buildDraftGrid(data, schema, activeOperations, page), [data, schema, activeOperations, page])

  const loadRowCounts = useCallback((items: TableSummary[]) => {
    const generation = ++rowCountGenerationRef.current
    const pending = [...items]
    setCountingTables(new Set(items.map(tableKey)))

    async function worker() {
      while (pending.length) {
        const item = pending.shift()
        if (!item) return
        const key = tableKey(item)
        try {
          const rows = await db.CountTableRows(item.schema, item.name)
          if (generation !== rowCountGenerationRef.current) return
          setTables(current => current.map(value => tableKey(value) === key ? { ...value, rows } : value))
        } catch { /* A failed count remains unavailable without blocking table browsing. */ }
        finally {
          if (generation === rowCountGenerationRef.current) setCountingTables(current => {
            const next = new Set(current)
            next.delete(key)
            return next
          })
        }
      }
    }

    void Promise.all(Array.from({ length: Math.min(ROW_COUNT_CONCURRENCY, pending.length) }, worker))
  }, [db])

  const loadTables = useCallback(async () => {
    const next = (await db.ListTables() ?? []).map(item => ({ ...item, rows: -1 }))
    setTables(next)
    loadRowCounts(next)
  }, [db, loadRowCounts])

  useEffect(() => {
    let cancelled = false
    db.ListTables().then(next => {
      if (cancelled) return
      const items = (next ?? []).map(item => ({ ...item, rows: -1 }))
      setTables(items)
      loadRowCounts(items)
    }).catch(e => { if (!cancelled) setError(String(e)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; rowCountGenerationRef.current += 1 }
  }, [db, loadRowCounts])

  useEffect(() => {
    if (!activeTable || !activeSchema || !activeName || !status.connected) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const [nextData, nextSchema] = await Promise.all([
          db.GetTableData(activeSchema, activeName, PAGE_SIZE, page * PAGE_SIZE, filter, sortColumn, sortDirection),
          db.GetTableSchema(activeSchema, activeName),
        ])
        if (!cancelled) { setData(nextData); setSchema(nextSchema) }
      } catch (e) { if (!cancelled) setError(String(e)) }
      finally { if (!cancelled) setLoading(false) }
    }, filter ? 250 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeTable, activeSchema, activeName, filter, page, sortColumn, sortDirection, status.connected, db])

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

  function guardWorkspace(title: string, message: string, run: () => void | Promise<void>) {
    if (savingRef.current) return
    const dirty = Object.keys(draftsByTable).filter(key => draftsByTable[key].present.length)
    if (dirty.length) setGuardedAction({ table: dirty[0], tables: dirty, title, message, run })
    else void run()
  }

  useImperativeHandle(workspaceRef, () => ({
    beforeLeave: run => guardWorkspace('Switch database?', 'This database has unsaved changes. Save or discard them before continuing.', run),
  }))

  function disconnect() {
    guardWorkspace('Close database?', 'Unsaved changes in this database will be lost.', onCloseSession)
  }

  async function refreshNow() {
    setLoading(true); setError('')
    try {
      const nextTables = (await db.ListTables() ?? []).map(item => ({ ...item, rows: -1 }))
      const validTables = new Set(nextTables.map(tableKey))
      const remainingTabs = tabs.filter(tab => validTables.has(tab))
      const nextActive = validTables.has(activeTable) ? activeTable : ''

      setTables(nextTables)
      loadRowCounts(nextTables)
      if (nextActive && !remainingTabs.includes(nextActive)) remainingTabs.push(nextActive)
      setTabs(remainingTabs)

      if (!nextActive) {
        setActiveTable(''); setData(EMPTY_DATA); setSchema([])
        return
      }

      const changedTable = nextActive !== activeTable
      if (changedTable) {
        setActiveTable(nextActive); setPage(0); setFilter(''); setSortColumn(''); setView('data'); setQueryOpen(false)
      }
      const selected = nextTables.find(item => tableKey(item) === nextActive)
      if (!selected) return
      const [nextData, nextSchema] = await Promise.all([
        db.GetTableData(selected.schema, selected.name, PAGE_SIZE, changedTable ? 0 : page * PAGE_SIZE, changedTable ? '' : filter, changedTable ? '' : sortColumn, sortDirection),
        db.GetTableSchema(selected.schema, selected.name),
      ])
      setData(nextData); setSchema(nextSchema)
    }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  function refresh() {
    guardWorkspace('Refresh database?', 'Refreshing will reload tables, schemas, and rows that contain unsaved changes.', refreshNow)
  }

  function changeSortNow(column: string) {
    if (sortColumn !== column) { setSortColumn(column); setSortDirection('asc') }
    else if (sortDirection === 'asc') setSortDirection('desc')
    else { setSortColumn(''); setSortDirection('asc') }
    setPage(0)
  }

  function changeSort(column: string) {
    guardUnsaved(activeTable, 'Change sorting?', 'Sorting may replace rows that contain unsaved changes.', () => changeSortNow(column))
  }

  async function executeQuery() {
    setQueryRunning(true); setError('')
    try { setQueryResult(await db.ExecuteQuery(query)) }
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
    if (savingRef.current) throw new Error('A save is already in progress.')
    savingRef.current = true
    setLoading(true); setError('')
    try {
      await db.ApplyChanges(item.schema, item.name, operations.map(({ id: _id, ...operation }) => operation))
      clearDraft(key)
      if (key === activeTable) {
        setData(await db.GetTableData(item.schema, item.name, PAGE_SIZE, page * PAGE_SIZE, filter, sortColumn, sortDirection))
        setSelectedRows(new Set())
      }
      await loadTables()
    } catch (e) { setError(String(e)); throw e }
    finally { savingRef.current = false; setLoading(false) }
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
    if (!active || blocked) return
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTextEditor = target?.matches('input, textarea, [contenteditable="true"]')
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        sidebarSearchRef.current?.focus()
        sidebarSearchRef.current?.select()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!guardedAction && !savingRef.current && (draftsByTable[activeTable]?.present ?? []).length) void saveChanges(activeTable).catch(() => {})
      } else if (!isTextEditor && !guardedAction && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoDraft(activeTable)
        else undoDraft(activeTable)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTable, draftsByTable, tables, data, filter, page, sortColumn, sortDirection, guardedAction, active, blocked, db])

  const filteredTables = useMemo(() => tables.filter(table => table.name.toLowerCase().includes(sidebarFilter.toLowerCase())), [tables, sidebarFilter])
  const tableItems = filteredTables.filter(item => item.type === 'table')
  const viewItems = filteredTables.filter(item => item.type === 'view')
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

  const guardedKeys = guardedAction ? guardedAction.tables ?? [guardedAction.table] : []
  return <div className="database-workspace" hidden={!active}>
    <div className="workspace">
      {sidebarOpen && <aside className="sidebar" style={{ width: tableSidebar.width, flexBasis: tableSidebar.width }}>
        <div className="brand"><div className="brand-mark"><Database size={18}/></div><span>QueryNest</span><button className="icon-button"><More size={17}/></button></div>
        <button className="connection-card" title={status.path} onClick={onNewConnection}>
          <span className={`db-avatar ${status.driver === 'PostgreSQL' ? 'postgres' : ''}`}>{status.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span><span className="connection-text"><b>{status.name}</b><small><i className="online-dot"/> {status.driver} · {status.readOnly ? 'Read-only' : 'Editable'}</small></span><ChevronDown size={15}/>
        </button>
        <div className="side-search"><Search size={14}/><input ref={sidebarSearchRef} aria-label="Filter database objects" value={sidebarFilter} onChange={e => setSidebarFilter(e.target.value)} placeholder="Filter objects"/><span className="search-shortcut" aria-hidden="true"><kbd><Command size={12}/></kbd><kbd>K</kbd></span></div>
        <div className="object-tree">
          <ObjectGroup label="Tables" count={tableItems.length}>{tableItems.map(item => <ObjectRow key={tableKey(item)} item={item} countLoading={countingTables.has(tableKey(item))} active={activeTable === tableKey(item)} onClick={() => openTable(item)}/>)}</ObjectGroup>
          <ObjectGroup label="Views" count={viewItems.length}>{viewItems.map(item => <ObjectRow key={tableKey(item)} item={item} countLoading={countingTables.has(tableKey(item))} active={activeTable === tableKey(item)} onClick={() => openTable(item)}/>)}</ObjectGroup>
        </div>
        <div className="sidebar-footer"><DatabasePicker status={status} onSelect={onOpenDatabase}/><button onClick={refresh} className="icon-button database-refresh" title="Refresh database" aria-label="Refresh database" disabled={loading}><Refresh size={15} className={loading ? 'spin' : ''}/></button><button onClick={disconnect} className="icon-button" title="Close database" aria-label="Close database"><X size={15}/></button></div>
        <SidebarResizeHandle label="Resize table sidebar" sizing={tableSidebar}/>
      </aside>}
      <section className="main-panel">
        <div className="top-tabs">
          <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen(value => !value)} title="Toggle sidebar"><PanelLeft size={17}/></button>
          <TabStrip activeTab={activeTable}>{tabs.map(tab => { const item = tables.find(value => tableKey(value) === tab); const changes = draftsByTable[tab]?.present.length ?? 0; return item ? <button key={tab} data-active={activeTable === tab} title={`${item.schema}.${item.name}`} onClick={() => setActiveTable(tab)} className={`tab ${activeTable === tab ? 'active' : ''} ${changes ? 'changed' : ''}`}><Table size={14}/><b className="tab-label">{item.name}</b>{changes > 0 && <i className="tab-change-dot" title={`${changes} pending change(s)`}/>}<span onClick={e => { e.stopPropagation(); closeTab(tab) }}><X size={13}/></span></button> : null })}</TabStrip>
          <button className={`query-tab ${queryOpen ? 'active' : ''}`} onClick={() => setQueryOpen(value => !value)}><Code size={15}/> SQL</button>
          <button className="icon-button" onClick={onNewConnection}><Plus size={17}/></button>
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

    {guardedAction && <UnsavedModal title={guardedAction.title} message={guardedAction.message} count={guardedKeys.reduce((count, key) => count + (draftsByTable[key]?.present.length ?? 0), 0)} onCancel={() => setGuardedAction(null)} onDiscard={async () => { const action = guardedAction; guardedKeys.forEach(discardChanges); setGuardedAction(null); await action.run() }} onSave={async () => { const action = guardedAction; try { for (const key of guardedKeys) await saveChanges(key); setGuardedAction(null); await action.run() } catch { /* Keep dialog open when save fails. */ } }}/>}
  </div>
}

function ObjectGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return <div className={`object-group ${open ? 'open' : ''}`}><button className="group-title" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<span>{label}</span><em>{count}</em></button>{open && <div className="object-children">{children}</div>}</div>
}

function ObjectRow({ item, active, countLoading, onClick }: { item: TableSummary; active: boolean; countLoading: boolean; onClick: () => void }) {
  return <button title={`${item.schema}.${item.name}`} className={`object-row ${active ? 'active' : ''}`} onClick={onClick}>{item.type === 'view' ? <Eye size={14}/> : <Table size={14}/>}<span>{item.name}</span><small>{countLoading ? <i className="row-count-skeleton" aria-label="Loading row count"/> : item.rows >= 0 ? item.rows.toLocaleString() : '—'}</small></button>
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

function ConnectionFailureModal({ session, onEdit, onClose }: { session: WorkspaceSession; onEdit: () => void; onClose: () => void }) {
  const switchingDatabase = Boolean(session.retryDatabase)
  return <div className="modal-backdrop connection-failure-backdrop">
    <section className="connection-failure-modal" role="alertdialog" aria-modal="true" aria-labelledby="connection-failure-title" aria-describedby="connection-failure-copy">
      <div className="connection-failure-icon"><Alert size={23}/></div>
      <h3 id="connection-failure-title">Connection failed</h3>
      <p id="connection-failure-copy">QueryNest couldn’t open <b>{switchingDatabase ? session.database : session.name}</b>. {switchingDatabase ? 'Try opening this database again, or close this workspace.' : 'Edit its connection details and try again, or close this workspace.'}</p>
      <div className="failed-connection-summary"><span className={`kind-logo ${session.driver === 'PostgreSQL' ? 'postgres' : 'sqlite'}`}>{session.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span><span><b>{session.name}</b><small>{session.path}</small></span></div>
      <footer><button className="secondary" onClick={onClose}>Close connection</button><button className="primary" onClick={onEdit}>{switchingDatabase ? <Refresh size={15}/> : <Settings size={15}/>} {switchingDatabase ? 'Try again' : 'Edit connection'}</button></footer>
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

const SSL_MODE_OPTIONS: { value: PostgresConfig['sslMode']; label: string; description: string }[] = [
  { value: 'prefer', label: 'Prefer', description: 'Use SSL when available' },
  { value: 'require', label: 'Require', description: 'Require an encrypted connection' },
  { value: 'verify-ca', label: 'Verify CA', description: 'Verify the certificate authority' },
  { value: 'verify-full', label: 'Verify full', description: 'Verify CA and hostname' },
  { value: 'disable', label: 'Disable', description: 'Connect without SSL' },
  { value: 'allow', label: 'Allow', description: 'Try without SSL first' },
]

function CustomSelect({ value, options, disabled, label, onChange }: {
  value: string
  options: { value: string; label: string; description?: string }[]
  disabled?: boolean
  label: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selected = options.find(option => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    document.addEventListener('mousedown', closeOutside)
    window.addEventListener('keydown', closeWithEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); window.removeEventListener('keydown', closeWithEscape) }
  }, [open])

  function moveFocus(event: React.KeyboardEvent<HTMLButtonElement>, direction: number) {
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const index = items.indexOf(event.currentTarget)
    items[(index + direction + items.length) % items.length]?.focus()
  }

  return <div ref={rootRef} className={`custom-select ${open ? 'open' : ''}`}>
    <button ref={triggerRef} type="button" className="custom-select-trigger" disabled={disabled} aria-label={`${label}: ${selected?.label ?? value}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus()) }
    }}><span>{selected?.label}</span><ChevronDown size={14}/></button>
    {open && <div className="custom-select-menu" role="listbox" aria-label={label}>
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); triggerRef.current?.focus() }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(event, 1) }
        if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(event, -1) }
      }}><span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Check size={14}/>}</button>)}
    </div>}
  </div>
}

function ConnectionModal({ config, setConfig, saved, busy, onRemove, onSQLite, onPostgres, onSaved, onError, onClose }: SavedConnectionsProps & { config: PostgresConfig; setConfig: React.Dispatch<React.SetStateAction<PostgresConfig>>; onSQLite: () => void; onPostgres: (config: PostgresConfig) => Promise<void>; onError: (message: string) => void; onClose: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [success, setSuccess] = useState('')
  const pending = busy || submitting || testing
  const update = <K extends keyof PostgresConfig>(key: K, value: PostgresConfig[K]) => setConfig(current => ({ ...current, [key]: value }))

  useEffect(() => { setSuccess('') }, [config])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const isTest = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'test'
    setSuccess('')
    if (isTest) setTesting(true)
    else setSubmitting(true)
    try {
      if (isTest) {
        await api().TestPostgresConnection(config)
        setSuccess('Connection successful. Ready to connect.')
      } else await onPostgres(config)
    } catch (e) { onError(String(e).replace(/^Error:\s*/i, '')) }
    finally { setSubmitting(false); setTesting(false) }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose() }}>
    <section className="connection-modal" role="dialog" aria-modal="true" aria-label="New database connection">
      <header><div className="modal-mark"><Database size={19}/></div><div><h3>New connection</h3><p>Connect securely to your database</p></div><button className="icon-button" aria-label="Close connection form" disabled={pending} onClick={onClose}><X size={17}/></button></header>
      <SavedConnections saved={saved} busy={pending} onSaved={onSaved} onRemove={onRemove}/>
      <div className="connection-kinds">
        <button className="kind-card" onClick={onSQLite} disabled={pending}><span className="kind-logo sqlite">SQ</span><span><b>SQLite</b><small>Open a local database file</small></span><ChevronRight size={15}/></button>
        <div className="kind-card active"><span className="kind-logo postgres">PG</span><span><b>PostgreSQL</b><small>Host and credentials</small></span><Check size={15}/></div>
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={pending}>
        <div className="form-grid">
          <label className="span-2"><span>Connection name</span><input required value={config.name} onChange={e => update('name', e.target.value)} placeholder="Production database"/></label>
          <label className="span-2"><span>Host</span><input required value={config.host} onChange={e => update('host', e.target.value)} placeholder="localhost" autoFocus/></label>
          <label><span>Port</span><input required type="number" min={1} max={65535} value={config.port} onChange={e => update('port', Number(e.target.value))}/></label>
          <div className="form-field"><span>SSL mode</span><CustomSelect label="SSL mode" value={config.sslMode} options={SSL_MODE_OPTIONS} disabled={pending} onChange={value => update('sslMode', value as PostgresConfig['sslMode'])}/></div>
          <label className="span-2"><span>Database</span><input required value={config.database} onChange={e => update('database', e.target.value)} placeholder="postgres"/></label>
          <label><span>User</span><input required value={config.user} onChange={e => update('user', e.target.value)} placeholder="postgres" autoComplete="username"/></label>
          <label><span>Password</span><input type="password" value={config.password} onChange={e => update('password', e.target.value)} placeholder="Optional" autoComplete="current-password"/></label>
        </div>
        <div className="connection-options"><label><input type="checkbox" checked={config.saveConnection} onChange={e => update('saveConnection', e.target.checked)}/><span>Save connection</span></label><label className={!config.saveConnection ? 'disabled' : ''}><input type="checkbox" checked={config.savePassword} disabled={!config.saveConnection} onChange={e => update('savePassword', e.target.checked)}/><span>Save password securely</span></label><label><input type="checkbox" checked={config.readOnly} onChange={e => update('readOnly', e.target.checked)}/><span>Read-only</span></label></div>
        </fieldset>
        {success && <div className="connection-feedback success" role="status"><Check size={15}/><span>{success}</span></div>}
        <footer><button type="button" className="secondary" onClick={onClose} disabled={pending}>Cancel</button><button type="submit" name="action" value="connect" className="primary" disabled={pending}>{submitting ? <Refresh size={15} className="spin"/> : <Database size={15}/>} {submitting ? 'Connecting…' : 'Connect'}</button><button type="submit" name="action" value="test" className="secondary test-connection" disabled={pending}>{testing ? <Refresh size={15} className="spin"/> : <Play size={15}/>} {testing ? 'Testing…' : 'Test connection'}</button></footer>
      </form>
    </section>
  </div>
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  const clean = message.replace(/^Error:\s*/i, '')
  useEffect(() => {
    const timer = window.setTimeout(onClose, 12000)
    return () => window.clearTimeout(timer)
  }, [clean, onClose])
  return <div className="toast" role="alert"><Alert size={17}/><span title={clean}>{clean}</span><button onClick={onClose} aria-label="Dismiss error"><X size={14}/></button></div>
}
