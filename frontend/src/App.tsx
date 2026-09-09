import { batch, createEffect, createMemo, createSignal, createUniqueId, For, Index, on, onCleanup, onMount, Show, type JSX, type Setter } from 'solid-js'
import { createStore, produce, unwrap } from 'solid-js/store'
import { api, databaseApi, isDesktop, windowAction } from './bridge'
import TabStrip from './TabStrip'
import DatabasePicker from './DatabasePicker'
import DataGrid, { buildDraftGrid, type PendingOperation } from './DataGrid'
import SqlEditor from './SqlEditor'
import type { CompletionTable, SqlStatement } from './sql'
import useSidebarPreferences, { UNDO_HISTORY_RANGE } from './useSidebarPreferences'
import SidebarResizeHandle, { useCompactSidebar, useSidebarWidth, type SidebarSizing } from './SidebarResizeHandle'
import type { AppearancePreferences, ColumnInfo, ConnectionStatus, EditingPreferences, IndexInfo, PostgresConfig, QueryResult, SavedConnection, SavedConnectionUpdate, ScriptFile, TableData, TableRef, TableSummary, TransferPreferences, TransferPreview, TransferResult } from './types'
import { Alert, Check, ChevronDown, ChevronRight, Clock, Code, Columns, Command, Copy, Database, Edit, Eye, File, Filter, Key, More, PanelLeft, Pin, Play, Plus, Redo, Refresh, Save, Search, Settings, Table, Trash, Undo, X } from './icons'

const emptyData = (): TableData => ({ columns: [], rows: [], total: 0, durationMs: 0 })
const PAGE_SIZE = 50
const ROW_COUNT_CONCURRENCY = 3
const QUICK_PAGE_ITEM_WIDTH = 70
const MAX_NAVIGABLE_PAGES = 99_999
const qualifiedKey = (schema: string, name: string) => `${schema}\u0000${name}`
const tableKey = (item: TableSummary) => qualifiedKey(item.schema, item.name)
type DraftHistory = { past: PendingOperation[][]; present: PendingOperation[]; future: PendingOperation[][] }
type ContextMenuState = { kind: 'database' | 'table' | 'tab' | 'script'; key: string; x: number; y: number }
type ContextMenuAction = { label: string; icon: JSX.Element; run: () => void; danger?: boolean; separator?: boolean }
type MouseEventOn<T extends Element> = MouseEvent & { currentTarget: T }
type WorkspaceSession = ConnectionStatus & {
  connectionState?: 'connecting' | 'failed'
  profile?: SavedConnection
  returnToID?: string
  retryDatabase?: { sourceID: string; database: string }
}

type TableTabState = {
  data: TableData
  schema: ColumnInfo[]
  indexes: IndexInfo[]
  view: 'data' | 'structure'
  filter: string
  page: number
  sortColumn: string
  sortDirection: 'asc' | 'desc'
  loading: boolean
  selectedRows: Set<string>
  loadedRequest: string
  schemaLoaded: boolean
  indexesLoaded: boolean
  loadError: string
  structureError: string
}

const newTableTabState = (): TableTabState => ({
  data: emptyData(),
  schema: [],
  indexes: [],
  view: 'data',
  filter: '',
  page: 0,
  sortColumn: '',
  sortDirection: 'asc',
  loading: true,
  selectedRows: new Set(),
  loadedRequest: '',
  schemaLoaded: false,
  indexesLoaded: false,
  loadError: '',
  structureError: '',
})

const tableRequestKey = (state: Pick<TableTabState, 'page' | 'filter' | 'sortColumn' | 'sortDirection'>) => JSON.stringify([state.page, state.filter, state.sortColumn, state.sortDirection])

function tableLoadError(error: unknown) {
  const message = String(error)
  const missingModule = message.match(/no such module:\s*([^\s(]+)/i)?.[1]
  if (missingModule) return `This virtual table requires the SQLite module ${missingModule}, which is not available in this build.`
  return message
}

function QuickPagePicker(props: { currentPage: number; totalPages: number; onSelect: (page: number) => void }) {
  const [open, setOpen] = createSignal(false)
  let root!: HTMLDivElement

  createEffect(() => {
    if (!open()) return
    const close = (event: PointerEvent) => { if (!root?.contains(event.target as Node)) setOpen(false) }
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false) } }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keyboard)
    onCleanup(() => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', keyboard)
    })
  })

  return <div ref={root} class="quick-page-picker">
    <button class="quick-page-trigger" aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(value => !value)}>Page {props.currentPage} of {props.totalPages}</button>
    <Show when={open()}>
      <QuickPagePopover currentPage={props.currentPage} totalPages={props.totalPages} onClose={() => setOpen(false)} onSelect={page => { setOpen(false); if (page !== props.currentPage) props.onSelect(page) }}/>
    </Show>
  </div>
}

function QuickPagePopover(props: { currentPage: number; totalPages: number; onClose: () => void; onSelect: (page: number) => void }) {
  // The virtual geometry is fixed for the lifetime of an open popover.
  const totalPages = props.totalPages
  const visibleCount = Math.min(5, totalPages)
  const [value, setValue] = createSignal(String(props.currentPage))
  const [message, setMessage] = createSignal('')
  const maxStart = Math.max(0, totalPages - visibleCount)
  const initialStart = Math.min(maxStart, Math.max(0, props.currentPage - 1 - Math.floor(visibleCount / 2)))
  const [windowStart, setWindowStart] = createSignal(initialStart)
  let input!: HTMLInputElement
  let scroller!: HTMLDivElement
  const inputID = createUniqueId()
  const viewportWidth = visibleCount * QUICK_PAGE_ITEM_WIDTH
  const virtualWidth = totalPages * QUICK_PAGE_ITEM_WIDTH
  const maxScroll = Math.max(0, virtualWidth - viewportWidth)
  const scrollForStart = (start: number) => maxStart ? start / maxStart * maxScroll : 0

  onMount(() => {
    input?.focus()
    input?.select()
    if (scroller) scroller.scrollLeft = scrollForStart(initialStart)
  })

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const page = Number(value())
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      setMessage(`Enter a whole number from 1 to ${totalPages.toLocaleString()}.`)
      input?.select()
      return
    }
    props.onSelect(page)
  }

  function moveWindow(next: number) {
    const start = Math.min(maxStart, Math.max(0, next))
    setWindowStart(start)
    if (scroller) scroller.scrollLeft = scrollForStart(start)
  }

  const renderedStart = () => Math.max(0, windowStart() - 1)
  const renderedEnd = () => Math.min(totalPages, windowStart() + visibleCount + 1)
  const renderedCount = () => renderedEnd() - renderedStart()
  const itemsOffset = () => Math.min(
    virtualWidth - renderedCount() * QUICK_PAGE_ITEM_WIDTH,
    Math.max(0, scrollForStart(windowStart()) - (windowStart() - renderedStart()) * QUICK_PAGE_ITEM_WIDTH),
  )
  const pages = () => Array.from({ length: renderedCount() }, (_, index) => renderedStart() + index + 1)
  return <section class="quick-page-popover" role="dialog" aria-label="Go to page">
    <header><div><b>Go to page</b><span>{totalPages.toLocaleString()} pages available</span></div><button class="icon-button" onClick={props.onClose} aria-label="Close page picker"><X size={14}/></button></header>
    <form onSubmit={submit}>
      <label for={inputID}>Page number</label>
      <div class="quick-page-input"><input ref={input} id={inputID} inputmode="numeric" autocomplete="off" autocorrect="off" spellcheck={false} value={value()} aria-invalid={Boolean(message())} onInput={event => { setValue(event.currentTarget.value); setMessage('') }}/><button class="primary" type="submit">Go</button></div>
      <Show when={message()}><p class="quick-page-error" role="alert">{message()}</p></Show>
    </form>
    <div class="quick-page-heading"><span>Pages</span><small>Page 1 — {totalPages.toLocaleString()}</small></div>
    <div
      ref={scroller}
      class="quick-page-window"
      style={{ width: `${viewportWidth}px` }}
      tabIndex={maxStart ? 0 : -1}
      aria-label="Nearby pages"
      onScroll={event => {
        if (!maxScroll) return
        setWindowStart(Math.min(maxStart, Math.max(0, Math.round(event.currentTarget.scrollLeft / maxScroll * maxStart))))
      }}
      onWheel={event => {
        if (!maxStart) return
        event.preventDefault()
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
        moveWindow(windowStart() + Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 40)))
      }}
      onKeyDown={event => {
        const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!maxStart || !direction) return
        event.preventDefault()
        moveWindow(windowStart() + direction)
      }}
    >
      <div class="quick-page-track" style={{ width: `${virtualWidth}px` }}><div class="quick-page-items" style={{ transform: `translateX(${itemsOffset()}px)` }}><Index each={pages()}>{page =>
        <span class="quick-page-cell"><button type="button" title={`Page ${page().toLocaleString()}`} class={page() === props.currentPage ? 'active' : ''} aria-current={page() === props.currentPage ? 'page' : undefined} onClick={() => props.onSelect(page())}>{page().toLocaleString()}</button></span>
      }</Index></div></div>
    </div>
  </section>
}

type SavedConnectionsProps = {
  saved: SavedConnection[]
  busy: boolean
  onSaved: (profile: SavedConnection) => void
  onEdit: (profile: SavedConnection) => void
  onRemove: (id: string) => void
}

