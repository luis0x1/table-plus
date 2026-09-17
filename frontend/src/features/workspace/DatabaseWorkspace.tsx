import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  type JSX,
} from 'solid-js'
import { createStore, produce, unwrap } from 'solid-js/store'
import { api, databaseApi, isDesktop, windowAction } from '../../lib/backend/bridge'
import TabStrip from '../../components/navigation/TabStrip'
import DatabasePicker from '../connections/DatabasePicker'
import DataGrid, { buildDraftGrid, type PendingOperation } from '../data-grid/DataGrid'
import type { EditorSelection } from '../sql-editor/SqlEditor'
import {
  pageQuery,
  planPagination,
  type CompletionTable,
  type PaginationPlan,
  type SqlStatement,
} from '../sql-editor/sql'
import type { SidebarSizing } from '../../components/layout/SidebarResizeHandle'
import SidebarResizeHandle from '../../components/layout/SidebarResizeHandle'
import Toast from '../../components/feedback/Toast'
import { DangerConfirmModal, OperationToast, UnsavedModal } from '../../components/feedback/OperationFeedback'
import ScriptPanel, { newScriptBuffer, type ScriptBuffer } from '../scripts/ScriptPanel'
import TransferModal, { type TransferState } from '../transfer/TransferModal'
import {
  ContextMenu,
  ObjectGroup,
  ObjectRow,
  SchemaView,
  SidebarSkeleton,
  TableLoadError,
  WorkspaceSkeleton,
  type ContextMenuAction,
  type MouseEventOn,
} from './WorkspaceViews'
import type {
  ColumnInfo,
  ConnectionStatus,
  EditingPreferences,
  IndexInfo,
  QueryResult,
  SavedConnection,
  ScriptFile,
  TableData,
  TableRef,
  TableSummary,
  TransferPreferences,
  TransferPreview,
  TransferResult,
} from '../../types'
import {
  Alert,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code,
  Columns,
  Command,
  Copy,
  Database,
  Edit,
  Eye,
  File,
  Filter,
  Key,
  More,
  PanelLeft,
  Pending,
  Pin,
  Play,
  Plus,
  Redo,
  Refresh,
  Save,
  Search,
  Table,
  Trash,
  Undo,
  X,
} from '../../components/ui/icons'
import QuickPagePicker from '../../components/navigation/QuickPagePicker'