function SavedConnections(props: SavedConnectionsProps) {
  return <Show when={props.saved.length}><section class="saved-connections" aria-label="Saved connections">
    <div class="saved-title"><span>Saved connections</span><em>{props.saved.length}</em></div>
    <div class="saved-list"><For each={props.saved}>{profile => <div class="saved-item">
      <button class="saved-row" onClick={() => props.onSaved(profile)} disabled={props.busy}>
        <span class={`kind-logo ${profile.driver === 'PostgreSQL' ? 'postgres' : 'sqlite'}`}>{profile.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span>
        <span><b>{profile.name}</b><small>{profile.driver === 'PostgreSQL' ? `${profile.host}:${profile.port}/${profile.database}` : profile.path}</small></span>
        <Show when={profile.hasPassword}><Key size={13}/></Show><ChevronRight size={14}/>
      </button>
      <button class="icon-button saved-edit" aria-label={`Edit ${profile.name}`} title="Edit connection" onClick={() => props.onEdit(profile)} disabled={props.busy}><Edit size={13}/></button>
      <button class="icon-button saved-remove" aria-label={`Delete ${profile.name}`} onClick={() => props.onRemove(profile.id)} disabled={props.busy}><X size={13}/></button>
    </div>}</For></div>
  </section></Show>
}

const DEFAULT_POSTGRES_CONFIG: PostgresConfig = { id: '', name: 'Local PostgreSQL', host: 'localhost', port: 5432, user: 'postgres', password: '', database: 'postgres', sslMode: 'prefer', readOnly: false, saveConnection: true, savePassword: true }

function configForSaved(profile: SavedConnection): PostgresConfig {
  return { ...DEFAULT_POSTGRES_CONFIG, id: profile.id, name: profile.name, host: profile.host ?? 'localhost', port: profile.port ?? 5432, user: profile.user ?? 'postgres', database: profile.database ?? 'postgres', sslMode: (profile.sslMode as PostgresConfig['sslMode']) ?? 'prefer', readOnly: profile.readOnly, savePassword: profile.hasPassword }
}

function Welcome(props: SavedConnectionsProps & { onOpen: () => void; onPostgres: () => void; onDemo: () => void }) {
  return <main class="welcome">
    <div class="welcome-glow" />
    <div class={`welcome-content ${props.saved.length ? 'has-saved' : ''}`}>
      <div class="welcome-mark"><Database size={34}/></div>
      <p class="eyebrow">DATABASE WORKSPACE</p>
      <h1>Your data, without<br/><span>the noise.</span></h1>
      <p class="welcome-copy">A fast, focused database browser for inspecting schemas, exploring records, and running safe queries.</p>
      <SavedConnections saved={props.saved} busy={props.busy} onSaved={props.onSaved} onEdit={props.onEdit} onRemove={props.onRemove}/>
      <div class="welcome-actions">
        <button class="primary large" onClick={props.onOpen} disabled={props.busy}><File size={17}/> Open SQLite database</button>
        <button class="secondary large postgres-button" onClick={props.onPostgres} disabled={props.busy}><Database size={16}/> Connect PostgreSQL</button>
      </div>
      <button class="demo-link" onClick={props.onDemo} disabled={props.busy}><Play size={13}/> Explore with demo data</button>
      <div class="welcome-features">
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

function AppearanceModal(props: {
  appearance: AppearancePreferences
  transfer: TransferPreferences
  editing: EditingPreferences
  ready: boolean
  onChange: (next: AppearancePreferences) => void
  onTransferChange: (next: TransferPreferences) => void
  onEditingChange: (next: EditingPreferences) => void
  onClose: () => void
}) {
  onMount(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', close)
    onCleanup(() => window.removeEventListener('keydown', close))
  })

  const changeSize = (fontSize: number) => props.onChange({ ...props.appearance, fontSize })
  return <div class="modal-backdrop appearance-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}>
    <section class="appearance-modal" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
      <header>
        <div class="modal-mark"><Settings size={18}/></div>
        <div><h3 id="appearance-title">Settings</h3><p>Appearance and data operation preferences.</p></div>
        <button class="icon-button" onClick={props.onClose} aria-label="Close appearance settings"><X size={16}/></button>
      </header>
      <div class="appearance-content">
        <section class="appearance-section">
          <div class="setting-heading"><div><b>Global font size</b><small>Scales text throughout the application.</small></div><output>{props.appearance.fontSize} px</output></div>
          <div class="font-size-control">
            <button onClick={() => changeSize(props.appearance.fontSize - 1)} disabled={!props.ready || props.appearance.fontSize <= 14} aria-label="Decrease font size">A−</button>
            <input type="range" min="14" max="20" step="1" value={props.appearance.fontSize} disabled={!props.ready} aria-label="Global font size" onInput={event => changeSize(Number(event.currentTarget.value))}/>
            <button onClick={() => changeSize(props.appearance.fontSize + 1)} disabled={!props.ready || props.appearance.fontSize >= 20} aria-label="Increase font size">A+</button>
          </div>
          <div class="range-labels" aria-hidden="true"><span>Compact</span><span>Large</span></div>
        </section>
        <section class="appearance-section">
          <div class="setting-heading"><div><b>Backup batch size</b><small>Flushes streamed backup data and writes a recovery checkpoint at this interval.</small></div><output>{props.transfer.backupBatchSizeMB.toLocaleString()} MB</output></div>
          <label class="batch-size-control"><input type="number" min="1" max="10240" step="1" value={props.transfer.backupBatchSizeMB} disabled={!props.ready} onInput={event => props.onTransferChange({ backupBatchSizeMB: Number(event.currentTarget.value) || 1 })}/><span>MB</span></label>
          <div class="batch-size-hint">The default is 500 MB. Data is streamed continuously and is not buffered to this size in memory.</div>
        </section>
        <section class="appearance-section">
          <div class="setting-heading"><div><b>Undo history limit</b><small>How many draft changes each table tab can step back through.</small></div><output>{props.editing.undoHistoryLimit.toLocaleString()} changes</output></div>
          <label class="batch-size-control"><input type="number" min={UNDO_HISTORY_RANGE.min} max={UNDO_HISTORY_RANGE.max} step="1" value={props.editing.undoHistoryLimit} disabled={!props.ready} aria-label="Undo history limit" onInput={event => props.onEditingChange({ undoHistoryLimit: Number(event.currentTarget.value) || UNDO_HISTORY_RANGE.min })}/><span>changes</span></label>
          <div class="batch-size-hint">The default is 100. Each step keeps a snapshot of that tab's pending changes, so a lower limit releases memory sooner.</div>
        </section>
        <section class="appearance-section">
          <div class="setting-heading"><div><b>Global font family</b><small>Choose the typeface used by the interface.</small></div></div>
          <div class="font-options" role="radiogroup" aria-label="Global font family">
            <For each={FONT_OPTIONS}>{option => <button role="radio" aria-checked={props.appearance.fontFamily === option.value} class={props.appearance.fontFamily === option.value ? 'active' : ''} disabled={!props.ready} onClick={() => props.onChange({ ...props.appearance, fontFamily: option.value })}>
              <span class={`font-sample ${option.value}`}>Aa</span><span><b>{option.label}</b><small>{option.description}</small></span><i/>
            </button>}</For>
          </div>
        </section>
        <div class="appearance-preview"><span>Preview</span><p>Query your data with clarity.</p><small>SELECT * FROM customers;</small></div>
      </div>
      <footer><button class="secondary" disabled={!props.ready} onClick={() => props.onChange({ fontSize: 17, fontFamily: 'system' })}>Reset defaults</button><button class="primary" onClick={props.onClose}>Done</button></footer>
    </section>
  </div>
}

function TitleBar(props: { onSettings: () => void }) {
  return <div class="titlebar" onDblClick={() => windowAction('maximise')}>
    <div class="traffic-lights">
      <button aria-label="Close" onClick={() => windowAction('close')}/>
      <button aria-label="Minimise" onClick={() => windowAction('minimise')}/>
      <button aria-label="Maximise" onClick={() => windowAction('maximise')}/>
    </div>
    <div class="drag-title">QueryNest</div>
    <div class="titlebar-actions"><button class="icon-button appearance-trigger" onClick={props.onSettings} onDblClick={event => event.stopPropagation()} aria-label="Appearance settings" title="Appearance settings"><Settings size={15}/></button><div class="build-tag">{isDesktop() ? 'LOCAL' : 'BROWSER PREVIEW'}</div></div>
  </div>
}

export default function App() {
  const compactSidebar = useCompactSidebar()
  const [sessions, setSessions] = createSignal<WorkspaceSession[]>([])
  const [activeID, setActiveID] = createSignal('')
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal('')
  const sidebarPreferences = useSidebarPreferences(setError)
  const databaseSidebar = useSidebarWidth('databases', () => 76, sidebarPreferences)
  const tableSidebar = useSidebarWidth('tables', () => compactSidebar() ? 214 : 242, sidebarPreferences)
  const [connectionOpen, setConnectionOpen] = createSignal(false)
  const [editingConnection, setEditingConnection] = createSignal<SavedConnection | null>(null)
  const [failedConnection, setFailedConnection] = createSignal<WorkspaceSession | null>(null)
  const [appearanceOpen, setAppearanceOpen] = createSignal(false)
  const [connectionConfig, setConnectionConfig] = createSignal<PostgresConfig>(DEFAULT_POSTGRES_CONFIG)
  const [savedConnections, setSavedConnections] = createSignal<SavedConnection[]>([])
  const workspaces = new Map<string, WorkspaceHandle>()

  const loadSavedConnections = async () => {
    try { setSavedConnections(await api().ListSavedConnections() ?? []) }
    catch (e) { setError(String(e)) }
  }

  onMount(() => {
    let cancelled = false
    onCleanup(() => { cancelled = true })
    api().ListDatabaseSessions().then(next => {
      if (cancelled) return
      setSessions(next ?? []); setActiveID(next?.[0]?.id ?? '')
    }).catch(e => { if (!cancelled) setError(String(e)) }).finally(() => { if (!cancelled) setBusy(false) })
    void loadSavedConnections()
  })

  const blocked = () => busy() || connectionOpen() || Boolean(editingConnection()) || Boolean(failedConnection())

  function beforeLeave(run: () => void | Promise<void>) {
    if (busy()) return
    const workspace = workspaces.get(activeID())
    if (workspace) workspace.beforeLeave(run)
    else void run()
  }

  function newConnection() { beforeLeave(() => { setError(''); setConnectionConfig(DEFAULT_POSTGRES_CONFIG); setConnectionOpen(true) }) }

  function editSaved(profile: SavedConnection) {
    setConnectionOpen(false)
    setError('')
    setEditingConnection(profile)
  }

  async function saveEditedConnection(profile: SavedConnectionUpdate) {
    setBusy(true); setError('')
    try {
      await api().UpdateSavedConnection(profile)
      await loadSavedConnections()
      setEditingConnection(null)
    } catch (e) {
      setError(String(e))
      throw e
    } finally { setBusy(false) }
  }

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
      returnToID: activeID(),
    }
    await openLazySession(pending, () => api().OpenSavedSession(profile.id, ''), true)
  }

  function removeLazySession(session: WorkspaceSession) {
    const current = sessions()
    const fallback = current.find(item => item.id === session.returnToID)?.id ?? current.filter(item => item.id !== session.id).at(-1)?.id ?? ''
    setSessions(list => list.filter(item => item.id !== session.id))
    setActiveID(value => value === session.id ? fallback : value)
    workspaces.delete(session.id)
  }

  function editFailedConnection() {
    const failed = failedConnection()
    if (!failed) return
    if (failed.retryDatabase) {
      const retry = failed.retryDatabase
      removeLazySession(failed)
      setFailedConnection(null); setError('')
      startDatabaseOpen(retry.sourceID, retry.database)
      return
    }
    if (!failed.profile) return
    const profile = failed.profile
    removeLazySession(failed)
    setFailedConnection(null); setError('')
    if (profile.driver === 'PostgreSQL') { setConnectionConfig(configForSaved(profile)); setConnectionOpen(true) }
    else connectFile()
  }

  function closeFailedConnection() {
    const failed = failedConnection()
    if (!failed) return
    removeLazySession(failed)
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
      const remaining = sessions().filter(item => item.id !== id)
      setSessions(remaining); setActiveID(remaining.at(-1)?.id ?? '')
      workspaces.delete(id)
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  function startDatabaseOpen(id: string, database: string) {
    const source = sessions().find(item => item.id === id)
    if (!source || source.database === database) return
    const path = source.path.includes('/') ? source.path.replace(/\/[^/]*$/, `/${database}`) : `${source.path}/${database}`
    const pending: WorkspaceSession = {
      ...source,
      id: `pending:database:${id}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      database,
      connected: false,
      path,
      connectionState: 'connecting',
      returnToID: activeID(),
      retryDatabase: { sourceID: id, database },
    }
    void openLazySession(pending, () => api().OpenDatabase(id, database))
  }

  function openDatabase(id: string, database: string) {
    if (sessions().find(item => item.id === id)?.database === database) return
    beforeLeave(() => startDatabaseOpen(id, database))
  }

  return <div class="app-shell">
    <TitleBar onSettings={() => setAppearanceOpen(true)}/>
    <Show when={sessions().length} fallback={<Welcome onOpen={connectFile} onPostgres={newConnection} onDemo={connectDemo} busy={busy()} saved={savedConnections()} onSaved={openSaved} onEdit={editSaved} onRemove={removeSaved}/>}>
      <div class="session-layout" aria-busy={busy()}>
        <Show when={sessions().length > 1}>
          <div class="resizable-database-rail" style={{ width: `${databaseSidebar.width()}px`, 'flex-basis': `${databaseSidebar.width()}px` }}>
            <nav class="database-rail" aria-label="Open databases"><For each={sessions()}>{session =>
              <button class={`database-rail-tab ${activeID() === session.id ? 'active' : ''} ${session.connectionState ?? ''}`} aria-label={`Switch to ${session.database} (${session.name})`} aria-pressed={activeID() === session.id} title={`${session.database} — ${session.name}\n${session.path}`} disabled={busy()} onClick={() => { if (session.id !== activeID()) beforeLeave(() => { setActiveID(session.id) }) }}>
                {session.connectionState === 'connecting' ? <Refresh size={20} class="spin"/> : session.connectionState === 'failed' ? <Alert size={20}/> : <Database size={20}/>}<span>{session.database}</span>
              </button>
            }</For></nav>
            <SidebarResizeHandle label="Resize database sidebar" sizing={databaseSidebar}/>
          </div>
        </Show>
        <div class="database-panels" inert={blocked()}><For each={sessions()}>{session =>
          <Show when={!session.connectionState} fallback={<ConnectionSkeleton session={session} active={session.id === activeID()} tableSidebar={tableSidebar}/>}>
            <DatabaseWorkspace status={session} active={session.id === activeID()} blocked={blocked()} tableSidebar={tableSidebar} transferPreferences={sidebarPreferences.transfer()} editingPreferences={sidebarPreferences.editing()} registerWorkspace={handle => { if (handle) workspaces.set(session.id, handle); else workspaces.delete(session.id) }} onNewConnection={newConnection} onCloseSession={() => closeSession(session.id)} onOpenDatabase={database => openDatabase(session.id, database)}/>
          </Show>
        }</For></div>
      </div>
    </Show>
    <Show when={error()}>{message => <Toast message={message()} onClose={() => setError('')}/>}</Show>
    <Show when={connectionOpen()}><ConnectionModal config={connectionConfig()} setConfig={setConnectionConfig} saved={savedConnections()} busy={busy()} onEdit={editSaved} onRemove={removeSaved} onSQLite={connectFile} onPostgres={config => connect(() => api().OpenPostgresSession(config))} onSaved={openSaved} onError={setError} onClose={() => setConnectionOpen(false)}/></Show>
    <Show when={editingConnection()}>{profile => <SavedConnectionEditModal profile={profile()} busy={busy()} onSave={saveEditedConnection} onClose={() => setEditingConnection(null)}/>}</Show>
    <Show when={failedConnection()}>{session => <ConnectionFailureModal session={session()} onEdit={editFailedConnection} onClose={closeFailedConnection}/>}</Show>
    <Show when={appearanceOpen()}>
      <AppearanceModal appearance={sidebarPreferences.appearance()} transfer={sidebarPreferences.transfer()} editing={sidebarPreferences.editing()} ready={sidebarPreferences.ready()} onChange={sidebarPreferences.setAppearance} onTransferChange={sidebarPreferences.setTransfer} onEditingChange={sidebarPreferences.setEditing} onClose={() => setAppearanceOpen(false)}/>
    </Show>
  </div>
}

type WorkspaceHandle = { beforeLeave: (run: () => void | Promise<void>) => void }

function ConnectionSkeleton(props: { session: WorkspaceSession; active: boolean; tableSidebar: SidebarSizing }) {
  const failed = () => props.session.connectionState === 'failed'
  return <div class={`database-workspace connection-skeleton ${failed() ? 'failed' : ''}`} hidden={!props.active} aria-busy={!failed()}>
    <div class="workspace">
      <aside class="sidebar" style={{ width: `${props.tableSidebar.width()}px`, 'flex-basis': `${props.tableSidebar.width()}px` }}>
        <div class="connection-card skeleton-connection-card"><span class={`db-avatar ${props.session.driver === 'PostgreSQL' ? 'postgres' : ''}`}>{props.session.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span><span class="connection-text"><b>{props.session.name}</b><small>{failed() ? 'Connection failed' : 'Connecting…'}</small></span>{failed() ? <Alert size={16}/> : <Refresh size={16} class="spin"/>}</div>
        <div class="skeleton-sidebar-lines" aria-hidden="true"><i/><i/><i/><i/><i/></div>
      </aside>
      <section class="main-panel">
        <div class="top-tabs"><div class="skeleton-block skeleton-tab"/></div>
        <div class="skeleton-main" role="status" aria-live="polite">
          <div class="skeleton-heading"><div class="skeleton-block"/><div class="skeleton-block"/></div>
          <div class="skeleton-toolbar"><div class="skeleton-block"/><div class="skeleton-block"/><div class="skeleton-block"/></div>
          <div class="skeleton-table" aria-hidden="true"><Index each={Array.from({ length: 8 })}>{() => <div><Index each={Array.from({ length: 5 })}>{() => <i class="skeleton-block"/>}</Index></div>}</Index></div>
          <span class="sr-only">{failed() ? `Could not connect to ${props.session.name}` : `Connecting to ${props.session.name}`}</span>
        </div>
      </section>
    </div>
  </div>
}

function DatabaseWorkspace(props: {
  status: ConnectionStatus
  active: boolean
  blocked: boolean
  tableSidebar: SidebarSizing
  transferPreferences: TransferPreferences
  editingPreferences: EditingPreferences
  registerWorkspace: (handle: WorkspaceHandle | null) => void
  onNewConnection: () => void
  onCloseSession: () => Promise<void>
  onOpenDatabase: (database: string) => void
}) {
  const status = props.status
  const db = databaseApi(status.id)
  const [tables, setTables] = createSignal<TableSummary[]>([])
  const [activeTable, setActiveTable] = createSignal('')
  const [tabs, setTabs] = createSignal<string[]>([])
  const [pinnedTabs, setPinnedTabs] = createSignal<Set<string>>(new Set())
  const [tabStates, setTabStates] = createStore<Record<string, TableTabState>>({})
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null)
  const [selectedTables, setSelectedTables] = createSignal<Set<string>>(new Set())
  let selectionAnchor = ''
  const [transferDialog, setTransferDialog] = createSignal<TransferState | null>(null)
  const [transferBusy, setTransferBusy] = createSignal(false)
  const [operationNotice, setOperationNotice] = createSignal('')
  const [confirmAction, setConfirmAction] = createSignal<{ title: string; message: string; run: () => Promise<void> } | null>(null)
  const closeContextMenu = () => setContextMenu(null)
  const [sidebarFilter, setSidebarFilter] = createSignal('')
  const [pane, setPane] = createSignal<'data' | 'scripts'>('data')
  const [scripts, setScripts] = createSignal<ScriptFile[]>([])
  const [scriptsLoading, setScriptsLoading] = createSignal(true)
  const [scriptWorkspace, setScriptWorkspace] = createSignal('')
  const [activeScript, setActiveScript] = createSignal('')
  const [openScripts, setOpenScripts] = createSignal<string[]>([])
  const [activePane, setActivePane] = createSignal<'table' | 'script'>('table')
  // Every open script keeps its own text, its last saved copy and its results,
  // so switching tabs preserves all three rather than sharing one editor.
  const [buffers, setBuffers] = createStore<Record<string, ScriptBuffer>>({})
  const [renamingScript, setRenamingScript] = createSignal('')
  const [scriptGuard, setScriptGuard] = createSignal<{ name: string; run: () => void | Promise<void> } | null>(null)
  const [loadingTables, setLoadingTables] = createSignal(true)
  const [countingTables, setCountingTables] = createSignal<Set<string>>(new Set())
  const [sidebarOpen, setSidebarOpen] = createSignal(true)

  const [error, setError] = createSignal('')
  let saving = false
  const [draftsByTable, setDraftsByTable] = createStore<Record<string, DraftHistory>>({})
  const [guardedAction, setGuardedAction] = createSignal<{ table: string; tables?: string[]; title: string; message: string; run: () => void | Promise<void> } | null>(null)
  let sidebarSearch!: HTMLInputElement
  let rowCountGeneration = 0

  createEffect(() => { if (!props.active || props.blocked) setContextMenu(null) })

  const draftFor = (key: string) => draftsByTable[key] ?? { past: [], present: [], future: [] }
  const draftOperations = (key: string) => draftsByTable[key]?.present ?? []

  function updateTabState(key: string, change: (state: TableTabState) => TableTabState) {
    if (!key) return
    setTabStates(key, previous => change(previous ?? newTableTabState()))
  }

  function loadRowCounts(items: TableSummary[]) {
    const generation = ++rowCountGeneration
    const pending = [...items]
    setCountingTables(new Set(items.map(tableKey)))

    async function worker() {
      while (pending.length) {
        const item = pending.shift()
        if (!item) return
        const key = tableKey(item)
        try {
          const rows = await db.CountTableRows(item.schema, item.name)
          if (generation !== rowCountGeneration) return
          setTables(current => current.map(value => tableKey(value) === key ? { ...value, rows } : value))
        } catch { /* A failed count remains unavailable without blocking table browsing. */ }
        finally {
          if (generation === rowCountGeneration) setCountingTables(current => {
            const next = new Set(current)
            next.delete(key)
            return next
          })
        }
      }
    }

    void Promise.all(Array.from({ length: Math.min(ROW_COUNT_CONCURRENCY, pending.length) }, worker))
  }

  async function loadTables() {
    const next = (await db.ListTables() ?? []).map(item => ({ ...item, rows: -1 }))
    setTables(next)
    loadRowCounts(next)
  }

  onMount(() => {
    let cancelled = false
    onCleanup(() => { cancelled = true; rowCountGeneration += 1 })
    db.ListTables().then(next => {
      if (cancelled) return
      const items = (next ?? []).map(item => ({ ...item, rows: -1 }))
      setTables(items)
      loadRowCounts(items)
    }).catch(e => { if (!cancelled) setError(String(e)) }).finally(() => { if (!cancelled) setLoadingTables(false) })
  })

  // A tab owns its rows, schema and indexes. Re-entering an already-loaded tab must not
  // query again unless one of its request inputs changed or it was explicitly invalidated.
  // Dependencies are listed explicitly: the body both reads and writes this tab's state,
  // so automatic tracking would re-trigger the effect from its own writes.
  createEffect(on(() => [
    activeTable(),
    status.connected,
    tables(),
    tabStates[activeTable()]?.page,
    tabStates[activeTable()]?.filter,
    tabStates[activeTable()]?.sortColumn,
    tabStates[activeTable()]?.sortDirection,
    tabStates[activeTable()]?.loadedRequest,
    tabStates[activeTable()]?.schemaLoaded,
    tabStates[activeTable()]?.indexesLoaded,
  ] as const, () => {
    const key = activeTable()
    if (!key || !status.connected) return
    const selected = tables().find(item => tableKey(item) === key)
    const state = tabStates[key]
    if (!selected || !state) return
    const requestKey = tableRequestKey(state)
    if (state.loadedRequest === requestKey && state.schemaLoaded && state.indexesLoaded) return
    const request = { page: state.page, filter: state.filter, sortColumn: state.sortColumn, sortDirection: state.sortDirection }
    const cachedData = unwrap(state.data)
    const cachedSchema = unwrap(state.schema)
    const cachedIndexes = unwrap(state.indexes)
    const hadData = Boolean(state.loadedRequest)
    const hadSchema = state.schemaLoaded
    const hadIndexes = state.indexesLoaded
    const dataUsable = state.loadedRequest === requestKey
    let cancelled = false
    const timer = window.setTimeout(async () => {
      updateTabState(key, current => ({
        ...current,
        loading: true,
        loadError: '',
        structureError: '',
        data: hadData ? current.data : emptyData(),
        schema: hadSchema ? current.schema : [],
        indexes: hadIndexes ? current.indexes : [],
      }))
      const [dataResult, schemaResult, indexesResult] = await Promise.allSettled([
        dataUsable ? Promise.resolve(cachedData) : db.GetTableData(selected.schema, selected.name, PAGE_SIZE, request.page * PAGE_SIZE, request.filter, request.sortColumn, request.sortDirection),
        hadSchema ? Promise.resolve(cachedSchema) : db.GetTableSchema(selected.schema, selected.name),
        hadIndexes ? Promise.resolve(cachedIndexes) : db.GetTableIndexes(selected.schema, selected.name),
      ])
      if (cancelled) return
      const loadError = dataResult.status === 'rejected' ? tableLoadError(dataResult.reason) : ''
      const structureFailures = [schemaResult, indexesResult].filter(result => result.status === 'rejected') as PromiseRejectedResult[]
      const structureError = structureFailures.map(result => tableLoadError(result.reason)).join('\n')
      updateTabState(key, current => tableRequestKey(current) === requestKey ? {
        ...current,
        data: dataResult.status === 'fulfilled' ? dataResult.value : emptyData(),
        schema: schemaResult.status === 'fulfilled' ? schemaResult.value : [],
        indexes: indexesResult.status === 'fulfilled' ? indexesResult.value : [],
        loadedRequest: requestKey,
        schemaLoaded: true,
        indexesLoaded: true,
        loading: false,
        loadError,
        structureError,
      } : current)
    }, request.filter ? 250 : 0)
    onCleanup(() => { cancelled = true; window.clearTimeout(timer) })
  }))

  function openTable(item: TableSummary, view?: TableTabState['view']) {
    const key = tableKey(item)
    batch(() => {
      setActiveTable(key)
      setTabs(current => current.includes(key) ? current : [...current, key])
      if (!tabStates[key]) setTabStates(key, newTableTabState())
      if (view) setTabStates(key, 'view', view)
      setActivePane('table')
    })
  }

  function closeTabsNow(names: string[]) {
    const closing = new Set(names)
    batch(() => {
      const next = tabs().filter(tab => !closing.has(tab))
      setTabs(next)
      if (closing.has(activeTable())) setActiveTable(next.at(-1) ?? '')
      setPinnedTabs(current => new Set([...current].filter(tab => !closing.has(tab))))
      setTabStates(produce(states => { closing.forEach(name => { delete states[name] }) }))
      setDraftsByTable(produce(drafts => { closing.forEach(name => { delete drafts[name] }) }))
    })
  }

  function closeTabNow(name: string) { closeTabsNow([name]) }

  function closeTab(name: string) {
    guardUnsaved(name, 'Close this tab?', 'This tab has changes that have not been saved.', () => closeTabNow(name))
  }

  function closeAllTabs() {
    if (!tabs().length) return
    guardWorkspace('Close all tabs?', 'Unsaved changes in open tabs will be lost.', () => closeTabsNow(tabs()))
  }

  function togglePin(tab: string) {
    const nextPinned = new Set(pinnedTabs())
    if (nextPinned.has(tab)) nextPinned.delete(tab)
    else nextPinned.add(tab)
    batch(() => {
      setPinnedTabs(nextPinned)
      setTabs(current => [...current.filter(key => nextPinned.has(key)), ...current.filter(key => !nextPinned.has(key))])
    })
  }

  function showContextMenu(event: MouseEventOn<HTMLElement>, kind: ContextMenuState['kind'], key: string) {
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX || bounds.left + 24
    const y = event.clientY || bounds.top + Math.min(bounds.height, 24)
    setContextMenu({ kind, key, x, y })
  }

  function refsForKeys(keys: Iterable<string>) {
    const selected = new Set(keys)
    return tables().filter(item => item.type === 'table' && selected.has(tableKey(item))).map(item => ({ schema: item.schema, name: item.name }))
  }

  function selectTable(event: MouseEventOn<HTMLButtonElement>, item: TableSummary) {
    const key = tableKey(item)
    if (item.type === 'table' && event.shiftKey && selectionAnchor) {
      const items = tableItems()
      const start = items.findIndex(value => tableKey(value) === selectionAnchor)
      const end = items.findIndex(value => tableKey(value) === key)
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start]
        setSelectedTables(new Set(items.slice(from, to + 1).map(tableKey)))
        return
      }
    }
    if (item.type === 'table' && (event.ctrlKey || event.metaKey)) {
      setSelectedTables(current => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      selectionAnchor = key
      return
    }
    setSelectedTables(item.type === 'table' ? new Set([key]) : new Set<string>())
    selectionAnchor = item.type === 'table' ? key : ''
    openTable(item)
  }

  function showTableContextMenu(event: MouseEventOn<HTMLButtonElement>, item: TableSummary) {
    const key = tableKey(item)
    if (item.type === 'table' && !selectedTables().has(key)) {
      setSelectedTables(new Set([key]))
      selectionAnchor = key
    }
    showContextMenu(event, 'table', key)
  }

  async function openTransferPreview(load: () => Promise<TransferPreview>, refs: TableRef[], format: 'csv' | 'json' = 'json') {
    setTransferBusy(true); setError('')
    try {
      const preview = await load()
      if (preview.kind === 'restore' && preview.driver !== status.driver) throw new Error(`This ${preview.driver} backup cannot be restored into ${status.driver}.`)
      if (preview.kind) setTransferDialog({ preview, tables: refs, format, conflict: 'abort' })
    } catch (e) { setError(String(e)) }
    finally { setTransferBusy(false) }
  }

  function startBackup() {
    void openTransferPreview(() => db.PreviewDatabaseBackup(), [])
  }

  function startRestore() {
    if (status.readOnly) return
    guardWorkspace('Restore this database?', 'Restoring replaces data in the archived tables. Save or discard local drafts first.', () => {
      void openTransferPreview(() => db.ChooseRestoreBackup(), [])
    })
  }

  function startExport(refs: TableRef[]) {
    void openTransferPreview(() => db.PreviewTableExport(refs), refs, refs.length === 1 ? 'csv' : 'json')
  }

  function startImport(ref: TableRef) {
    if (status.readOnly) return
    guardUnsaved(qualifiedKey(ref.schema, ref.name), 'Import into this table?', 'Importing changes database rows and requires resolving local drafts first.', () => {
      void openTransferPreview(() => db.ChooseTableImport(ref), [ref])
    })
  }

  function invalidateTransferredTables(refs?: TableRef[]) {
    const keys = refs?.length ? new Set(refs.map(ref => qualifiedKey(ref.schema, ref.name))) : null
    setTabStates(produce(states => {
      for (const key of Object.keys(states)) {
        if (keys && !keys.has(key)) continue
        states[key].loadedRequest = ''
        states[key].schemaLoaded = false
        states[key].indexesLoaded = false
        states[key].selectedRows = new Set()
      }
    }))
    void loadTables().catch(e => setError(String(e)))
  }

  async function runTransfer() {
    const dialog = transferDialog()
    if (!dialog || transferBusy()) return
    const { preview, tables: refs, format, conflict } = dialog
    setTransferBusy(true); setError('')
    try {
      let result: TransferResult
      if (preview.kind === 'backup') result = await db.BackupDatabase(props.transferPreferences.backupBatchSizeMB)
      else if (preview.kind === 'restore') result = await db.RestoreDatabase(preview.path)
      else if (preview.kind === 'export') result = await db.ExportTables(refs, format)
      else result = await db.ImportTable(refs[0], preview.path, conflict)
      if (!result.path && (preview.kind === 'backup' || preview.kind === 'export')) return
      setTransferDialog(null)
      const skipped = result.skipped ? ` · ${result.skipped.toLocaleString()} skipped` : ''
      setOperationNotice(`${preview.kind === 'backup' ? 'Backup' : preview.kind === 'restore' ? 'Restore' : preview.kind === 'export' ? 'Export' : 'Import'} complete · ${result.rows.toLocaleString()} rows${skipped}`)
      if (preview.kind === 'restore') invalidateTransferredTables()
      if (preview.kind === 'import') invalidateTransferredTables(refs)
    } catch (e) { setError(String(e)) }
    finally { setTransferBusy(false) }
  }

  function confirmTruncate(refs: TableRef[]) {
    guardWorkspace('Truncate selected tables?', 'Truncate permanently removes every row from the selected tables.', () => void setConfirmAction({
      title: `Truncate ${refs.length} table${refs.length === 1 ? '' : 's'}?`,
      message: 'This operation cannot be undone. All rows in the selected tables will be removed in one transaction.',
      run: async () => {
        setTransferBusy(true)
        try {
          const affected = await db.TruncateTables(refs)
          setConfirmAction(null); invalidateTransferredTables(refs)
          setOperationNotice(`Truncate complete · ${affected.toLocaleString()} ${status.driver === 'SQLite' ? 'rows' : 'tables'} affected`)
        } catch (e) { setError(String(e)) }
        finally { setTransferBusy(false) }
      },
    }))
  }

  function refreshFromMenu(item: TableSummary) {
    const key = tableKey(item)
    if (!tabStates[key]) openTable(item)
    else { setActiveTable(key); setActivePane('table'); refresh(key) }
  }

  function copyQualifiedName(item: TableSummary) {
    void navigator.clipboard?.writeText(`${item.schema}.${item.name}`).catch(e => setError(String(e)))
  }

  function guardWorkspace(title: string, message: string, run: () => void | Promise<void>) {
    if (saving) return
    const dirty = Object.keys(draftsByTable).filter(key => draftsByTable[key].present.length)
    if (dirty.length) setGuardedAction({ table: dirty[0], tables: dirty, title, message, run })
    else void run()
  }

  onMount(() => {
    props.registerWorkspace({
      beforeLeave: run => guardWorkspace('Switch database?', 'This database has unsaved changes. Save or discard them before continuing.', run),
    })
    onCleanup(() => props.registerWorkspace(null))
  })

  function disconnect() {
    guardWorkspace('Close database?', 'Unsaved changes in this database will be lost.', props.onCloseSession)
  }

  async function refreshNow(key = activeTable()) {
    if (!tabStates[key]) return
    updateTabState(key, current => ({ ...current, loading: true, loadError: '' })); setError('')
    try {
      await loadTables()
      updateTabState(key, current => ({ ...current, loadedRequest: '', schemaLoaded: false, indexesLoaded: false }))
    }
    catch (e) { setError(String(e)); updateTabState(key, current => ({ ...current, loading: false })) }
  }

  function refresh(key = activeTable()) {
    guardUnsaved(key, 'Refresh table?', 'Refreshing will replace the rows that contain unsaved changes.', () => refreshNow(key))
  }

  function changeSortNow(key: string, column: string) {
    updateTabState(key, state => {
      if (state.sortColumn !== column) return { ...state, sortColumn: column, sortDirection: 'asc', page: 0, selectedRows: new Set() }
      if (state.sortDirection === 'asc') return { ...state, sortDirection: 'desc', page: 0, selectedRows: new Set() }
      return { ...state, sortColumn: '', sortDirection: 'asc', page: 0, selectedRows: new Set() }
    })
  }

  function changeSort(key: string, column: string) {
    guardUnsaved(key, 'Change sorting?', 'Sorting may replace rows that contain unsaved changes.', () => changeSortNow(key, column))
  }

  const [columnCache, setColumnCache] = createStore<Record<string, string[]>>({})
  const completionTables = createMemo<CompletionTable[]>(() => tables().map(item => {
    const key = tableKey(item)
    return { schema: item.schema, name: item.name, columns: tabStates[key]?.schema.map(column => column.name) ?? columnCache[key] ?? [] }
  }))

  async function loadColumnsFor(name: string) {
    const item = tables().find(table => table.name.toLowerCase() === name.toLowerCase())
    if (!item) return
    const key = tableKey(item)
    if (columnCache[key]) return
    setColumnCache(key, [])
    // Completion is best effort: a table that cannot be introspected simply
    // offers no columns rather than surfacing an error mid-keystroke.
    try { setColumnCache(key, (await db.GetTableSchema(item.schema, item.name)).map(column => column.name)) }
    catch { /* leave the empty entry so the fetch is not retried on every keystroke */ }
  }

  const openBuffer = (name: string) => { if (!buffers[name]) setBuffers(name, { text: '', saved: '', result: null, running: false }) }
  const editorText = () => buffers[activeScript()]?.text ?? ''
  const setEditorText = (value: string) => setBuffers(activeScript(), 'text', value)
  // The scratch buffer has no file behind it, so it is never "unsaved".
  const scriptDirty = (name = activeScript()) => Boolean(name) && Boolean(buffers[name]) && buffers[name].text !== buffers[name].saved
  const filteredScripts = createMemo(() => scripts().filter(script => script.name.toLowerCase().includes(sidebarFilter().toLowerCase())))

  async function loadScripts() {
    setScriptsLoading(true)
    try { setScripts(await db.ListScripts() ?? []) }
    catch (e) { setError(String(e)) }
    finally { setScriptsLoading(false) }
  }

  // Scripts are only read once their pane is opened, so a database that never
  // uses them never touches the file system.
  createEffect(on(pane, current => {
    if (current !== 'scripts') return
    void loadScripts()
    if (!scriptWorkspace()) db.ScriptWorkspacePath().then(setScriptWorkspace).catch(() => {})
  }))

  function showScript(name: string) {
    batch(() => {
      setOpenScripts(current => current.includes(name) ? current : [...current, name])
      setActiveScript(name)
      setActivePane('script')
    })
  }

  async function openScriptNow(name: string) {
    if (buffers[name]) { showScript(name); return }
    try {
      const content = await db.ReadScript(name)
      batch(() => {
        setBuffers(name, { text: content, saved: content, result: null, running: false })
        showScript(name)
      })
    } catch (e) { setError(String(e)) }
  }

  // Each tab holds its own buffer, so opening another one loses nothing and
  // needs no guard. Closing a dirty tab still does.
  function openScript(name: string) { void openScriptNow(name) }

  function openScratch() {
    openBuffer('')
    showScript('')
  }

  function closeScript(name: string) {
    const drop = () => batch(() => {
      setOpenScripts(current => current.filter(item => item !== name))
      setBuffers(produce(state => { delete state[name] }))
      if (activeScript() === name) {
        const remaining = openScripts().filter(item => item !== name)
        setActiveScript(remaining.at(-1) ?? '')
        if (!remaining.length) setActivePane('table')
      }
    })
    if (scriptDirty(name)) setScriptGuard({ name, run: drop })
    else drop()
  }

  async function saveScript() {
    const name = activeScript()
    if (!name) return
    const content = buffers[name]?.text ?? ''
    try {
      await db.SaveScript(name, content)
      setBuffers(name, 'saved', content)
      await loadScripts()
    } catch (e) { setError(String(e)); throw e }
  }

  // A new script is created under a free default name and opened straight into
  // rename, so naming is one step rather than a dialog before any content.
  function newScript() {
    void (async () => {
      const taken = new Set(scripts().map(script => script.name.toLowerCase()))
      let name = 'untitled'
      for (let n = 2; taken.has(`${name}.sql`); n++) name = `untitled ${n}`
      try {
        const created = await db.CreateScript(name)
        await loadScripts()
        await openScriptNow(created.name)
        setRenamingScript(created.name)
      } catch (e) { setError(String(e)) }
    })()
  }

  async function renameScript(from: string, to: string) {
    setRenamingScript('')
    if (!to.trim() || to === from) return
    try {
      const renamed = await db.RenameScript(from, to)
      batch(() => {
        if (buffers[from]) {
          setBuffers(renamed.name, { ...buffers[from] })
          setBuffers(produce(state => { delete state[from] }))
        }
        setOpenScripts(current => current.map(item => item === from ? renamed.name : item))
        if (activeScript() === from) setActiveScript(renamed.name)
      })
      await loadScripts()
    } catch (e) { setError(String(e)) }
  }

  function deleteScript(name: string) {
    const remove = async () => {
      try {
        await db.DeleteScript(name)
        batch(() => {
          setOpenScripts(current => current.filter(item => item !== name))
          setBuffers(produce(state => { delete state[name] }))
          if (activeScript() === name) {
            const remaining = openScripts().filter(item => item !== name)
            setActiveScript(remaining.at(-1) ?? '')
            if (!remaining.length) setActivePane('table')
          }
        })
        await loadScripts()
      } catch (e) { setError(String(e)) }
    }
    if (scriptDirty(name)) setScriptGuard({ name, run: remove })
    else void remove()
  }

  // The editor decides what a run covers: the statement at the cursor, or every
  // statement the selection touches. Each one keeps its own read-only
  // transaction, so the console stays read-only however many are sent.
  async function executeQuery(statements: string[]) {
    const queries = statements.map(statement => statement.trim()).filter(Boolean)
    if (!queries.length) { setError('There is no statement to run.'); return }
    const target = activeScript()
    if (!buffers[target]) return
    setBuffers(target, 'running', true); setError('')
    try {
      let result: QueryResult | null = null
      for (const [position, statement] of queries.entries()) {
        try { result = await db.ExecuteQuery(statement) }
        catch (e) { throw new Error(`statement ${position + 1} of ${queries.length}: ${String(e).replace(/^Error:\s*/i, '')}`) }
      }
      if (result && queries.length > 1) result = { ...result, message: `${queries.length} statements · ${result.message}` }
      if (buffers[target]) setBuffers(target, 'result', result)
    } catch (e) { setError(String(e)) }
    finally { if (buffers[target]) setBuffers(target, 'running', false) }
  }

  const historyLimit = () => props.editingPreferences.undoHistoryLimit

  function changeDraft(key: string, change: (operations: PendingOperation[]) => PendingOperation[]) {
    if (!key) return
    const history = draftFor(key)
    const present = unwrap(history.present)
    const nextOperations = change(present)
    if (JSON.stringify(nextOperations) === JSON.stringify(present)) return
    setDraftsByTable(key, {
      past: [...unwrap(history.past), present].slice(-historyLimit()),
      present: nextOperations,
      future: [],
    })
  }

  function clearDraft(key: string) {
    if (!(key in draftsByTable)) return
    setDraftsByTable(produce(drafts => { delete drafts[key] }))
  }

  function undoDraft(key = activeTable()) {
    const history = draftsByTable[key]
    if (!history?.past.length) return
    const past = unwrap(history.past)
    const present = unwrap(history.present)
    const future = unwrap(history.future)
    batch(() => {
      setDraftsByTable(key, { past: past.slice(0, -1), present: past[past.length - 1], future: [present, ...future].slice(0, historyLimit()) })
      updateTabState(key, state => ({ ...state, selectedRows: new Set() }))
    })
  }

  function redoDraft(key = activeTable()) {
    const history = draftsByTable[key]
    if (!history?.future.length) return
    const past = unwrap(history.past)
    const present = unwrap(history.present)
    const future = unwrap(history.future)
    batch(() => {
      setDraftsByTable(key, { past: [...past, present].slice(-historyLimit()), present: future[0], future: future.slice(1) })
      updateTabState(key, state => ({ ...state, selectedRows: new Set() }))
    })
  }

  async function updateCell(key: string, data: TableData, draftGrid: ReturnType<typeof buildDraftGrid>, column: string, rowIndex: number, value: unknown) {
    const meta = draftGrid.meta[rowIndex]
    if (!meta || meta.kind === 'delete') return
    changeDraft(key, current => {
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

  function addRecord(key: string) {
    const id = `new:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
    batch(() => {
      changeDraft(key, current => [...current, { id, type: 'insert', values: {}, primaryKey: {} }])
      updateTabState(key, state => ({ ...state, view: 'data' }))
    })
  }

  function toggleSelected(key: string, id: string) {
    updateTabState(key, state => { const selectedRows = new Set(state.selectedRows); if (selectedRows.has(id)) selectedRows.delete(id); else selectedRows.add(id); return { ...state, selectedRows } })
  }

  function deleteSelected(key: string, selectedRows: Set<string>, draftGrid: ReturnType<typeof buildDraftGrid>) {
    if (!selectedRows.size) return
    batch(() => {
      changeDraft(key, current => {
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
      updateTabState(key, state => ({ ...state, selectedRows: new Set() }))
    })
  }

  function stageTruncateNow(key: string) {
    batch(() => {
      changeDraft(key, () => [{ id: 'truncate', type: 'truncate', values: {}, primaryKey: {} }])
      updateTabState(key, state => ({ ...state, selectedRows: new Set() }))
    })
  }

  function stageTruncate(key: string, operations: PendingOperation[]) {
    if (operations.length && !operations.some(operation => operation.type === 'truncate')) guardUnsaved(key, 'Replace pending changes?', 'Truncate will replace the edits already staged in this tab.', () => stageTruncateNow(key))
    else stageTruncateNow(key)
  }

  async function saveChanges(key = activeTable()) {
    const item = tables().find(table => tableKey(table) === key)
    const operations = unwrap(draftOperations(key))
    const state = tabStates[key]
    if (!item || !state || !operations.length) return
    if (saving) throw new Error('A save is already in progress.')
    saving = true
    updateTabState(key, current => ({ ...current, loading: true })); setError('')
    try {
      await db.ApplyChanges(item.schema, item.name, operations.map(({ id: _id, ...operation }) => operation))
      clearDraft(key)
      await loadTables()
      updateTabState(key, current => ({ ...current, selectedRows: new Set(), loadedRequest: '', loadError: '' }))
    } catch (e) { setError(String(e)); throw e }
    finally { saving = false; updateTabState(key, current => ({ ...current, loading: false })) }
  }

  function discardChanges(key: string) {
    batch(() => {
      clearDraft(key)
      updateTabState(key, state => ({ ...state, selectedRows: new Set() }))
    })
  }

  function guardUnsaved(key: string, title: string, message: string, run: () => void | Promise<void>) {
    if (draftOperations(key).length) setGuardedAction({ table: key, title, message, run })
    else void run()
  }

  function changeFilter(key: string, next: string) {
    guardUnsaved(key, 'Apply filter?', 'This filter may hide rows with unsaved changes.', () => updateTabState(key, state => ({ ...state, filter: next, page: 0, selectedRows: new Set() })))
  }

  function changePage(key: string, next: number) {
    guardUnsaved(key, 'Change page?', 'Changing page will hide rows with unsaved changes.', () => updateTabState(key, state => ({ ...state, page: next, selectedRows: new Set() })))
  }

  createEffect(() => {
    if (!props.active || props.blocked) return
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTextEditor = target?.matches('input, textarea, [contenteditable="true"]')
      const key = activeTable()
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        sidebarSearch?.focus()
        sidebarSearch?.select()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        // The script editor is the surface in focus while it is open.
        if (activePane() === 'script' && scriptDirty()) { void saveScript().catch(() => {}); return }
        if (!guardedAction() && !saving && draftOperations(key).length) void saveChanges(key).catch(() => {})
      } else if (!isTextEditor && !guardedAction() && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoDraft(key)
        else undoDraft(key)
      }
    }
    window.addEventListener('keydown', listener)
    onCleanup(() => window.removeEventListener('keydown', listener))
  })

  const filteredTables = createMemo(() => tables().filter(table => table.name.toLowerCase().includes(sidebarFilter().toLowerCase())))
  const tableItems = createMemo(() => filteredTables().filter(item => item.type === 'table'))
  const viewItems = createMemo(() => filteredTables().filter(item => item.type === 'view'))
  const guardedKeys = () => { const action = guardedAction(); return action ? action.tables ?? [action.table] : [] }
  const menuTable = () => { const menu = contextMenu(); return menu?.kind === 'table' ? tables().find(item => tableKey(item) === menu.key) : undefined }
  const menuTableKeys = () => { const menu = contextMenu(); return menu?.kind === 'table' ? selectedTables().has(menu.key) ? selectedTables() : new Set([menu.key]) : new Set<string>() }
  const menuTableRefs = () => refsForKeys(menuTableKeys())
  const singleMenuObject = () => menuTableRefs().length === 1 || menuTable()?.type === 'view'
  const menuActions = (): ContextMenuAction[] => {
    const menu = contextMenu()
    if (!menu) return []
    if (menu.kind === 'tab') return [
      { label: 'Close tab', icon: <X size={15}/>, run: () => closeTab(menu.key) },
      { label: pinnedTabs().has(menu.key) ? 'Unpin tab' : 'Pin tab', icon: <Pin size={15}/>, run: () => togglePin(menu.key) },
      { label: 'Close all tabs', icon: <X size={15}/>, separator: true, danger: true, run: closeAllTabs },
    ]
    if (menu.kind === 'script') return [
      { label: 'Open script', icon: <Code size={15}/>, run: () => openScript(menu.key) },
      { label: 'Rename script', icon: <Edit size={15}/>, run: () => setRenamingScript(menu.key) },
      { label: 'Delete script', icon: <Trash size={15}/>, run: () => deleteScript(menu.key), separator: true, danger: true },
    ]
    if (menu.kind === 'database') return [
      { label: 'New connection', icon: <Plus size={15}/>, run: props.onNewConnection },
      { label: 'Back up database', icon: <Save size={15}/>, run: startBackup },
      ...(!status.readOnly ? [{ label: 'Restore database', icon: <Refresh size={15}/>, run: startRestore, separator: true, danger: true }] : []),
    ]
    const item = menuTable()
    if (!item) return []
    const refs = menuTableRefs()
    return [
      ...(singleMenuObject() ? [
        { label: 'Open data', icon: <Table size={15}/>, run: () => openTable(item, 'data') },
        { label: 'View structure', icon: <Columns size={15}/>, run: () => openTable(item, 'structure') },
      ] : []),
      ...(refs.length ? [{ label: `Export ${refs.length === 1 ? 'table' : `${refs.length} tables`}`, icon: <File size={15}/>, run: () => startExport(refs), separator: true }] : []),
      ...(!status.readOnly && refs.length === 1 ? [{ label: 'Import into table', icon: <Plus size={15}/>, run: () => startImport(refs[0]) }] : []),
      ...(singleMenuObject() ? [{ label: 'Refresh table', icon: <Refresh size={15}/>, run: () => refreshFromMenu(item) }, { label: 'Copy qualified name', icon: <Copy size={15}/>, run: () => copyQualifiedName(item) }] : []),
      ...(!status.readOnly && refs.length ? [{ label: `Truncate ${refs.length === 1 ? 'table' : `${refs.length} tables`}`, icon: <Trash size={15}/>, run: () => confirmTruncate(refs), separator: true, danger: true }] : []),
    ]
  }
  return <div class="database-workspace" hidden={!props.active}>
    <div class="workspace">
      <Show when={sidebarOpen()}><aside class="sidebar" style={{ width: `${props.tableSidebar.width()}px`, 'flex-basis': `${props.tableSidebar.width()}px` }}>
        <button class="connection-card" title={`${status.path}\nRight-click for backup and restore`} onClick={props.onNewConnection} onContextMenu={event => showContextMenu(event, 'database', '')}>
          <span class={`db-avatar ${status.driver === 'PostgreSQL' ? 'postgres' : ''}`}>{status.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span><span class="connection-text"><b>{status.name}</b><small><i class="online-dot"/> {status.driver} · {status.readOnly ? 'Read-only' : 'Editable'}</small></span><ChevronDown size={15}/>
        </button>
        <div class="sidebar-tabs" role="tablist" aria-label="Sidebar contents">
          <button role="tab" aria-selected={pane() === 'data'} class={pane() === 'data' ? 'active' : ''} onClick={() => setPane('data')}><Table size={13}/> Data</button>
          <button role="tab" aria-selected={pane() === 'scripts'} class={pane() === 'scripts' ? 'active' : ''} onClick={() => setPane('scripts')}><Code size={13}/> Scripts<Show when={scripts().length}><em>{scripts().length}</em></Show></button>
        </div>
        <div class="side-search"><Search size={14}/><input ref={sidebarSearch} aria-label={pane() === 'data' ? 'Filter database objects' : 'Filter scripts'} value={sidebarFilter()} onInput={e => setSidebarFilter(e.currentTarget.value)} placeholder={pane() === 'data' ? 'Filter objects' : 'Filter scripts'}/><span class="search-shortcut" aria-hidden="true"><kbd><Command size={12}/></kbd><kbd>K</kbd></span></div>
        <Show when={pane() === 'data'} fallback={
          <div class="object-tree script-pane">
            <div class="script-pane-head"><span title={scriptWorkspace()}>Scripts</span><button class="icon-button" aria-label="New script" title="New script" onClick={newScript}><Plus size={15}/></button></div>
            <Show when={!scriptsLoading()} fallback={<SidebarSkeleton/>}>
              <Show when={filteredScripts().length} fallback={<p class="script-empty">{scripts().length ? 'No script matches this filter.' : 'No scripts yet. Create one to keep SQL alongside this connection.'}</p>}>
                <For each={filteredScripts()}>{(script, index) =>
                  <Show when={renamingScript() !== script.name} fallback={
                    <input class="script-rename" value={script.name.replace(/\.sql$/i, '')} ref={el => queueMicrotask(() => { el.focus(); el.select() })}
                      onBlur={event => void renameScript(script.name, event.currentTarget.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                        if (event.key === 'Escape') { setRenamingScript(''); event.currentTarget.blur() }
                      }}/>
                  }>
                    <button class={`object-row script-row ${activeScript() === script.name ? 'active' : ''}`} style={{ '--stagger': String(index()) }} title={`${script.name}\n${new Date(script.modified).toLocaleString()}`} onClick={() => openScript(script.name)} onContextMenu={event => showContextMenu(event, 'script', script.name)}>
                      <File size={14}/><span>{script.name.replace(/\.sql$/i, '')}</span>
                      <Show when={activeScript() === script.name && scriptDirty()}><i class="script-dirty" title="Unsaved changes"/></Show>
                    </button>
                  </Show>
                }</For>
              </Show>
            </Show>
          </div>
        }>
        <div class="object-tree"><Show when={!loadingTables()} fallback={<SidebarSkeleton/>}>
          <ObjectGroup label="Tables" count={tableItems().length}><For each={tableItems()}>{(item, index) => <ObjectRow item={item} stagger={index()} countLoading={countingTables().has(tableKey(item))} active={activeTable() === tableKey(item)} selected={selectedTables().has(tableKey(item))} onClick={event => selectTable(event, item)} onContextMenu={event => showTableContextMenu(event, item)}/>}</For></ObjectGroup>
          <ObjectGroup label="Views" count={viewItems().length}><For each={viewItems()}>{(item, index) => <ObjectRow item={item} stagger={index()} countLoading={countingTables().has(tableKey(item))} active={activeTable() === tableKey(item)} selected={false} onClick={event => selectTable(event, item)} onContextMenu={event => showTableContextMenu(event, item)}/>}</For></ObjectGroup>
        </Show></div>
        </Show>
        <div class="sidebar-footer"><DatabasePicker status={status} onSelect={props.onOpenDatabase}/><button onClick={() => refresh()} class="icon-button database-refresh" title="Refresh database" aria-label="Refresh database" disabled={loadingTables()}><Refresh size={15} class={loadingTables() ? 'spin' : ''}/></button><button onClick={disconnect} class="icon-button" title="Close database" aria-label="Close database"><X size={15}/></button></div>
        <SidebarResizeHandle label="Resize table sidebar" sizing={props.tableSidebar}/>
      </aside></Show>
      <section class="main-panel">
        <div class="top-tabs">
          <button class="icon-button sidebar-toggle" onClick={() => setSidebarOpen(value => !value)} title="Toggle sidebar"><PanelLeft size={17}/></button>
          <TabStrip activeTab={activeTable()}><For each={tabs()}>{tab => {
            const item = () => tables().find(value => tableKey(value) === tab)
            const changes = () => draftOperations(tab).length
            const pinned = () => pinnedTabs().has(tab)
            return <Show when={item()}>{value => <button data-active={activeTable() === tab} title={`${value().schema}.${value().name}`} onClick={() => batch(() => { setActiveTable(tab); setActivePane('table') })} onContextMenu={event => showContextMenu(event, 'tab', tab)} class={`tab ${activeTable() === tab ? 'active' : ''} ${changes() ? 'changed' : ''} ${pinned() ? 'pinned' : ''}`}>{pinned() ? <Pin size={13} class="tab-pin"/> : <Table size={14}/>}<b class="tab-label">{value().name}</b><Show when={changes() > 0}><i class="tab-change-dot" title={`${changes()} pending change(s)`}/></Show><span onClick={e => { e.stopPropagation(); closeTab(tab) }}><X size={13}/></span></button>}</Show>
          }}</For><For each={openScripts()}>{name => {
            const label = () => name ? name.replace(/\.sql$/i, '') : 'Query'
            const current = () => activePane() === 'script' && activeScript() === name
            return <button data-active={current()} title={label()} class={`tab script-tab ${current() ? 'active' : ''} ${scriptDirty(name) ? 'changed' : ''}`} onClick={() => showScript(name)}>
              <Code size={13}/><b class="tab-label">{label()}</b>
              <Show when={scriptDirty(name)}><i class="tab-change-dot" title="Unsaved changes"/></Show>
              <span onClick={event => { event.stopPropagation(); closeScript(name) }}><X size={13}/></span>
            </button>
          }}</For></TabStrip>
          <button class={`query-tab ${activePane() === 'script' && !activeScript() ? 'active' : ''}`} title="Scratch SQL" onClick={openScratch}><Code size={15}/> SQL</button>
          <button class="icon-button" aria-label="Workspace actions" aria-haspopup="menu" title="Workspace actions" onClick={event => showContextMenu(event, 'database', '')}><More size={17}/></button>
        </div>
        <For each={tabs()}>{tab => {
          const item = () => tables().find(value => tableKey(value) === tab)
          const state = () => tabStates[tab]
          const history = () => draftFor(tab)
          const operations = () => history().present
          // Scoped to this tab, so an edit or keystroke in one tab never rebuilds another tab's grid.
          const draftGrid = createMemo(() => {
            const current = state()
            return current ? buildDraftGrid(current.data, current.schema, operations(), current.page) : null
          })
          const actualTotalPages = () => Math.max(1, Math.ceil((state()?.data.total ?? 0) / PAGE_SIZE))
          const pagingLimited = () => actualTotalPages() > MAX_NAVIGABLE_PAGES
          const totalPages = () => Math.min(MAX_NAVIGABLE_PAGES, actualTotalPages())
          return <Show when={item() && state() && draftGrid()}>
            <div class="table-activity" hidden={activePane() !== 'table' || activeTable() !== tab}>
              <header class="content-header">
                <div><div class="breadcrumbs"><span>{status.name}</span><ChevronRight size={13}/><span>{item()!.schema}</span><ChevronRight size={13}/><b>{item()!.name}</b></div><h2>{item()!.name}<span>{item()!.type}</span></h2></div>
                <div class="header-actions"><button class="secondary" onClick={openScratch}><Code size={15}/> Query</button><button class="primary" onClick={() => refresh(tab)}><Refresh size={15} class={state()!.loading || loadingTables() ? 'spin' : ''}/> Refresh</button></div>
              </header>
              <div class="data-toolbar">
                <div class="view-switch"><button class={state()!.view === 'data' ? 'active' : ''} onClick={() => setTabStates(tab, 'view', 'data')}><Table size={14}/> Data</button><button class={state()!.view === 'structure' ? 'active' : ''} onClick={() => setTabStates(tab, 'view', 'structure')}><Columns size={14}/> Structure <span>{state()!.schema.length}</span></button></div>
                <Show when={state()!.view === 'data' && !state()!.loadError && !status.readOnly && item()!.type === 'table'}><div class="row-actions"><button onClick={() => addRecord(tab)}><Plus size={14}/> New row</button><button class="danger-action" disabled={!state()!.selectedRows.size} onClick={() => deleteSelected(tab, state()!.selectedRows, draftGrid()!)}><Trash size={14}/> Delete</button><button class="danger-action" onClick={() => stageTruncate(tab, operations())}><Trash size={14}/> Truncate</button></div></Show>
                <div class="toolbar-spacer"/>
                <Show when={state()!.view === 'data'}>
                  <Show when={!status.readOnly && item()!.type === 'table'}><div class="draft-actions"><button disabled={!history().past.length} onClick={() => undoDraft(tab)} title="Undo draft change (Ctrl+Z)"><Undo size={14}/> Undo</button><button disabled={!history().future.length} onClick={() => redoDraft(tab)} title="Redo draft change (Ctrl+Shift+Z)"><Redo size={14}/> Redo</button><Show when={operations().length > 0}><button class="discard-draft" onClick={() => discardChanges(tab)} title="Discard all changes in this table"><X size={14}/> Discard</button></Show></div></Show>
                  <label class="record-search"><Search size={14}/><input value={state()!.filter} onInput={e => changeFilter(tab, e.currentTarget.value)} placeholder="Search records..."/><Show when={state()!.filter}><button onClick={() => changeFilter(tab, '')}><X size={13}/></button></Show></label>
                  <button class="tool-button"><Filter size={14}/> Filter</button><button class="tool-button"><Columns size={14}/> Columns</button>
                  <Show when={operations().length > 0}><button class="save-changes" onClick={() => void saveChanges(tab).catch(() => {})}><Save size={14}/> Save <b>{operations().length}</b><kbd>Ctrl S</kbd></button></Show>
                </Show>
              </div>
              <div class="content-body">
                <Show when={state()!.view === 'data'} fallback={<SchemaView schema={state()!.schema} indexes={state()!.indexes} error={state()!.structureError}/>}>
                  <Show when={!state()!.loadError} fallback={<TableLoadError message={state()!.loadError} onRetry={() => refresh(tab)}/>}>
                    <DataGrid data={draftGrid()!.data} rowMeta={draftGrid()!.meta} selected={state()!.selectedRows} onSelect={id => toggleSelected(tab, id)} rowOffset={state()!.page * PAGE_SIZE} sortColumn={state()!.sortColumn} sortDirection={state()!.sortDirection} onSort={column => changeSort(tab, column)} layoutKey={`${status.driver}:${status.path}:${item()!.schema}.${item()!.name}`} editable={!status.readOnly} onUpdate={(column, rowIndex, value) => updateCell(tab, state()!.data, draftGrid()!, column, rowIndex, value)}/>
                  </Show>
                </Show>
                <Show when={state()!.loading || loadingTables()}><div class="loading-bar"/></Show>
              </div>
              <footer class="pagination"><span>{state()!.data.total ? `${state()!.page * PAGE_SIZE + 1}–${Math.min((state()!.page + 1) * PAGE_SIZE, state()!.data.total)} of ${state()!.data.total.toLocaleString()} rows` : '0 rows'}</span><span class="query-time"><Clock size={13}/>{state()!.data.durationMs} ms</span><Show when={!status.readOnly && state()!.schema.some(column => column.primaryKey)}><span class="edit-hint">Double-click a cell to edit</span></Show><div class="page-controls"><Show when={!pagingLimited()} fallback={<div class="paging-limit-warning" role="status"><Alert size={14}/><span><b>Page limit reached</b><small>Paging supports up to {MAX_NAVIGABLE_PAGES.toLocaleString()} pages</small></span></div>}><button aria-label="Previous page" disabled={state()!.page === 0} onClick={() => changePage(tab, state()!.page - 1)}><ChevronRight size={14} class="flip"/></button><QuickPagePicker currentPage={state()!.page + 1} totalPages={totalPages()} onSelect={page => changePage(tab, page - 1)}/><button aria-label="Next page" disabled={state()!.page + 1 >= totalPages()} onClick={() => changePage(tab, state()!.page + 1)}><ChevronRight size={14}/></button></Show></div></footer>

            </div>
          </Show>
        }}</For>
        <Show when={activePane() === 'table' && !activeTable()}>
          <Show when={!loadingTables()} fallback={<WorkspaceSkeleton/>}><div class="no-table"><Table size={30}/><h3>Select a table</h3><p>Choose a table or view from the sidebar.</p></div></Show>
        </Show>
        <Show when={activePane() === 'script' && buffers[activeScript()]}>
          <ScriptPanel
            name={activeScript()}
            text={editorText()}
            dirty={scriptDirty()}
            result={buffers[activeScript()]?.result ?? null}
            running={buffers[activeScript()]?.running ?? false}
            tables={completionTables()}
            onNeedColumns={name => void loadColumnsFor(name)}
            onInput={setEditorText}
            onRun={executeQuery}
            onSave={() => void saveScript().catch(() => {})}
            onClose={() => closeScript(activeScript())}
          />
        </Show>
      </section>
    </div>
    <Show when={error()}>{message => <Toast message={message()} onClose={() => setError('')}/>}</Show>

    <Show when={contextMenu() && menuActions().length > 0}><ContextMenu x={contextMenu()!.x} y={contextMenu()!.y} label={contextMenu()!.kind === 'tab' ? 'Tab actions' : contextMenu()!.kind === 'database' ? 'Database actions' : contextMenu()!.kind === 'script' ? 'Script actions' : 'Table actions'} actions={menuActions()} onClose={closeContextMenu}/></Show>

    <Show when={guardedAction()}>{action =>
      <UnsavedModal title={action().title} message={action().message} count={guardedKeys().reduce((count, key) => count + draftOperations(key).length, 0)} onCancel={() => setGuardedAction(null)} onDiscard={async () => { const current = action(); const keys = guardedKeys(); keys.forEach(discardChanges); setGuardedAction(null); await current.run() }} onSave={async () => { const current = action(); const keys = guardedKeys(); try { for (const key of keys) await saveChanges(key); setGuardedAction(null); await current.run() } catch { /* Keep dialog open when save fails. */ } }}/>
    }</Show>
    <Show when={scriptGuard()}>{guard =>
      <UnsavedModal title="Unsaved script" message={`${guard().name.replace(/\.sql$/i, '')} has changes that have not been saved.`} count={1} onCancel={() => setScriptGuard(null)} onDiscard={async () => { const action = guard(); setScriptGuard(null); await action.run() }} onSave={async () => { const action = guard(); try { await saveScript(); setScriptGuard(null); await action.run() } catch { /* Keep the dialog open when the save fails. */ } }}/>
    }</Show>
    <Show when={transferDialog()}>{dialog =>
      <TransferModal state={dialog()} busy={transferBusy()} onChange={setTransferDialog} onClose={() => setTransferDialog(null)} onRun={() => void runTransfer()}/>
    }</Show>
    <Show when={confirmAction()}>{action =>
      <DangerConfirmModal title={action().title} message={action().message} busy={transferBusy()} onClose={() => setConfirmAction(null)} onConfirm={() => void action().run()}/>
    }</Show>
    <Show when={operationNotice()}>{notice =>
      <OperationToast message={notice()} onClose={() => setOperationNotice('')}/>
    }</Show>
  </div>
}

function ObjectGroup(props: { label: string; count: number; children: JSX.Element }) {
  const [open, setOpen] = createSignal(true)
  return <div class={`object-group ${open() ? 'open' : ''}`}><button class="group-title" onClick={() => setOpen(value => !value)} aria-expanded={open()}>{open() ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<span>{props.label}</span><em>{props.count}</em></button><Show when={open()}><div class="object-children">{props.children}</div></Show></div>
}

function ObjectRow(props: { item: TableSummary; stagger: number; active: boolean; selected: boolean; countLoading: boolean; onClick: (event: MouseEventOn<HTMLButtonElement>) => void; onContextMenu: (event: MouseEventOn<HTMLButtonElement>) => void }) {
  return <button title={`${props.item.schema}.${props.item.name}`} aria-selected={props.selected} style={{ '--stagger': String(props.stagger) }} class={`object-row ${props.active ? 'active' : ''} ${props.selected ? 'selected' : ''}`} onClick={props.onClick} onContextMenu={props.onContextMenu}>{props.item.type === 'view' ? <Eye size={14}/> : <Table size={14}/>}<span>{props.item.name}</span><small>{props.countLoading ? <i class="row-count-skeleton" aria-label="Loading row count"/> : props.item.rows >= 0 ? props.item.rows.toLocaleString() : '—'}</small></button>
}

function ContextMenu(props: { x: number; y: number; label: string; actions: ContextMenuAction[]; onClose: () => void }) {
  let menu!: HTMLDivElement
  const left = () => Math.max(8, Math.min(props.x, window.innerWidth - 216))
  const top = () => Math.max(42, Math.min(props.y, window.innerHeight - props.actions.length * 35 - 18))

  createEffect(on(() => [props.x, props.y] as const, () => {
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }))

  onMount(() => {
    const pointer = (event: PointerEvent) => { if (!menu?.contains(event.target as Node)) props.onClose() }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); props.onClose(); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const direction = event.key === 'ArrowDown' ? 1 : -1
      items[(current + direction + items.length) % items.length]?.focus()
    }
    const close = () => props.onClose()
    document.addEventListener('pointerdown', pointer)
    window.addEventListener('keydown', keyboard)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    onCleanup(() => {
      document.removeEventListener('pointerdown', pointer)
      window.removeEventListener('keydown', keyboard)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    })
  })

  return <div ref={menu} class="context-menu" role="menu" aria-label={props.label} style={{ left: `${left()}px`, top: `${top()}px` }}>
    <For each={props.actions}>{action => <button role="menuitem" class={`${action.separator ? 'separator' : ''} ${action.danger ? 'danger' : ''}`} onClick={() => { props.onClose(); action.run() }}>{action.icon}<span>{action.label}</span></button>}</For>
  </div>
}

function SidebarSkeleton() {
  return <div class="sidebar-skeleton" role="status" aria-label="Loading database objects">
    <i class="skeleton-line heading"/>
    <Index each={[72, 88, 64, 80, 58]}>{width => <i class="skeleton-line row" style={{ width: `${width()}%` }}/>}</Index>
    <i class="skeleton-line heading short"/>
    <Index each={[68, 82]}>{width => <i class="skeleton-line row" style={{ width: `${width()}%` }}/>}</Index>
  </div>
}

function WorkspaceSkeleton() {
  const widths = [44, 160, 200, 150, 180]
  return <div class="workspace-skeleton" role="status" aria-label="Loading database">
    <div class="skeleton-header"><span><i/><i/></span><i/></div>
    <div class="skeleton-toolbar"><i/><i/><span/><i/></div>
    <div class="skeleton-grid">
      <div><Index each={widths}>{width => <i style={{ width: `${width()}px` }}/>}</Index></div>
      <Index each={Array.from({ length: 7 }, (_, row) => row)}>{row => <div><Index each={widths}>{(width, column) => <i style={{ width: `${width() - 24 - ((row() + column) % 3) * 18}px` }}/>}</Index></div>}</Index>
    </div>
  </div>
}

function TableLoadError(props: { message: string; onRetry: () => void }) {
  return <div class="table-load-error" role="alert">
    <span><Alert size={22}/></span>
    <h3>Could not load this table</h3>
    <p>{props.message}</p>
    <button class="secondary" onClick={props.onRetry}><Refresh size={14}/> Try again</button>
  </div>
}

function SchemaView(props: { schema: ColumnInfo[]; indexes: IndexInfo[]; error: string }) {
  return <div class="schema-wrap structure-wrap">
    <Show when={props.error}><div class="structure-error" role="alert"><Alert size={15}/><span>{props.error}</span></div></Show>
    <section class="structure-section">
      <header><h3>Columns</h3><span>{props.schema.length}</span></header>
      <table class="schema-table"><thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>Key</th></tr></thead><tbody><For each={props.schema}>{(column, index) => <tr style={{ '--stagger': String(index()) }}><td><span class="field-icon">{column.primaryKey ? <Key size={13}/> : <Columns size={13}/>}</span><b>{column.name}</b></td><td><code>{column.type || 'ANY'}</code></td><td>{column.nullable ? 'YES' : 'NO'}</td><td>{column.default === null ? <span class="muted">—</span> : String(column.default)}</td><td>{column.primaryKey ? <span class="primary-key"><Key size={12}/> PRIMARY</span> : <span class="muted">—</span>}</td></tr>}</For></tbody></table>
    </section>
    <section class="structure-section indexes-section">
      <header><h3>Indexes</h3><span>{props.indexes.length}</span></header>
      <Show when={props.indexes.length} fallback={<div class="empty-indexes"><Key size={17}/><span>No indexes</span></div>}>
        <table class="schema-table indexes-table"><thead><tr><th>Name</th><th>Columns / Expressions</th><th>Type</th><th>Properties</th></tr></thead><tbody><For each={props.indexes}>{(index, position) => <tr style={{ '--stagger': String(position()) }}><td><span class="field-icon"><Key size={13}/></span><b>{index.name}</b></td><td><code>{index.columns.join(', ') || '—'}</code></td><td>{index.type || '—'}</td><td><div class="index-properties"><Show when={index.primary}><span class="primary">PRIMARY</span></Show><Show when={index.unique}><span class="unique">UNIQUE</span></Show><Show when={index.partial}><span>PARTIAL</span></Show><Show when={!index.primary && !index.unique && !index.partial}><span>INDEX</span></Show></div></td></tr>}</For></tbody></table>
      </Show>
    </section>
  </div>
}

type ScriptBuffer = { text: string; saved: string; result: QueryResult | null; running: boolean }

/**
 * ScriptPanel is the whole editing surface for one script: its own header with
 * the actions, the editor, and the results of its last run underneath. The run
 * button lives beside save because both act on this script, and it needs to know
 * what a run would cover, which is why the editor reports its run list up.
 */
function ScriptPanel(props: {
  name: string
  text: string
  dirty: boolean
  result: QueryResult | null
  running: boolean
  tables: CompletionTable[]
  onNeedColumns: (table: string) => void
  onInput: (value: string) => void
  onRun: (statements: string[]) => void
  onSave: () => void
  onClose: () => void
}) {
  const [runList, setRunList] = createSignal<SqlStatement[]>([])
  const label = () => props.name ? props.name.replace(/\.sql$/i, '') : 'Query'
  const runLabel = () => props.running ? 'Running…' : runList().length > 1 ? `Run ${runList().length}` : 'Run'
  const run = () => props.onRun(runList().map(statement => statement.body))

  return <div class="script-panel">
    <header class="script-panel-head">
      <div class="script-title"><Code size={15}/><b>{label()}</b><Show when={props.dirty}><i class="script-dirty" title="Unsaved changes"/></Show><span>Read-only</span></div>
      <div class="script-panel-actions">
        <Show when={props.name}><button class="secondary" disabled={!props.dirty} onClick={props.onSave}><Save size={14}/> Save<kbd>Ctrl S</kbd></button></Show>
        <button class="primary" disabled={props.running || !runList().length} onClick={run}><Play size={14}/> {runLabel()}<kbd>⌘ ↵</kbd></button>
        <button class="icon-button" onClick={props.onClose} aria-label="Close script"><X size={15}/></button>
      </div>
    </header>
    <div class="script-body">
      <SqlEditor value={props.text} running={props.running} tables={props.tables} onNeedColumns={props.onNeedColumns} onInput={props.onInput} onRun={props.onRun} onRunListChange={setRunList} onSave={props.name ? props.onSave : undefined}/>
      <Show when={props.result} fallback={<section class="script-results empty"><div class="result-placeholder"><Play size={20}/><span>Run a statement to see its rows</span></div></section>}>{result =>
        <section class="script-results">
          <div class="result-meta"><Check size={13}/>{result().message}<span>{result().durationMs} ms</span></div>
          <DataGrid data={result()} compact/>
        </section>
      }</Show>
    </div>
  </div>
}

type TransferState = { preview: TransferPreview; tables: TableRef[]; format: 'csv' | 'json'; conflict: 'abort' | 'skip' }

function TransferModal(props: {
  state: TransferState
  busy: boolean
  onChange: (next: TransferState) => void
  onClose: () => void
  onRun: () => void
}) {
  const preview = () => props.state.preview
  const first = () => preview().tables[0]
  const incompatible = () => preview().kind === 'import' && Boolean(first()?.extraColumns?.length || first()?.requiredMissing?.length)
  const title = () => { const kind = preview().kind; return kind === 'backup' ? 'Back up database' : kind === 'restore' ? 'Restore database' : kind === 'export' ? `Export ${preview().tables.length === 1 ? 'table' : 'tables'}` : 'Import table' }
  const action = () => { const kind = preview().kind; return kind === 'backup' ? 'Choose location & back up' : kind === 'restore' ? 'Restore database' : kind === 'export' ? 'Choose location & export' : 'Import data' }

  onMount(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !props.busy) props.onClose() }
    window.addEventListener('keydown', close)
    onCleanup(() => window.removeEventListener('keydown', close))
  })

  return <div class="modal-backdrop transfer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !props.busy) props.onClose() }}>
    <section class="transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
      <header><div class={`modal-mark ${preview().kind === 'restore' || preview().kind === 'import' ? 'warning' : ''}`}>{preview().kind === 'backup' ? <Save size={18}/> : preview().kind === 'restore' ? <Refresh size={18}/> : preview().kind === 'export' ? <File size={18}/> : <Plus size={18}/>}</div><div><h3 id="transfer-title">{title()}</h3><p>{preview().database} · {preview().driver}</p></div><button class="icon-button" disabled={props.busy} onClick={props.onClose} aria-label="Close transfer preview"><X size={16}/></button></header>
      <div class="transfer-content">
        <Show when={preview().path}><div class="transfer-path"><File size={14}/><span title={preview().path}>{preview().path}</span></div></Show>
        <div class="transfer-summary"><span><b>{preview().tables.length.toLocaleString()}</b> tables</span><span><b>{preview().tables.reduce((total, table) => total + table.rows, 0).toLocaleString()}</b> rows</span><Show when={preview().format}><span><b>{preview().format.toUpperCase()}</b> format</span></Show></div>
        <Show when={preview().skipped?.length}>
          <section class="transfer-skipped" role="alert">
            <header><Alert size={14}/><b>{preview().skipped!.length} {preview().skipped!.length === 1 ? 'object is' : 'objects are'} not included in this backup</b></header>
            <For each={preview().skipped}>{item => <div><code>{item.schema}.{item.name}</code><small>{item.reason}</small></div>}</For>
          </section>
        </Show>
        <Show when={preview().kind === 'backup'}><div class="transfer-note"><Alert size={14}/><span>Data streams into a <code>.pqnb</code> pending file with checkpoints. It becomes <code>.qnb</code> only after a complete, durable write.</span></div></Show>
        <Show when={preview().kind === 'restore'}><div class="transfer-note danger"><Alert size={14}/><span>Rows in the archived tables will be replaced. This operation runs in one transaction and cannot be undone.</span></div></Show>
        <Show when={preview().kind === 'export'}><section class="transfer-options"><b>Export format</b><div><button class={props.state.format === 'csv' ? 'active' : ''} disabled={preview().tables.length > 1} onClick={() => props.onChange({ ...props.state, format: 'csv' })}>CSV</button><button class={props.state.format === 'json' ? 'active' : ''} onClick={() => props.onChange({ ...props.state, format: 'json' })}>JSON</button></div><Show when={preview().tables.length > 1}><small>Multiple tables are exported as one JSON bundle.</small></Show></section></Show>
        <Show when={preview().kind === 'import'}><section class="transfer-options"><b>When a key conflicts</b><div><button class={props.state.conflict === 'abort' ? 'active' : ''} onClick={() => props.onChange({ ...props.state, conflict: 'abort' })}>Abort import</button><button class={props.state.conflict === 'skip' ? 'active' : ''} onClick={() => props.onChange({ ...props.state, conflict: 'skip' })}>Skip row</button></div></section></Show>
        <section class="transfer-tables"><header><b>Column preview</b><span>{preview().tables.length > 100 ? `First 100 of ${preview().tables.length.toLocaleString()}` : `${preview().tables.length} table${preview().tables.length === 1 ? '' : 's'}`}</span></header>
          <For each={preview().tables.slice(0, 100)}>{table => <div class="transfer-table"><div><Table size={14}/><b>{table.schema}.{table.name}</b><span>{table.rows.toLocaleString()} rows</span></div><div class="transfer-columns"><For each={table.columns}>{column => <code class={table.extraColumns?.includes(column) ? 'extra' : ''}>{column}</code>}</For></div><Show when={table.missingColumns?.length}><small class={table.requiredMissing?.length ? 'invalid' : ''}>Missing target columns: {table.missingColumns.join(', ')}</small></Show></div>}</For>
        </section>
        <Show when={first()?.sampleRows?.length}><div class="transfer-sample"><table><thead><tr><For each={first().columns}>{column => <th>{column}</th>}</For></tr></thead><tbody><For each={first().sampleRows}>{row => <tr><Index each={first().columns}>{(_column, columnIndex) => <td>{String((row as unknown[])[columnIndex] ?? 'NULL')}</td>}</Index></tr>}</For></tbody></table></div></Show>
        <Show when={incompatible()}><div class="transfer-validation" role="alert"><Alert size={14}/><span>Fix the source columns before importing. Extra columns and missing required columns cannot be imported safely.</span></div></Show>
      </div>
      <footer><button class="secondary" disabled={props.busy} onClick={props.onClose}>Cancel</button><button class={`primary ${preview().kind === 'restore' ? 'danger-primary' : ''}`} disabled={props.busy || incompatible() || !preview().tables.length} onClick={props.onRun}><Show when={props.busy}><Refresh size={14} class="spin"/></Show>{props.busy ? 'Working…' : action()}</button></footer>
    </section>
  </div>
}

function DangerConfirmModal(props: { title: string; message: string; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return <div class="modal-backdrop transfer-backdrop"><section class="danger-confirm-modal" role="alertdialog" aria-modal="true"><div class="danger-confirm-icon"><Trash size={21}/></div><h3>{props.title}</h3><p>{props.message}</p><footer><button class="secondary" disabled={props.busy} onClick={props.onClose}>Cancel</button><button class="danger-button" disabled={props.busy} onClick={props.onConfirm}>{props.busy ? 'Working…' : 'Truncate'}</button></footer></section></div>
}

function OperationToast(props: { message: string; onClose: () => void }) {
  createEffect(on(() => props.message, () => {
    const timer = window.setTimeout(props.onClose, 7000)
    onCleanup(() => window.clearTimeout(timer))
  }))
  return <div class="operation-toast" role="status"><Check size={16}/><span>{props.message}</span><button onClick={props.onClose} aria-label="Dismiss notification"><X size={13}/></button></div>
}

function UnsavedModal(props: { title: string; message: string; count: number; onCancel: () => void; onDiscard: () => Promise<void>; onSave: () => Promise<void> }) {
  const [busy, setBusy] = createSignal(false)
  const run = async (action: () => Promise<void>) => { setBusy(true); try { await action() } finally { setBusy(false) } }
  return <div class="modal-backdrop unsaved-backdrop">
    <section class="unsaved-modal" role="alertdialog" aria-modal="true">
      <div class="unsaved-icon"><Alert size={21}/></div>
      <h3>{props.title}</h3>
      <p>{props.message}</p>
      <div class="pending-summary"><span>{props.count}</span> pending change{props.count === 1 ? '' : 's'}</div>
      <footer><button class="secondary" disabled={busy()} onClick={props.onCancel}>Cancel</button><button class="discard-button" disabled={busy()} onClick={() => void run(props.onDiscard)}>Discard changes</button><button class="primary" disabled={busy()} onClick={() => void run(props.onSave)}><Save size={14}/> Save & continue</button></footer>
    </section>
  </div>
}

function ConnectionFailureModal(props: { session: WorkspaceSession; onEdit: () => void; onClose: () => void }) {
  const switchingDatabase = () => Boolean(props.session.retryDatabase)
  return <div class="modal-backdrop connection-failure-backdrop">
    <section class="connection-failure-modal" role="alertdialog" aria-modal="true" aria-labelledby="connection-failure-title" aria-describedby="connection-failure-copy">
      <div class="connection-failure-icon"><Alert size={23}/></div>
      <h3 id="connection-failure-title">Connection failed</h3>
      <p id="connection-failure-copy">QueryNest couldn’t open <b>{switchingDatabase() ? props.session.database : props.session.name}</b>. {switchingDatabase() ? 'Try opening this database again, or close this workspace.' : 'Edit its connection details and try again, or close this workspace.'}</p>
      <div class="failed-connection-summary"><span class={`kind-logo ${props.session.driver === 'PostgreSQL' ? 'postgres' : 'sqlite'}`}>{props.session.driver === 'PostgreSQL' ? 'PG' : 'SQ'}</span><span><b>{props.session.name}</b><small>{props.session.path}</small></span></div>
      <footer><button class="secondary" onClick={props.onClose}>Close connection</button><button class="primary" onClick={props.onEdit}>{switchingDatabase() ? <Refresh size={15}/> : <Settings size={15}/>} {switchingDatabase() ? 'Try again' : 'Edit connection'}</button></footer>
    </section>
  </div>
}

const SSL_MODE_OPTIONS: { value: PostgresConfig['sslMode']; label: string; description: string }[] = [
  { value: 'prefer', label: 'Prefer', description: 'Use SSL when available' },
  { value: 'require', label: 'Require', description: 'Require an encrypted connection' },
  { value: 'verify-ca', label: 'Verify CA', description: 'Verify the certificate authority' },
  { value: 'verify-full', label: 'Verify full', description: 'Verify CA and hostname' },
  { value: 'disable', label: 'Disable', description: 'Connect without SSL' },
  { value: 'allow', label: 'Allow', description: 'Try without SSL first' },
]

function CustomSelect(props: {
  value: string
  options: { value: string; label: string; description?: string }[]
  disabled?: boolean
  label: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  let root!: HTMLDivElement
  let trigger!: HTMLButtonElement
  const selected = () => props.options.find(option => option.value === props.value) ?? props.options[0]

  createEffect(() => {
    if (!open()) return
    const closeOutside = (event: MouseEvent) => { if (!root?.contains(event.target as Node)) setOpen(false) }
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger?.focus() }
    }
    document.addEventListener('mousedown', closeOutside)
    window.addEventListener('keydown', closeWithEscape)
    onCleanup(() => { document.removeEventListener('mousedown', closeOutside); window.removeEventListener('keydown', closeWithEscape) })
  })

  function moveFocus(current: HTMLButtonElement, direction: number) {
    const items = Array.from(root?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const index = items.indexOf(current)
    items[(index + direction + items.length) % items.length]?.focus()
  }

  return <div ref={root} class={`custom-select ${open() ? 'open' : ''}`}>
    <button ref={trigger} type="button" class="custom-select-trigger" disabled={props.disabled} aria-label={`${props.label}: ${selected()?.label ?? props.value}`} aria-haspopup="listbox" aria-expanded={open()} onClick={() => setOpen(current => !current)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => root?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus()) }
    }}><span>{selected()?.label}</span><ChevronDown size={14}/></button>
    <Show when={open()}><div class="custom-select-menu" role="listbox" aria-label={props.label}>
      <For each={props.options}>{option => <button type="button" role="option" aria-selected={option.value === props.value} onClick={() => { props.onChange(option.value); setOpen(false); trigger?.focus() }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(event.currentTarget, 1) }
        if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(event.currentTarget, -1) }
      }}><span><b>{option.label}</b><Show when={option.description}><small>{option.description}</small></Show></span><Show when={option.value === props.value}><Check size={14}/></Show></button>}</For>
    </div></Show>
  </div>
}