const SqlEditor = lazy(() => import('../sql-editor/SqlEditor'))
const emptyData = (): TableData => ({ columns: [], rows: [], total: 0, durationMs: 0 })
const PAGE_SIZE = 50
const ROW_COUNT_CONCURRENCY = 3
const MAX_NAVIGABLE_PAGES = 99_999
// Query results page at a coarser size than table browsing: a result set is
// usually read in bulk, and the backend caps a single read at 1000 rows anyway.
const SCRIPT_PAGE_SIZE = 100
const qualifiedKey = (schema: string, name: string) => `${schema}\u0000${name}`
const tableKey = (item: TableSummary) => qualifiedKey(item.schema, item.name)
type DraftHistory = { past: PendingOperation[][]; present: PendingOperation[]; future: PendingOperation[][] }
type ContextMenuState = { kind: 'database' | 'table' | 'tab' | 'script'; key: string; x: number; y: number }
export type WorkspaceSession = ConnectionStatus & {
  connectionState?: 'connecting' | 'failed'
  profile?: SavedConnection
  returnToID?: string
  retryDatabase?: { sourceID: string; database: string }
}
export type DatabaseActivity = {
  id: string
  sessionID: string
  database: string
  source: 'script' | 'database'
  statement: string
  status: 'queued' | 'running' | 'cancelling'
  startedAt: number
}
export type ActivityController = {
  enqueue: (activity: Omit<DatabaseActivity, 'id' | 'status' | 'startedAt'>) => string
  start: (id: string) => void
  finish: (id: string) => void
  cancelled: (id: string) => boolean
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

const tableRequestKey = (state: Pick<TableTabState, 'page' | 'filter' | 'sortColumn' | 'sortDirection'>) =>
  JSON.stringify([state.page, state.filter, state.sortColumn, state.sortDirection])

function tableLoadError(error: unknown) {
  const message = String(error)
  const missingModule = message.match(/no such module:\s*([^\s(]+)/i)?.[1]
  if (missingModule)
    return `This virtual table requires the SQLite module ${missingModule}, which is not available in this build.`
  return message
}

export type WorkspaceHandle = { beforeLeave: (run: () => void | Promise<void>) => void }

export function ConnectionSkeleton(props: { session: WorkspaceSession; active: boolean; tableSidebar: SidebarSizing }) {
  const failed = () => props.session.connectionState === 'failed'
  return (
    <div
      class={`database-workspace connection-skeleton ${failed() ? 'failed' : ''}`}
      hidden={!props.active}
      aria-busy={!failed()}
    >
      <div class="workspace">
        <aside
          class="sidebar"
          style={{ width: `${props.tableSidebar.width()}px`, 'flex-basis': `${props.tableSidebar.width()}px` }}
        >
          <div class="connection-card skeleton-connection-card">
            <span class={`db-avatar ${props.session.driver === 'PostgreSQL' ? 'postgres' : ''}`}>
              {props.session.driver === 'PostgreSQL' ? 'PG' : 'SQ'}
            </span>
            <span class="connection-text">
              <b>{props.session.name}</b>
              <small>{failed() ? 'Connection failed' : 'Connecting…'}</small>
            </span>
            {failed() ? <Alert size={16} /> : <Refresh size={16} class="spin" />}
          </div>
          <div class="skeleton-sidebar-lines" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </aside>
        <section class="main-panel">
          <div class="top-tabs">
            <div class="skeleton-block skeleton-tab" />
          </div>
          <div class="skeleton-main" role="status" aria-live="polite">
            <div class="skeleton-heading">
              <div class="skeleton-block" />
              <div class="skeleton-block" />
            </div>
            <div class="skeleton-toolbar">
              <div class="skeleton-block" />
              <div class="skeleton-block" />
              <div class="skeleton-block" />
            </div>
            <div class="skeleton-table" aria-hidden="true">
              <Index each={Array.from({ length: 8 })}>
                {() => (
                  <div>
                    <Index each={Array.from({ length: 5 })}>{() => <i class="skeleton-block" />}</Index>
                  </div>
                )}
              </Index>
            </div>
            <span class="sr-only">
              {failed() ? `Could not connect to ${props.session.name}` : `Connecting to ${props.session.name}`}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}

export default function DatabaseWorkspace(props: {
  status: ConnectionStatus
  active: boolean
  blocked: boolean
  tableSidebar: SidebarSizing
  transferPreferences: TransferPreferences
  editingPreferences: EditingPreferences
  activity: ActivityController
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
  const [confirmAction, setConfirmAction] = createSignal<{
    title: string
    message: string
    run: () => Promise<void>
  } | null>(null)
  const closeContextMenu = () => setContextMenu(null)
  const [sidebarFilter, setSidebarFilter] = createSignal('')
  const [pane, setPane] = createSignal<'data' | 'scripts'>('data')
  const [scripts, setScripts] = createSignal<ScriptFile[]>([])
  const [scriptsLoading, setScriptsLoading] = createSignal(true)
  const [scriptWorkspace, setScriptWorkspace] = createSignal('')
  const [activeScript, setActiveScript] = createSignal('')
  const [openScripts, setOpenScripts] = createSignal<string[]>([])
  const [activePane, setActivePane] = createSignal<'table' | 'script'>('table')
  const [editorFocusNonce, setEditorFocusNonce] = createSignal(0)
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
  const [guardedAction, setGuardedAction] = createSignal<{
    table: string
    tables?: string[]
    title: string
    message: string
    run: () => void | Promise<void>
  } | null>(null)
  let sidebarSearch!: HTMLInputElement
  let rowCountGeneration = 0

  createEffect(() => {
    if (!props.active || props.blocked) setContextMenu(null)
  })

  const draftFor = (key: string) => draftsByTable[key] ?? { past: [], present: [], future: [] }
  const draftOperations = (key: string) => draftsByTable[key]?.present ?? []

  function updateTabState(key: string, change: (state: TableTabState) => TableTabState) {
    if (!key) return
    setTabStates(key, (previous) => change(previous ?? newTableTabState()))
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
          setTables((current) => current.map((value) => (tableKey(value) === key ? { ...value, rows } : value)))
        } catch {
          /* A failed count remains unavailable without blocking table browsing. */
        } finally {
          if (generation === rowCountGeneration)
            setCountingTables((current) => {
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
    const next = ((await db.ListTables()) ?? []).map((item) => ({ ...item, rows: -1 }))
    setTables(next)
    loadRowCounts(next)
  }

  onMount(() => {
    let cancelled = false
    onCleanup(() => {
      cancelled = true
      rowCountGeneration += 1
    })
    db.ListTables()
      .then((next) => {
        if (cancelled) return
        const items = (next ?? []).map((item) => ({ ...item, rows: -1 }))
        setTables(items)
        loadRowCounts(items)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false)
      })
  })

  // A tab owns its rows, schema and indexes. Re-entering an already-loaded tab must not
  // query again unless one of its request inputs changed or it was explicitly invalidated.
  // Dependencies are listed explicitly: the body both reads and writes this tab's state,
  // so automatic tracking would re-trigger the effect from its own writes.
  createEffect(
    on(
      () =>
        [
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
        ] as const,
      () => {
        const key = activeTable()
        if (!key || !status.connected) return
        const selected = tables().find((item) => tableKey(item) === key)
        const state = tabStates[key]
        if (!selected || !state) return
        const requestKey = tableRequestKey(state)
        if (state.loadedRequest === requestKey && state.schemaLoaded && state.indexesLoaded) return
        const request = {
          page: state.page,
          filter: state.filter,
          sortColumn: state.sortColumn,
          sortDirection: state.sortDirection,
        }
        const cachedData = unwrap(state.data)
        const cachedSchema = unwrap(state.schema)
        const cachedIndexes = unwrap(state.indexes)
        const hadData = Boolean(state.loadedRequest)
        const hadSchema = state.schemaLoaded
        const hadIndexes = state.indexesLoaded
        const dataUsable = state.loadedRequest === requestKey
        let cancelled = false
        const timer = window.setTimeout(
          async () => {
            updateTabState(key, (current) => ({
              ...current,
              loading: true,
              loadError: '',
              structureError: '',
              data: hadData ? current.data : emptyData(),
              schema: hadSchema ? current.schema : [],
              indexes: hadIndexes ? current.indexes : [],
            }))
            const [dataResult, schemaResult, indexesResult] = await Promise.allSettled([
              dataUsable
                ? Promise.resolve(cachedData)
                : db.GetTableData(
                    selected.schema,
                    selected.name,
                    PAGE_SIZE,
                    request.page * PAGE_SIZE,
                    request.filter,
                    request.sortColumn,
                    request.sortDirection,
                  ),
              hadSchema ? Promise.resolve(cachedSchema) : db.GetTableSchema(selected.schema, selected.name),
              hadIndexes ? Promise.resolve(cachedIndexes) : db.GetTableIndexes(selected.schema, selected.name),
            ])
            if (cancelled) return
            const loadError = dataResult.status === 'rejected' ? tableLoadError(dataResult.reason) : ''
            const structureFailures = [schemaResult, indexesResult].filter(
              (result) => result.status === 'rejected',
            ) as PromiseRejectedResult[]
            const structureError = structureFailures.map((result) => tableLoadError(result.reason)).join('\n')
            updateTabState(key, (current) =>
              tableRequestKey(current) === requestKey
                ? {
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
                  }
                : current,
            )
          },
          request.filter ? 250 : 0,
        )
        onCleanup(() => {
          cancelled = true
          window.clearTimeout(timer)
        })
      },
    ),
  )

  function openTable(item: TableSummary, view?: TableTabState['view']) {
    const key = tableKey(item)
    batch(() => {
      setActiveTable(key)
      setTabs((current) => (current.includes(key) ? current : [...current, key]))
      if (!tabStates[key]) setTabStates(key, newTableTabState())
      if (view) setTabStates(key, 'view', view)
      setActivePane('table')
    })
  }

  function closeTabsNow(names: string[]) {
    const closing = new Set(names)
    batch(() => {
      const next = tabs().filter((tab) => !closing.has(tab))
      setTabs(next)
      if (closing.has(activeTable())) setActiveTable(next.at(-1) ?? '')
      setPinnedTabs((current) => new Set([...current].filter((tab) => !closing.has(tab))))
      setTabStates(
        produce((states) => {
          closing.forEach((name) => {
            delete states[name]
          })
        }),
      )
      setDraftsByTable(
        produce((drafts) => {
          closing.forEach((name) => {
            delete drafts[name]
          })
        }),
      )
    })
  }

  function closeTabNow(name: string) {
    closeTabsNow([name])
  }

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
      setTabs((current) => [
        ...current.filter((key) => nextPinned.has(key)),
        ...current.filter((key) => !nextPinned.has(key)),
      ])
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
    return tables()
      .filter((item) => item.type === 'table' && selected.has(tableKey(item)))
      .map((item) => ({ schema: item.schema, name: item.name }))
  }

  function selectTable(event: MouseEventOn<HTMLButtonElement>, item: TableSummary) {
    const key = tableKey(item)
    if (item.type === 'table' && event.shiftKey && selectionAnchor) {
      const items = tableItems()
      const start = items.findIndex((value) => tableKey(value) === selectionAnchor)
      const end = items.findIndex((value) => tableKey(value) === key)
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start]
        setSelectedTables(new Set(items.slice(from, to + 1).map(tableKey)))
        return
      }
    }
    if (item.type === 'table' && (event.ctrlKey || event.metaKey)) {
      setSelectedTables((current) => {
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

  async function openTransferPreview(
    load: () => Promise<TransferPreview>,
    refs: TableRef[],
    format: 'csv' | 'csv-raw' | 'json' = 'json',
  ) {
    setTransferBusy(true)
    setError('')
    try {
      const preview = await load()
      if (preview.kind === 'restore' && preview.driver !== status.driver)
        throw new Error(`This ${preview.driver} backup cannot be restored into ${status.driver}.`)
      if (preview.kind) setTransferDialog({ preview, tables: refs, format, conflict: 'abort', restoreCode: false })
    } catch (e) {
      setError(String(e))
    } finally {
      setTransferBusy(false)
    }
  }

  function startBackup() {
    void openTransferPreview(() => db.PreviewDatabaseBackup(), [])
  }

  function startRestore() {
    if (status.readOnly) return
    guardWorkspace(
      'Restore this database?',
      'Restoring can replace schema and data. Save or discard local drafts first.',
      () => {
        void openTransferPreview(() => db.ChooseRestoreBackup(), [])
      },
    )
  }

  function startExport(refs: TableRef[]) {
    void openTransferPreview(() => db.PreviewTableExport(refs), refs, refs.length === 1 ? 'csv' : 'json')
  }

  function startImport(ref: TableRef) {
    if (status.readOnly) return
    guardUnsaved(
      qualifiedKey(ref.schema, ref.name),
      'Import into this table?',
      'Importing changes database rows and requires resolving local drafts first.',
      () => {
        void openTransferPreview(() => db.ChooseTableImport(ref), [ref])
      },
    )
  }

  function invalidateTransferredTables(refs?: TableRef[]) {
    const keys = refs?.length ? new Set(refs.map((ref) => qualifiedKey(ref.schema, ref.name))) : null
    setTabStates(
      produce((states) => {
        for (const key of Object.keys(states)) {
          if (keys && !keys.has(key)) continue
          states[key].loadedRequest = ''
          states[key].schemaLoaded = false
          states[key].indexesLoaded = false
          states[key].selectedRows = new Set()
        }
      }),
    )
    void loadTables().catch((e) => setError(String(e)))
  }

  async function runTransfer() {
    const dialog = transferDialog()
    if (!dialog || transferBusy()) return
    const { preview, tables: refs, format, conflict, restoreCode } = dialog
    setTransferBusy(true)
    setError('')
    try {
      let result: TransferResult
      if (preview.kind === 'backup') result = await db.BackupDatabase(props.transferPreferences.backupBatchSizeMB)
      else if (preview.kind === 'restore') result = await db.RestoreDatabase(preview.token ?? '', restoreCode)
      else if (preview.kind === 'export') result = await db.ExportTables(refs, format)
      else result = await db.ImportTable(refs[0], preview.token ?? '', conflict)
      if (!result.path && (preview.kind === 'backup' || preview.kind === 'export')) return
      setTransferDialog(null)
      const skipped = result.skipped ? ` · ${result.skipped.toLocaleString()} skipped` : ''
      const amount =
        preview.kind === 'restore' && preview.format === 'sql'
          ? `${(result.statements ?? preview.statements ?? 0).toLocaleString()} statements`
          : `${result.rows.toLocaleString()} rows`
      setOperationNotice(
        `${preview.kind === 'backup' ? 'Backup' : preview.kind === 'restore' ? 'Restore' : preview.kind === 'export' ? 'Export' : 'Import'} complete · ${amount}${skipped}`,
      )
      if (preview.kind === 'restore') invalidateTransferredTables()
      if (preview.kind === 'import') invalidateTransferredTables(refs)
    } catch (e) {
      setError(String(e))
    } finally {
      setTransferBusy(false)
    }
  }

  function confirmTruncate(refs: TableRef[]) {
    guardWorkspace(
      'Truncate selected tables?',
      'Truncate permanently removes every row from the selected tables.',
      () =>
        void setConfirmAction({
          title: `Truncate ${refs.length} table${refs.length === 1 ? '' : 's'}?`,
          message:
            'This operation cannot be undone. All rows in the selected tables will be removed in one transaction.',
          run: async () => {
            const activityID = props.activity.enqueue({
              sessionID: status.id,
              database: status.database,
              source: 'database',
              statement: `TRUNCATE ${refs.map((ref) => `${ref.schema}.${ref.name}`).join(', ')}`,
            })
            setTransferBusy(true)
            try {
              props.activity.start(activityID)
              const affected = await db.TruncateTables(activityID, refs)
              setConfirmAction(null)
              invalidateTransferredTables(refs)
              setOperationNotice(
                `Truncate complete · ${affected.toLocaleString()} ${status.driver === 'SQLite' ? 'rows' : 'tables'} affected`,
              )
            } catch (e) {
              if (!props.activity.cancelled(activityID)) setError(String(e))
            } finally {
              props.activity.finish(activityID)
              setTransferBusy(false)
            }
          },
        }),
    )
  }

  function refreshFromMenu(item: TableSummary) {
    const key = tableKey(item)
    if (!tabStates[key]) openTable(item)
    else {
      setActiveTable(key)
      setActivePane('table')
      refresh(key)
    }
  }

  function copyQualifiedName(item: TableSummary) {
    void navigator.clipboard?.writeText(`${item.schema}.${item.name}`).catch((e) => setError(String(e)))
  }

  function guardWorkspace(title: string, message: string, run: () => void | Promise<void>) {
    if (saving) return
    const dirty = Object.keys(draftsByTable).filter((key) => draftsByTable[key].present.length)
    if (dirty.length) setGuardedAction({ table: dirty[0], tables: dirty, title, message, run })
    else void run()
  }

  onMount(() => {
    props.registerWorkspace({
      beforeLeave: (run) =>
        guardWorkspace(
          'Switch database?',
          'This database has unsaved changes. Save or discard them before continuing.',
          run,
        ),
    })
    onCleanup(() => props.registerWorkspace(null))
  })

  function disconnect() {
    guardWorkspace('Close database?', 'Unsaved changes in this database will be lost.', props.onCloseSession)
  }

  async function refreshDatabase() {
    if (loadingTables()) return
    setLoadingTables(true)
    setError('')
    try {
      await loadTables()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingTables(false)
    }
  }

  async function refreshNow(key = activeTable()) {
    if (!tabStates[key]) return
    updateTabState(key, (current) => ({ ...current, loading: true, loadError: '' }))
    setError('')
    try {
      await loadTables()
      updateTabState(key, (current) => ({ ...current, loadedRequest: '', schemaLoaded: false, indexesLoaded: false }))
    } catch (e) {
      setError(String(e))
      updateTabState(key, (current) => ({ ...current, loading: false }))
    }
  }

  function refresh(key = activeTable()) {
    guardUnsaved(key, 'Refresh table?', 'Refreshing will replace the rows that contain unsaved changes.', () =>
      refreshNow(key),
    )
  }

  function changeSortNow(key: string, column: string) {
    updateTabState(key, (state) => {
      if (state.sortColumn !== column)
        return { ...state, sortColumn: column, sortDirection: 'asc', page: 0, selectedRows: new Set() }
      if (state.sortDirection === 'asc') return { ...state, sortDirection: 'desc', page: 0, selectedRows: new Set() }
      return { ...state, sortColumn: '', sortDirection: 'asc', page: 0, selectedRows: new Set() }
    })
  }

  function changeSort(key: string, column: string) {
    guardUnsaved(key, 'Change sorting?', 'Sorting may replace rows that contain unsaved changes.', () =>
      changeSortNow(key, column),
    )
  }

  const [columnCache, setColumnCache] = createStore<Record<string, string[]>>({})
  const completionTables = createMemo<CompletionTable[]>(() =>
    tables().map((item) => {
      const key = tableKey(item)
      return {
        schema: item.schema,
        name: item.name,
        columns: tabStates[key]?.schema.map((column) => column.name) ?? columnCache[key] ?? [],
      }
    }),
  )

  async function loadColumnsFor(name: string) {
    const item = tables().find((table) => table.name.toLowerCase() === name.toLowerCase())
    if (!item) return
    const key = tableKey(item)
    if (columnCache[key]) return
    setColumnCache(key, [])
    // Completion is best effort: a table that cannot be introspected simply
    // offers no columns rather than surfacing an error mid-keystroke.
    try {
      setColumnCache(
        key,
        (await db.GetTableSchema(item.schema, item.name)).map((column) => column.name),
      )
    } catch {
      /* leave the empty entry so the fetch is not retried on every keystroke */
    }
  }

  const openBuffer = (name: string) => {
    if (!buffers[name]) setBuffers(name, newScriptBuffer(''))
  }
  const editorText = () => buffers[activeScript()]?.text ?? ''
  // A run of ordinary typing collapses into one undo step. A pause, a newline,
  // or an edit that is not a single character - a paste, a completion, a cut -
  // ends the group, which is what makes undo land where a writer expects.
  function recordEdit(value: string, selection: EditorSelection) {
    const name = activeScript()
    const buffer = buffers[name]
    if (!buffer || buffer.text === value) return
    const now = Date.now()
    const delta = value.length - buffer.text.length
    const typedNewline = delta === 1 && value.slice(0, selection.start).endsWith('\n')
    const boundary = Math.abs(delta) !== 1 || typedNewline || now - buffer.editedAt > 550
    const before = Math.max(0, selection.start - delta)
    setBuffers(
      name,
      produce((state) => {
        if (boundary)
          state.past = [...state.past, { text: state.text, start: before, end: before }].slice(-historyLimit())
        state.future = []
        state.text = value
        state.editedAt = now
      }),
    )
  }

  function rememberEditorSelection(selection: EditorSelection) {
    const name = activeScript()
    const caret = buffers[name]?.caret
    if (
      !caret ||
      (caret.start === selection.start && caret.end === selection.end && caret.direction === selection.direction)
    )
      return
    setBuffers(name, 'caret', (current) => ({ ...current, ...selection }))
  }

  function stepHistory(from: 'past' | 'future', selection: EditorSelection) {
    const name = activeScript()
    const buffer = buffers[name]
    if (!buffer?.[from].length) return
    const to = from === 'past' ? 'future' : 'past'
    const snapshot = from === 'past' ? buffer.past[buffer.past.length - 1] : buffer.future[0]
    setBuffers(
      name,
      produce((state) => {
        const current = { text: state.text, start: selection.start, end: selection.end }
        state[to] =
          to === 'future'
            ? [current, ...state.future].slice(0, historyLimit())
            : [...state.past, current].slice(-historyLimit())
        state[from] = from === 'past' ? state.past.slice(0, -1) : state.future.slice(1)
        state.text = snapshot.text
        state.caret = { start: snapshot.start, end: snapshot.end, nonce: state.caret.nonce + 1 }
        state.editedAt = 0
      }),
    )
  }
  // The scratch buffer has no file behind it, so it is never "unsaved".
  const scriptDirty = (name = activeScript()) =>
    Boolean(name) && Boolean(buffers[name]) && buffers[name].text !== buffers[name].saved
  const filteredScripts = createMemo(() =>
    scripts().filter((script) => script.name.toLowerCase().includes(sidebarFilter().toLowerCase())),
  )

  async function loadScripts() {
    setScriptsLoading(true)
    try {
      setScripts((await db.ListScripts()) ?? [])
    } catch (e) {
      setError(String(e))
    } finally {
      setScriptsLoading(false)
    }
  }

  // Scripts are only read once their pane is opened, so a database that never
  // uses them never touches the file system.
  createEffect(
    on(pane, (current) => {
      if (current !== 'scripts') return
      void loadScripts()
      if (!scriptWorkspace())
        db.ScriptWorkspacePath()
          .then(setScriptWorkspace)
          .catch(() => {})
    }),
  )

  function showScript(name: string) {
    batch(() => {
      setOpenScripts((current) => (current.includes(name) ? current : [...current, name]))
      setActiveScript(name)
      setActivePane('script')
      setEditorFocusNonce((value) => value + 1)
    })
  }

  async function openScriptNow(name: string) {
    if (buffers[name]) {
      showScript(name)
      return
    }
    try {
      const content = await db.ReadScript(name)
      batch(() => {
        setBuffers(name, newScriptBuffer(content))
        showScript(name)
      })
    } catch (e) {
      setError(String(e))
    }
  }

  // Each tab holds its own buffer, so opening another one loses nothing and
  // needs no guard. Closing a dirty tab still does.
  function openScript(name: string) {
    void openScriptNow(name)
  }

  function openScratch() {
    openBuffer('')
    showScript('')
  }

  function closeScript(name: string) {
    const drop = () =>
      batch(() => {
        setOpenScripts((current) => current.filter((item) => item !== name))
        setBuffers(
          produce((state) => {
            delete state[name]
          }),
        )
        if (activeScript() === name) {
          const remaining = openScripts().filter((item) => item !== name)
          setActiveScript(remaining.at(-1) ?? '')
          if (!remaining.length) setActivePane('table')
        }
      })
    if (scriptDirty(name)) setScriptGuard({ name, run: drop })
    else drop()
  }

  async function saveScript(name = activeScript()) {
    if (!name) return
    const content = buffers[name]?.text ?? ''
    try {
      await db.SaveScript(name, content)
      setBuffers(name, 'saved', content)
      await loadScripts()
    } catch (e) {
      setError(String(e))
      throw e
    }
  }

  // A new script is created under a free default name and opened straight into
  // rename, so naming is one step rather than a dialog before any content.
  function newScript() {
    void (async () => {
      const taken = new Set(scripts().map((script) => script.name.toLowerCase()))
      let name = 'untitled'
      for (let n = 2; taken.has(`${name}.sql`); n++) name = `untitled ${n}`
      try {
        const created = await db.CreateScript(name)
        await loadScripts()
        await openScriptNow(created.name)
        setRenamingScript(created.name)
      } catch (e) {
        setError(String(e))
      }
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
          setBuffers(
            produce((state) => {
              delete state[from]
            }),
          )
        }
        setOpenScripts((current) => current.map((item) => (item === from ? renamed.name : item)))
        if (activeScript() === from) setActiveScript(renamed.name)
      })
      await loadScripts()
    } catch (e) {
      setError(String(e))
    }
  }

  function deleteScript(name: string) {
    const remove = async () => {
      try {
        await db.DeleteScript(name)
        batch(() => {
          setOpenScripts((current) => current.filter((item) => item !== name))
          setBuffers(
            produce((state) => {
              delete state[name]
            }),
          )
          if (activeScript() === name) {
            const remaining = openScripts().filter((item) => item !== name)
            setActiveScript(remaining.at(-1) ?? '')
            if (!remaining.length) setActivePane('table')
          }
        })
        await loadScripts()
      } catch (e) {
        setError(String(e))
      }
    }
    if (scriptDirty(name)) setScriptGuard({ name, run: remove })
    else void remove()
  }

  // The editor decides what a run covers: the statement at the cursor, or every
  // statement the selection touches. Scratch queries stay read-only; a saved
  // script uses the writable statement endpoint when its connection allows it.
  async function executeQuery(statements: string[]) {
    const queries = statements.map((statement) => statement.trim()).filter(Boolean)
    if (!queries.length) {
      setError('There is no statement to run.')
      return
    }
    const target = activeScript()
    if (!buffers[target]) return
    // Only a lone query can be paged; a run of several has no single window.
    const plan = queries.length === 1 ? planPagination(queries[0]) : null
    batch(() => {
      setBuffers(target, 'statements', queries)
      setBuffers(target, 'plan', plan?.pageable ? plan : null)
    })
    await runPage(target, 0)
  }

  async function runPage(name: string, page: number) {
    const buffer = buffers[name]
    if (!buffer) return
    const plan = buffer.plan
    const windowed = plan ? pageQuery(plan, page, SCRIPT_PAGE_SIZE) : null
    if (plan && !windowed) return
    const queries = windowed ? [windowed] : (unwrap(buffer.statements) as string[])
    if (!queries.length) return
    const activityIDs = queries.map((statement) =>
      props.activity.enqueue({
        sessionID: status.id,
        database: status.database,
        source: 'script',
        statement,
      }),
    )
    setBuffers(name, 'running', true)
    setError('')
    try {
      let result: QueryResult | null = null
      let completed = 0
      for (const [position, statement] of queries.entries()) {
        const activityID = activityIDs[position]
        if (props.activity.cancelled(activityID)) {
          props.activity.finish(activityID)
          continue
        }
        props.activity.start(activityID)
        try {
          result = name
            ? await db.ExecuteScriptStatement(activityID, statement)
            : await db.ExecuteQuery(activityID, statement)
          completed++
        } catch (e) {
          if (props.activity.cancelled(activityID)) continue
          throw new Error(`statement ${position + 1} of ${queries.length}: ${String(e).replace(/^Error:\s*/i, '')}`)
        } finally {
          props.activity.finish(activityID)
        }
      }
      if (result && completed > 1) result = { ...result, message: `${completed} statements · ${result.message}` }
      if (result && buffers[name])
        batch(() => {
          setBuffers(name, 'result', result)
          setBuffers(name, 'page', page)
        })
    } catch (e) {
      setError(String(e))
    } finally {
      activityIDs.forEach(props.activity.finish)
      if (buffers[name]) setBuffers(name, 'running', false)
    }
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
    setDraftsByTable(
      produce((drafts) => {
        delete drafts[key]
      }),
    )
  }

  function undoDraft(key = activeTable()) {
    const history = draftsByTable[key]
    if (!history?.past.length) return
    const past = unwrap(history.past)
    const present = unwrap(history.present)
    const future = unwrap(history.future)
    batch(() => {
      setDraftsByTable(key, {
        past: past.slice(0, -1),
        present: past[past.length - 1],
        future: [present, ...future].slice(0, historyLimit()),
      })
      updateTabState(key, (state) => ({ ...state, selectedRows: new Set() }))
    })
  }

  function redoDraft(key = activeTable()) {
    const history = draftsByTable[key]
    if (!history?.future.length) return
    const past = unwrap(history.past)
    const present = unwrap(history.present)
    const future = unwrap(history.future)
    batch(() => {
      setDraftsByTable(key, {
        past: [...past, present].slice(-historyLimit()),
        present: future[0],
        future: future.slice(1),
      })
      updateTabState(key, (state) => ({ ...state, selectedRows: new Set() }))
    })
  }

  async function updateCell(
    key: string,
    data: TableData,
    draftGrid: ReturnType<typeof buildDraftGrid>,
    column: string,
    rowIndex: number,
    value: unknown,
  ) {
    const meta = draftGrid.meta[rowIndex]
    if (!meta || meta.kind === 'delete') return
    changeDraft(key, (current) => {
      const operations = [...current]
      const index = operations.findIndex((operation) => operation.id === meta.id)
      if (meta.kind === 'insert') {
        if (index >= 0)
          operations[index] = { ...operations[index], values: { ...operations[index].values, [column]: value } }
      } else {
        const sourceIndex = data.columns.indexOf(column)
        const original = meta.baseIndex === undefined ? undefined : data.rows[meta.baseIndex]?.[sourceIndex]
        const values = index >= 0 && operations[index].type === 'update' ? { ...operations[index].values } : {}
        if (JSON.stringify(value) === JSON.stringify(original)) delete values[column]
        else values[column] = value
        if (index >= 0) operations.splice(index, 1)
        if (Object.keys(values).length)
          operations.push({ id: meta.id, type: 'update', values, primaryKey: meta.primaryKey })
      }
      return operations
    })
  }

  function addRecord(key: string) {
    const id = `new:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
    batch(() => {
      changeDraft(key, (current) => [...current, { id, type: 'insert', values: {}, primaryKey: {} }])
      updateTabState(key, (state) => ({ ...state, view: 'data' }))
    })
  }

  function toggleSelected(key: string, id: string) {
    updateTabState(key, (state) => {
      const selectedRows = new Set(state.selectedRows)
      if (selectedRows.has(id)) selectedRows.delete(id)
      else selectedRows.add(id)
      return { ...state, selectedRows }
    })
  }

  function deleteSelected(key: string, selectedRows: Set<string>, draftGrid: ReturnType<typeof buildDraftGrid>) {
    if (!selectedRows.size) return
    batch(() => {
      changeDraft(key, (current) => {
        let operations = [...current]
        for (const id of selectedRows) {
          const meta = draftGrid.meta.find((item) => item.id === id)
          if (!meta) continue
          if (meta.kind === 'insert') operations = operations.filter((operation) => operation.id !== id)
          else if (meta.canEdit) {
            operations = operations.filter((operation) => operation.id !== id)
            operations.push({ id, type: 'delete', values: {}, primaryKey: meta.primaryKey })
          }
        }
        return operations
      })
      updateTabState(key, (state) => ({ ...state, selectedRows: new Set() }))
    })
  }

  function stageTruncateNow(key: string) {
    batch(() => {
      changeDraft(key, () => [{ id: 'truncate', type: 'truncate', values: {}, primaryKey: {} }])
      updateTabState(key, (state) => ({ ...state, selectedRows: new Set() }))
    })
  }

  function stageTruncate(key: string, operations: PendingOperation[]) {
    if (operations.length && !operations.some((operation) => operation.type === 'truncate'))
      guardUnsaved(key, 'Replace pending changes?', 'Truncate will replace the edits already staged in this tab.', () =>
        stageTruncateNow(key),
      )
    else stageTruncateNow(key)
  }

  async function saveChanges(key = activeTable()) {
    const item = tables().find((table) => tableKey(table) === key)
    const operations = unwrap(draftOperations(key))
    const state = tabStates[key]
    if (!item || !state || !operations.length) return
    if (saving) throw new Error('A save is already in progress.')
    const activityID = props.activity.enqueue({
      sessionID: status.id,
      database: status.database,
      source: 'database',
      statement: `APPLY ${operations.length} CHANGE${operations.length === 1 ? '' : 'S'} TO ${item.schema}.${item.name}`,
    })
    saving = true
    updateTabState(key, (current) => ({ ...current, loading: true }))
    setError('')
    try {
      props.activity.start(activityID)
      await db.ApplyChanges(
        activityID,
        item.schema,
        item.name,
        operations.map(({ id: _id, ...operation }) => operation),
      )
      clearDraft(key)
      await loadTables()
      updateTabState(key, (current) => ({ ...current, selectedRows: new Set(), loadedRequest: '', loadError: '' }))
    } catch (e) {
      if (!props.activity.cancelled(activityID)) setError(String(e))
      throw e
    } finally {
      props.activity.finish(activityID)
      saving = false
      updateTabState(key, (current) => ({ ...current, loading: false }))
    }
  }

  function discardChanges(key: string) {
    batch(() => {
      clearDraft(key)
      updateTabState(key, (state) => ({ ...state, selectedRows: new Set() }))
    })
  }

  function guardUnsaved(key: string, title: string, message: string, run: () => void | Promise<void>) {
    if (draftOperations(key).length) setGuardedAction({ table: key, title, message, run })
    else void run()
  }

  function changeFilter(key: string, next: string) {
    guardUnsaved(key, 'Apply filter?', 'This filter may hide rows with unsaved changes.', () =>
      updateTabState(key, (state) => ({ ...state, filter: next, page: 0, selectedRows: new Set() })),
    )
  }

  function changePage(key: string, next: number) {
    guardUnsaved(key, 'Change page?', 'Changing page will hide rows with unsaved changes.', () =>
      updateTabState(key, (state) => ({ ...state, page: next, selectedRows: new Set() })),
    )
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
        if (activePane() === 'script' && scriptDirty()) {
          void saveScript().catch(() => {})
          return
        }
        if (!guardedAction() && !saving && draftOperations(key).length) void saveChanges(key).catch(() => {})
      } else if (
        !isTextEditor &&
        !guardedAction() &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z'
      ) {
        event.preventDefault()
        if (event.shiftKey) redoDraft(key)
        else undoDraft(key)
      }
    }
    window.addEventListener('keydown', listener)
    onCleanup(() => window.removeEventListener('keydown', listener))
  })

  const filteredTables = createMemo(() =>
    tables().filter((table) => table.name.toLowerCase().includes(sidebarFilter().toLowerCase())),
  )
  const tableItems = createMemo(() => filteredTables().filter((item) => item.type === 'table'))
  const viewItems = createMemo(() => filteredTables().filter((item) => item.type === 'view'))
  const guardedKeys = () => {
    const action = guardedAction()
    return action ? (action.tables ?? [action.table]) : []
  }
  const menuTable = () => {
    const menu = contextMenu()
    return menu?.kind === 'table' ? tables().find((item) => tableKey(item) === menu.key) : undefined
  }
  const menuTableKeys = () => {
    const menu = contextMenu()
    return menu?.kind === 'table'
      ? selectedTables().has(menu.key)
        ? selectedTables()
        : new Set([menu.key])
      : new Set<string>()
  }
  const menuTableRefs = () => refsForKeys(menuTableKeys())
  const singleMenuObject = () => menuTableRefs().length === 1 || menuTable()?.type === 'view'
  const menuActions = (): ContextMenuAction[] => {
    const menu = contextMenu()
    if (!menu) return []
    if (menu.kind === 'tab')
      return [
        { label: 'Close tab', icon: <X size={15} />, run: () => closeTab(menu.key) },
        {
          label: pinnedTabs().has(menu.key) ? 'Unpin tab' : 'Pin tab',
          icon: <Pin size={15} />,
          run: () => togglePin(menu.key),
        },
        { label: 'Close all tabs', icon: <X size={15} />, separator: true, danger: true, run: closeAllTabs },
      ]
    if (menu.kind === 'script')
      return [
        { label: 'Open script', icon: <Code size={15} />, run: () => openScript(menu.key) },
        { label: 'Rename script', icon: <Edit size={15} />, run: () => setRenamingScript(menu.key) },
        {
          label: 'Delete script',
          icon: <Trash size={15} />,
          run: () => deleteScript(menu.key),
          separator: true,
          danger: true,
        },
      ]
    if (menu.kind === 'database')
      return [
        { label: 'New connection', icon: <Plus size={15} />, run: props.onNewConnection },
        { label: 'Back up database', icon: <Save size={15} />, run: startBackup },
        ...(!status.readOnly
          ? [
              {
                label: 'Restore database',
                icon: <Refresh size={15} />,
                run: startRestore,
                separator: true,
                danger: true,
              },
            ]
          : []),
      ]
    const item = menuTable()
    if (!item) return []
    const refs = menuTableRefs()
    return [
      ...(singleMenuObject()
        ? [
            { label: 'Open data', icon: <Table size={15} />, run: () => openTable(item, 'data') },
            { label: 'View structure', icon: <Columns size={15} />, run: () => openTable(item, 'structure') },
          ]
        : []),
      ...(refs.length
        ? [
            {
              label: `Export ${refs.length === 1 ? 'table' : `${refs.length} tables`}`,
              icon: <File size={15} />,
              run: () => startExport(refs),
              separator: true,
            },
          ]
        : []),
      ...(!status.readOnly && refs.length === 1
        ? [{ label: 'Import into table', icon: <Plus size={15} />, run: () => startImport(refs[0]) }]
        : []),
      ...(singleMenuObject()
        ? [
            { label: 'Refresh table', icon: <Refresh size={15} />, run: () => refreshFromMenu(item) },
            { label: 'Copy qualified name', icon: <Copy size={15} />, run: () => copyQualifiedName(item) },
          ]
        : []),
      ...(!status.readOnly && refs.length
        ? [
            {
              label: `Truncate ${refs.length === 1 ? 'table' : `${refs.length} tables`}`,
              icon: <Trash size={15} />,
              run: () => confirmTruncate(refs),
              separator: true,
              danger: true,
            },
          ]
        : []),
    ]
  }
  return (
    <div class="database-workspace" hidden={!props.active}>
      <div class="workspace">
        <Show when={sidebarOpen()}>
          <aside
            class="sidebar"
            style={{ width: `${props.tableSidebar.width()}px`, 'flex-basis': `${props.tableSidebar.width()}px` }}
          >
            <button
              class="connection-card"
              title={`${status.path}\nRight-click for backup and restore`}
              onClick={props.onNewConnection}
              onContextMenu={(event) => showContextMenu(event, 'database', '')}
            >
              <span class={`db-avatar ${status.driver === 'PostgreSQL' ? 'postgres' : ''}`}>
                {status.driver === 'PostgreSQL' ? 'PG' : 'SQ'}
              </span>
              <span class="connection-text">
                <b>{status.name}</b>
                <small>
                  <i class="online-dot" /> {status.driver} · {status.readOnly ? 'Read-only' : 'Editable'}
                </small>
              </span>
              <ChevronDown size={15} />
            </button>
            <div class="sidebar-tabs" role="tablist" aria-label="Sidebar contents">
              <button
                role="tab"
                aria-selected={pane() === 'data'}
                class={pane() === 'data' ? 'active' : ''}
                onClick={() => setPane('data')}
              >
                <Table size={13} /> Data
              </button>
              <button
                role="tab"
                aria-selected={pane() === 'scripts'}
                class={pane() === 'scripts' ? 'active' : ''}
                onClick={() => setPane('scripts')}
              >
                <Code size={13} /> Scripts
                <Show when={scripts().length}>
                  <em>{scripts().length}</em>
                </Show>
              </button>
            </div>
            <div class="side-search">
              <Search size={14} />
              <input
                ref={sidebarSearch}
                aria-label={pane() === 'data' ? 'Filter database objects' : 'Filter scripts'}
                value={sidebarFilter()}
                onInput={(e) => setSidebarFilter(e.currentTarget.value)}
                placeholder={pane() === 'data' ? 'Filter objects' : 'Filter scripts'}
              />
              <span class="search-shortcut" aria-hidden="true">
                <kbd>
                  <Command size={12} />
                </kbd>
                <kbd>K</kbd>
              </span>
            </div>
            <Show
              when={pane() === 'data'}
              fallback={
                <div class="object-tree script-pane">
                  <div class="script-pane-head">
                    <span title={scriptWorkspace()}>Scripts</span>
                    <button class="icon-button" aria-label="New script" title="New script" onClick={newScript}>
                      <Plus size={15} />
                    </button>
                  </div>
                  <Show when={!scriptsLoading()} fallback={<SidebarSkeleton />}>
                    <Show
                      when={filteredScripts().length}
                      fallback={
                        <p class="script-empty">
                          {scripts().length
                            ? 'No script matches this filter.'
                            : 'No scripts yet. Create one to keep SQL alongside this connection.'}
                        </p>
                      }
                    >
                      <For each={filteredScripts()}>
                        {(script, index) => (
                          <Show
                            when={renamingScript() !== script.name}
                            fallback={
                              <input
                                class="script-rename"
                                value={script.name.replace(/\.sql$/i, '')}
                                ref={(el) =>
                                  queueMicrotask(() => {
                                    el.focus()
                                    el.select()
                                  })
                                }
                                onBlur={(event) => void renameScript(script.name, event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') event.currentTarget.blur()
                                  if (event.key === 'Escape') {
                                    setRenamingScript('')
                                    event.currentTarget.blur()
                                  }
                                }}
                              />
                            }
                          >
                            <button
                              class={`object-row script-row ${activeScript() === script.name ? 'active' : ''}`}
                              style={{ '--stagger': String(index()) }}
                              title={`${script.name}\n${new Date(script.modified).toLocaleString()}`}
                              onClick={() => openScript(script.name)}
                              onContextMenu={(event) => showContextMenu(event, 'script', script.name)}
                            >
                              <File size={14} />
                              <span>{script.name.replace(/\.sql$/i, '')}</span>
                              <Show when={activeScript() === script.name && scriptDirty()}>
                                <i class="script-dirty" title="Unsaved changes" />
                              </Show>
                            </button>
                          </Show>
                        )}
                      </For>
                    </Show>
                  </Show>
                </div>
              }
            >
              <div class="object-tree">
                <Show when={!loadingTables()} fallback={<SidebarSkeleton />}>
                  <ObjectGroup label="Tables" count={tableItems().length}>
                    <For each={tableItems()}>
                      {(item, index) => (
                        <ObjectRow
                          item={item}
                          stagger={index()}
                          countLoading={countingTables().has(tableKey(item))}
                          active={activeTable() === tableKey(item)}
                          selected={selectedTables().has(tableKey(item))}
                          onClick={(event) => selectTable(event, item)}
                          onContextMenu={(event) => showTableContextMenu(event, item)}
                        />
                      )}
                    </For>
                  </ObjectGroup>
                  <ObjectGroup label="Views" count={viewItems().length}>
                    <For each={viewItems()}>
                      {(item, index) => (
                        <ObjectRow
                          item={item}
                          stagger={index()}
                          countLoading={countingTables().has(tableKey(item))}
                          active={activeTable() === tableKey(item)}
                          selected={false}
                          onClick={(event) => selectTable(event, item)}
                          onContextMenu={(event) => showTableContextMenu(event, item)}
                        />
                      )}
                    </For>
                  </ObjectGroup>
                </Show>
              </div>
            </Show>
            <div class="sidebar-footer">
              <DatabasePicker status={status} onSelect={props.onOpenDatabase} />
              <button
                onClick={() => void refreshDatabase()}
                class="icon-button database-refresh"
                title="Refresh database"
                aria-label="Refresh database"
                disabled={loadingTables()}
              >
                <Refresh size={15} class={loadingTables() ? 'spin' : ''} />
              </button>
              <button onClick={disconnect} class="icon-button" title="Close database" aria-label="Close database">
                <X size={15} />
              </button>
            </div>
            <SidebarResizeHandle label="Resize table sidebar" sizing={props.tableSidebar} />
          </aside>
        </Show>
        <section class="main-panel">
          <div class="top-tabs">
            <button
              class="icon-button sidebar-toggle"
              onClick={() => setSidebarOpen((value) => !value)}
              title="Toggle sidebar"
            >
              <PanelLeft size={17} />
            </button>
            <TabStrip activeTab={activeTable()}>
              <For each={tabs()}>
                {(tab) => {
                  const item = () => tables().find((value) => tableKey(value) === tab)
                  const changes = () => draftOperations(tab).length
                  const pinned = () => pinnedTabs().has(tab)
                  return (
                    <Show when={item()}>
                      {(value) => (
                        <button
                          data-active={activeTable() === tab}
                          title={`${value().schema}.${value().name}`}
                          onClick={() =>
                            batch(() => {
                              setActiveTable(tab)
                              setActivePane('table')
                            })
                          }
                          onContextMenu={(event) => showContextMenu(event, 'tab', tab)}
                          class={`tab ${activeTable() === tab ? 'active' : ''} ${changes() ? 'changed' : ''} ${pinned() ? 'pinned' : ''}`}
                        >
                          {pinned() ? <Pin size={13} class="tab-pin" /> : <Table size={14} />}
                          <b class="tab-label">{value().name}</b>
                          <Show when={changes() > 0}>
                            <i class="tab-change-dot" title={`${changes()} pending change(s)`} />
                          </Show>
                          <span
                            onClick={(e) => {
                              e.stopPropagation()
                              closeTab(tab)
                            }}
                          >
                            <X size={13} />
                          </span>
                        </button>
                      )}
                    </Show>
                  )
                }}
              </For>
              <For each={openScripts()}>
                {(name) => {
                  const label = () => (name ? name.replace(/\.sql$/i, '') : 'Query')
                  const current = () => activePane() === 'script' && activeScript() === name
                  return (
                    <button
                      data-active={current()}
                      title={label()}
                      class={`tab script-tab ${current() ? 'active' : ''} ${scriptDirty(name) ? 'changed' : ''}`}
                      onClick={() => showScript(name)}
                    >
                      <Code size={13} />
                      <b class="tab-label">{label()}</b>
                      <span
                        class={`tab-close ${scriptDirty(name) ? 'dirty' : ''}`}
                        title={scriptDirty(name) ? 'Close and review unsaved changes' : 'Close script'}
                        onClick={(event) => {
                          event.stopPropagation()
                          closeScript(name)
                        }}
                      >
                        <Show when={scriptDirty(name)} fallback={<X size={13} />}>
                          <i class="tab-change-dot" />
                        </Show>
                      </span>
                    </button>
                  )
                }}
              </For>
            </TabStrip>
            <button
              class={`query-tab ${activePane() === 'script' && !activeScript() ? 'active' : ''}`}
              title="Scratch SQL"
              onClick={openScratch}
            >
              <Code size={15} /> SQL
            </button>
            <button
              class="icon-button"
              aria-label="Workspace actions"
              aria-haspopup="menu"
              title="Workspace actions"
              onClick={(event) => showContextMenu(event, 'database', '')}
            >
              <More size={17} />
            </button>
          </div>
          <For each={tabs()}>
            {(tab) => {
              const item = () => tables().find((value) => tableKey(value) === tab)
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
              return (
                <Show when={item() && state() && draftGrid()}>
                  <div class="table-activity" hidden={activePane() !== 'table' || activeTable() !== tab}>
                    <header class="content-header">
                      <div>
                        <div class="breadcrumbs">
                          <span>{status.name}</span>
                          <ChevronRight size={13} />
                          <span>{item()!.schema}</span>
                          <ChevronRight size={13} />
                          <b>{item()!.name}</b>
                        </div>
                        <h2>
                          {item()!.name}
                          <span>{item()!.type}</span>
                        </h2>
                      </div>
                      <div class="header-actions">
                        <button class="secondary" onClick={openScratch}>
                          <Code size={15} /> Query
                        </button>
                        <button class="primary" onClick={() => refresh(tab)}>
                          <Refresh size={15} class={state()!.loading || loadingTables() ? 'spin' : ''} /> Refresh
                        </button>
                      </div>
                    </header>
                    <div class="data-toolbar">
                      <div class="view-switch">
                        <button
                          class={state()!.view === 'data' ? 'active' : ''}
                          onClick={() => setTabStates(tab, 'view', 'data')}
                        >
                          <Table size={14} /> Data
                        </button>
                        <button
                          class={state()!.view === 'structure' ? 'active' : ''}
                          onClick={() => setTabStates(tab, 'view', 'structure')}
                        >
                          <Columns size={14} /> Structure <span>{state()!.schema.length}</span>
                        </button>
                      </div>
                      <Show
                        when={
                          state()!.view === 'data' &&
                          !state()!.loadError &&
                          !status.readOnly &&
                          item()!.type === 'table'
                        }
                      >
                        <div class="row-actions">
                          <button onClick={() => addRecord(tab)}>
                            <Plus size={14} /> New row
                          </button>
                          <button
                            class="danger-action"
                            disabled={!state()!.selectedRows.size}
                            onClick={() => deleteSelected(tab, state()!.selectedRows, draftGrid()!)}
                          >
                            <Trash size={14} /> Delete
                          </button>
                          <button class="danger-action" onClick={() => stageTruncate(tab, operations())}>
                            <Trash size={14} /> Truncate
                          </button>
                        </div>
                      </Show>
                      <div class="toolbar-spacer" />
                      <Show when={state()!.view === 'data'}>
                        <Show when={!status.readOnly && item()!.type === 'table'}>
                          <div class="draft-actions">
                            <button
                              disabled={!history().past.length}
                              onClick={() => undoDraft(tab)}
                              title="Undo draft change (Ctrl+Z)"
                            >
                              <Undo size={14} /> Undo
                            </button>
                            <button
                              disabled={!history().future.length}
                              onClick={() => redoDraft(tab)}
                              title="Redo draft change (Ctrl+Shift+Z)"
                            >
                              <Redo size={14} /> Redo
                            </button>
                            <Show when={operations().length > 0}>
                              <button
                                class="discard-draft"
                                onClick={() => discardChanges(tab)}
                                title="Discard all changes in this table"
                              >
                                <X size={14} /> Discard
                              </button>
                            </Show>
                          </div>
                        </Show>
                        <label class="record-search">
                          <Search size={14} />
                          <input
                            value={state()!.filter}
                            onInput={(e) => changeFilter(tab, e.currentTarget.value)}
                            placeholder="Search records..."
                          />
                          <Show when={state()!.filter}>
                            <button onClick={() => changeFilter(tab, '')}>
                              <X size={13} />
                            </button>
                          </Show>
                        </label>
                        <button class="tool-button">
                          <Filter size={14} /> Filter
                        </button>
                        <button class="tool-button">
                          <Columns size={14} /> Columns
                        </button>
                        <Show when={operations().length > 0}>
                          <button class="save-changes" onClick={() => void saveChanges(tab).catch(() => {})}>
                            <Save size={14} /> Save <b>{operations().length}</b>
                            <kbd>Ctrl S</kbd>
                          </button>
                        </Show>
                      </Show>
                    </div>
                    <div class="content-body">
                      <Show
                        when={state()!.view === 'data'}
                        fallback={
                          <SchemaView
                            schema={state()!.schema}
                            indexes={state()!.indexes}
                            error={state()!.structureError}
                          />
                        }
                      >
                        <Show
                          when={!state()!.loadError}
                          fallback={<TableLoadError message={state()!.loadError} onRetry={() => refresh(tab)} />}
                        >
                          <DataGrid
                            data={draftGrid()!.data}
                            rowMeta={draftGrid()!.meta}
                            selected={state()!.selectedRows}
                            onSelect={(id) => toggleSelected(tab, id)}
                            rowOffset={state()!.page * PAGE_SIZE}
                            sortColumn={state()!.sortColumn}
                            sortDirection={state()!.sortDirection}
                            onSort={(column) => changeSort(tab, column)}
                            layoutKey={`${status.driver}:${status.path}:${item()!.schema}.${item()!.name}`}
                            editable={!status.readOnly}
                            onUpdate={(column, rowIndex, value) =>
                              updateCell(tab, state()!.data, draftGrid()!, column, rowIndex, value)
                            }
                          />
                        </Show>
                      </Show>
                      <Show when={state()!.loading || loadingTables()}>
                        <div class="loading-bar" />
                      </Show>
                    </div>
                    <footer class="pagination">
                      <span>
                        {state()!.data.total
                          ? `${state()!.page * PAGE_SIZE + 1}–${Math.min((state()!.page + 1) * PAGE_SIZE, state()!.data.total)} of ${state()!.data.total.toLocaleString()} rows`
                          : '0 rows'}
                      </span>
                      <span class="query-time">
                        <Clock size={13} />
                        {state()!.data.durationMs} ms
                      </span>
                      <Show when={!status.readOnly && state()!.schema.some((column) => column.primaryKey)}>
                        <span class="edit-hint">Double-click a cell to edit</span>
                      </Show>
                      <div class="page-controls">
                        <Show
                          when={!pagingLimited()}
                          fallback={
                            <div class="paging-limit-warning" role="status">
                              <Alert size={14} />
                              <span>
                                <b>Page limit reached</b>
                                <small>Paging supports up to {MAX_NAVIGABLE_PAGES.toLocaleString()} pages</small>
                              </span>
                            </div>
                          }
                        >
                          <button
                            aria-label="Previous page"
                            disabled={state()!.page === 0}
                            onClick={() => changePage(tab, state()!.page - 1)}
                          >
                            <ChevronRight size={14} class="flip" />
                          </button>
                          <QuickPagePicker
                            currentPage={state()!.page + 1}
                            totalPages={totalPages()}
                            onSelect={(page) => changePage(tab, page - 1)}
                          />
                          <button
                            aria-label="Next page"
                            disabled={state()!.page + 1 >= totalPages()}
                            onClick={() => changePage(tab, state()!.page + 1)}
                          >
                            <ChevronRight size={14} />
                          </button>
                        </Show>
                      </div>
                    </footer>
                  </div>
                </Show>
              )
            }}
          </For>
          <Show when={activePane() === 'table' && !activeTable()}>
            <Show when={!loadingTables()} fallback={<WorkspaceSkeleton />}>
              <div class="no-table">
                <Table size={30} />
                <h3>Select a table</h3>
                <p>Choose a table or view from the sidebar.</p>
              </div>
            </Show>
          </Show>
          <Show when={activePane() === 'script' && buffers[activeScript()]}>
            <ScriptPanel
              name={activeScript()}
              driver={status.driver}
              text={editorText()}
              dirty={scriptDirty()}
              readOnly={!activeScript() || status.readOnly}
              result={buffers[activeScript()]?.result ?? null}
              running={buffers[activeScript()]?.running ?? false}
              page={buffers[activeScript()]?.page ?? 0}
              pageable={Boolean(buffers[activeScript()]?.plan)}
              onPage={(page) => void runPage(activeScript(), page)}
              tables={completionTables()}
              onNeedColumns={(name) => void loadColumnsFor(name)}
              caret={buffers[activeScript()]!.caret}
              focusNonce={editorFocusNonce()}
              onInput={recordEdit}
              onSelectionChange={rememberEditorSelection}
              onUndo={(selection) => stepHistory('past', selection)}
              onRedo={(selection) => stepHistory('future', selection)}
              onRun={executeQuery}
              onSave={() => void saveScript().catch(() => {})}
              onClose={() => closeScript(activeScript())}
            />
          </Show>
        </section>
      </div>
      <Show when={error()}>{(message) => <Toast message={message()} onClose={() => setError('')} />}</Show>

      <Show when={contextMenu() && menuActions().length > 0}>
        <ContextMenu
          x={contextMenu()!.x}
          y={contextMenu()!.y}
          label={
            contextMenu()!.kind === 'tab'
              ? 'Tab actions'
              : contextMenu()!.kind === 'database'
                ? 'Database actions'
                : contextMenu()!.kind === 'script'
                  ? 'Script actions'
                  : 'Table actions'
          }
          actions={menuActions()}
          onClose={closeContextMenu}
        />
      </Show>

      <Show when={guardedAction()}>
        {(action) => (
          <UnsavedModal
            title={action().title}
            message={action().message}
            count={guardedKeys().reduce((count, key) => count + draftOperations(key).length, 0)}
            onCancel={() => setGuardedAction(null)}
            onDiscard={async () => {
              const current = action()
              const keys = guardedKeys()
              keys.forEach(discardChanges)
              setGuardedAction(null)
              await current.run()
            }}
            onSave={async () => {
              const current = action()
              const keys = guardedKeys()
              try {
                for (const key of keys) await saveChanges(key)
                setGuardedAction(null)
                await current.run()
              } catch {
                /* Keep dialog open when save fails. */
              }
            }}
          />
        )}
      </Show>
      <Show when={scriptGuard()}>
        {(guard) => (
          <UnsavedModal
            title="Unsaved script"
            message={`${guard().name.replace(/\.sql$/i, '')} has changes that have not been saved.`}
            count={1}
            onCancel={() => setScriptGuard(null)}
            onDiscard={async () => {
              const action = guard()
              setScriptGuard(null)
              await action.run()
            }}
            onSave={async () => {
              const action = guard()
              try {
                await saveScript(action.name)
                setScriptGuard(null)
                await action.run()
              } catch {
                /* Keep the dialog open when the save fails. */
              }
            }}
          />
        )}
      </Show>
      <Show when={transferDialog()}>
        {(dialog) => (
          <TransferModal
            state={dialog()}
            busy={transferBusy()}
            onChange={setTransferDialog}
            onClose={() => setTransferDialog(null)}
            onRun={() => void runTransfer()}
          />
        )}
      </Show>
      <Show when={confirmAction()}>
        {(action) => (
          <DangerConfirmModal
            title={action().title}
            message={action().message}
            busy={transferBusy()}
            onClose={() => setConfirmAction(null)}
            onConfirm={() => void action().run()}
          />
        )}
      </Show>
      <Show when={operationNotice()}>
        {(notice) => <OperationToast message={notice()} onClose={() => setOperationNotice('')} />}
      </Show>
    </div>
  )
}