function ConnectionModal(props: SavedConnectionsProps & { config: PostgresConfig; setConfig: Setter<PostgresConfig>; onSQLite: () => void; onPostgres: (config: PostgresConfig) => Promise<void>; onError: (message: string) => void; onClose: () => void }) {
  const [submitting, setSubmitting] = createSignal(false)
  const [testing, setTesting] = createSignal(false)
  const [success, setSuccess] = createSignal('')
  const pending = () => props.busy || submitting() || testing()
  const update = <K extends keyof PostgresConfig>(key: K, value: PostgresConfig[K]) => props.setConfig(current => ({ ...current, [key]: value }))

  createEffect(on(() => props.config, () => setSuccess('')))

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (pending()) return
    const isTest = event.submitter?.getAttribute('value') === 'test'
    setSuccess('')
    if (isTest) setTesting(true)
    else setSubmitting(true)
    try {
      if (isTest) {
        await api().TestPostgresConnection(props.config)
        setSuccess('Connection successful. Ready to connect.')
      } else await props.onPostgres(props.config)
    } catch (e) { props.onError(String(e).replace(/^Error:\s*/i, '')) }
    finally { setSubmitting(false); setTesting(false) }
  }

  return <div class="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending()) props.onClose() }}>
    <section class="connection-modal" role="dialog" aria-modal="true" aria-label="New database connection">
      <header><div class="modal-mark"><Database size={19}/></div><div><h3>New connection</h3><p>Connect securely to your database</p></div><button class="icon-button" aria-label="Close connection form" disabled={pending()} onClick={props.onClose}><X size={17}/></button></header>
      <SavedConnections saved={props.saved} busy={pending()} onSaved={props.onSaved} onEdit={props.onEdit} onRemove={props.onRemove}/>
      <div class="connection-kinds">
        <button class="kind-card" onClick={props.onSQLite} disabled={pending()}><span class="kind-logo sqlite">SQ</span><span><b>SQLite</b><small>Open a local database file</small></span><ChevronRight size={15}/></button>
        <div class="kind-card active"><span class="kind-logo postgres">PG</span><span><b>PostgreSQL</b><small>Host and credentials</small></span><Check size={15}/></div>
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={pending()}>
        <div class="form-grid">
          <label class="span-2"><span>Connection name</span><input required value={props.config.name} onInput={e => update('name', e.currentTarget.value)} placeholder="Production database"/></label>
          <label class="span-2"><span>Host</span><input required value={props.config.host} onInput={e => update('host', e.currentTarget.value)} placeholder="localhost" ref={el => queueMicrotask(() => el.focus())}/></label>
          <label><span>Port</span><input required type="number" min={1} max={65535} value={props.config.port} onInput={e => update('port', Number(e.currentTarget.value))}/></label>
          <div class="form-field"><span>SSL mode</span><CustomSelect label="SSL mode" value={props.config.sslMode} options={SSL_MODE_OPTIONS} disabled={pending()} onChange={value => update('sslMode', value as PostgresConfig['sslMode'])}/></div>
          <label class="span-2"><span>Database</span><input required value={props.config.database} onInput={e => update('database', e.currentTarget.value)} placeholder="postgres"/></label>
          <label><span>User</span><input required value={props.config.user} onInput={e => update('user', e.currentTarget.value)} placeholder="postgres" autocomplete="username"/></label>
          <label><span>Password</span><input type="password" value={props.config.password} onInput={e => update('password', e.currentTarget.value)} placeholder="Optional" autocomplete="current-password"/></label>
        </div>
        <div class="connection-options"><label><input type="checkbox" checked={props.config.saveConnection} onChange={e => update('saveConnection', e.currentTarget.checked)}/><span>Save connection</span></label><label class={!props.config.saveConnection ? 'disabled' : ''}><input type="checkbox" checked={props.config.savePassword} disabled={!props.config.saveConnection} onChange={e => update('savePassword', e.currentTarget.checked)}/><span>Save password securely</span></label><label><input type="checkbox" checked={props.config.readOnly} onChange={e => update('readOnly', e.currentTarget.checked)}/><span>Read-only</span></label></div>
        </fieldset>
        <Show when={success()}><div class="connection-feedback success" role="status"><Check size={15}/><span>{success()}</span></div></Show>
        <footer><button type="button" class="secondary" onClick={props.onClose} disabled={pending()}>Cancel</button><button type="submit" name="action" value="connect" class="primary" disabled={pending()}>{submitting() ? <Refresh size={15} class="spin"/> : <Database size={15}/>} {submitting() ? 'Connecting…' : 'Connect'}</button><button type="submit" name="action" value="test" class="secondary test-connection" disabled={pending()}>{testing() ? <Refresh size={15} class="spin"/> : <Play size={15}/>} {testing() ? 'Testing…' : 'Test connection'}</button></footer>
      </form>
    </section>
  </div>
}

function SavedConnectionEditModal(props: {
  profile: SavedConnection
  busy: boolean
  onSave: (profile: SavedConnectionUpdate) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = createSignal<SavedConnectionUpdate>({ ...props.profile, password: '', savePassword: props.profile.hasPassword })
  const [saving, setSaving] = createSignal(false)
  const pending = () => props.busy || saving()
  const update = <K extends keyof SavedConnectionUpdate>(key: K, value: SavedConnectionUpdate[K]) => setDraft(current => ({ ...current, [key]: value }))

  onMount(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending()) props.onClose() }
    window.addEventListener('keydown', close)
    onCleanup(() => window.removeEventListener('keydown', close))
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (pending()) return
    setSaving(true)
    try { await props.onSave(draft()) }
    finally { setSaving(false) }
  }

  const postgres = () => props.profile.driver === 'PostgreSQL'
  return <div class="modal-backdrop saved-editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending()) props.onClose() }}>
    <section class="connection-modal saved-editor-modal" role="dialog" aria-modal="true" aria-labelledby="saved-editor-title">
      <header><div class="modal-mark"><Edit size={18}/></div><div><h3 id="saved-editor-title">Edit saved connection</h3><p>{postgres() ? 'Update PostgreSQL connection details' : 'Update SQLite connection details'}</p></div><button class="icon-button" aria-label="Close saved connection editor" disabled={pending()} onClick={props.onClose}><X size={17}/></button></header>
      <form onSubmit={submit}>
        <fieldset disabled={pending()}>
          <div class="saved-editor-summary"><span class={`kind-logo ${postgres() ? 'postgres' : 'sqlite'}`}>{postgres() ? 'PG' : 'SQ'}</span><span><b>{props.profile.name}</b><small>{props.profile.driver}</small></span><Show when={props.profile.hasPassword}><span class={`saved-password-note ${draft().savePassword ? '' : 'remove'}`}><Key size={13}/> {draft().savePassword ? 'Password stays in system storage' : 'Saved password will be removed'}</span></Show></div>
          <div class="form-grid">
            <label class="span-2"><span>Connection name</span><input required value={draft().name} onInput={event => update('name', event.currentTarget.value)} ref={el => queueMicrotask(() => el.focus())}/></label>
            <Show when={postgres()} fallback={<label class="span-2"><span>Database file</span><input required value={draft().path ?? ''} onInput={event => update('path', event.currentTarget.value)}/></label>}>
              <label class="span-2"><span>Host</span><input required value={draft().host ?? ''} onInput={event => update('host', event.currentTarget.value)}/></label>
              <label><span>Port</span><input required type="number" min={1} max={65535} value={draft().port ?? 5432} onInput={event => update('port', Number(event.currentTarget.value))}/></label>
              <div class="form-field"><span>SSL mode</span><CustomSelect label="SSL mode" value={draft().sslMode ?? 'prefer'} options={SSL_MODE_OPTIONS} disabled={pending()} onChange={value => update('sslMode', value)}/></div>
              <label class="span-2"><span>Database</span><input required value={draft().database ?? ''} onInput={event => update('database', event.currentTarget.value)}/></label>
              <label><span>User</span><input required value={draft().user ?? ''} onInput={event => update('user', event.currentTarget.value)}/></label>
              <label><span>Password</span><input type="password" value={draft().password ?? ''} disabled={!draft().savePassword} onInput={event => update('password', event.currentTarget.value)} placeholder={props.profile.hasPassword ? 'Leave blank to keep current' : 'Optional'} autocomplete="new-password"/></label>
            </Show>
          </div>
          <Show when={postgres()}><div class="connection-options"><label><input type="checkbox" checked={draft().savePassword} onChange={event => update('savePassword', event.currentTarget.checked)}/><span>Save password securely</span></label><label><input type="checkbox" checked={draft().readOnly} onChange={event => update('readOnly', event.currentTarget.checked)}/><span>Read-only</span></label></div></Show>
        </fieldset>
        <footer><button type="button" class="secondary" onClick={props.onClose} disabled={pending()}>Cancel</button><button type="submit" class="primary" disabled={pending()}>{saving() ? <Refresh size={15} class="spin"/> : <Save size={15}/>} {saving() ? 'Saving…' : 'Save changes'}</button></footer>
      </form>
    </section>
  </div>
}

function Toast(props: { message: string; onClose: () => void }) {
  const clean = () => props.message.replace(/^Error:\s*/i, '')
  createEffect(on(clean, () => {
    const timer = window.setTimeout(props.onClose, 12000)
    onCleanup(() => window.clearTimeout(timer))
  }))
  return <div class="toast" role="alert"><Alert size={17}/><span title={clean()}>{clean()}</span><button onClick={props.onClose} aria-label="Dismiss error"><X size={14}/></button></div>
}
