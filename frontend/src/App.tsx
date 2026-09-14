import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { api } from './lib/backend/bridge'
import useSidebarPreferences, {
  DEFAULT_APPEARANCE,
  DEFAULT_EDITING,
  DEFAULT_TRANSFER,
} from './lib/preferences/useSidebarPreferences'
import SidebarResizeHandle, { useCompactSidebar, useSidebarWidth } from './components/layout/SidebarResizeHandle'
import TitleBar from './components/layout/TitleBar'
import Toast from './components/feedback/Toast'
import AppearanceModal from './features/settings/AppearanceModal'
import DatabaseWorkspace, {
  ConnectionSkeleton,
  type ActivityController,
  type DatabaseActivity,
  type WorkspaceHandle,
  type WorkspaceSession,
} from './features/workspace/DatabaseWorkspace'
import {
  ConnectionFailureModal,
  ConnectionModal,
  DEFAULT_POSTGRES_CONFIG,
  SavedConnectionEditModal,
  Welcome,
  configForSaved,
} from './features/connections/ConnectionViews'
import type { ConnectionStatus, PostgresConfig, SavedConnection, SavedConnectionUpdate } from './types'
import { Alert, Database, Refresh } from './components/ui/icons'

export default function App() {
  const compactSidebar = useCompactSidebar()
  const [sessions, setSessions] = createSignal<WorkspaceSession[]>([])
  const [activeID, setActiveID] = createSignal('')
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal('')
  const sidebarPreferences = useSidebarPreferences(setError)
  const databaseSidebar = useSidebarWidth('databases', () => 76, sidebarPreferences)
  const tableSidebar = useSidebarWidth('tables', () => (compactSidebar() ? 214 : 242), sidebarPreferences)
  const [connectionOpen, setConnectionOpen] = createSignal(false)
  const [editingConnection, setEditingConnection] = createSignal<SavedConnection | null>(null)
  const [failedConnection, setFailedConnection] = createSignal<WorkspaceSession | null>(null)
  const [appearanceOpen, setAppearanceOpen] = createSignal(false)
  const [systemFonts, setSystemFonts] = createSignal<string[]>([])
  const [systemFontsLoading, setSystemFontsLoading] = createSignal(false)
  let systemFontsLoaded = false
  const [connectionConfig, setConnectionConfig] = createSignal<PostgresConfig>(DEFAULT_POSTGRES_CONFIG)
  const [savedConnections, setSavedConnections] = createSignal<SavedConnection[]>([])
  const [activities, setActivities] = createSignal<DatabaseActivity[]>([])
  const cancelledActivities = new Set<string>()
  const workspaces = new Map<string, WorkspaceHandle>()

  async function loadSystemFonts(force = false) {
    if ((!force && systemFontsLoaded) || systemFontsLoading()) return
    setSystemFontsLoading(true)
    const backend = api()
    const [scanned, local] = await Promise.allSettled([
      typeof backend.ListSystemFonts === 'function' ? backend.ListSystemFonts() : Promise.resolve([]),
      window.queryLocalFonts?.() ?? Promise.resolve([]),
    ])
    const names = [
      ...(scanned.status === 'fulfilled' ? scanned.value : []),
      ...(local.status === 'fulfilled' ? local.value.map((font) => font.family) : []),
    ]
      .map((font) => font.trim())
      .filter(Boolean)
    const unique = [...new Map(names.map((font) => [font.toLocaleLowerCase(), font])).values()].sort((left, right) =>
      left.localeCompare(right),
    )
    if (scanned.status === 'fulfilled' || local.status === 'fulfilled') {
      setSystemFonts(unique)
      systemFontsLoaded = true
    } else {
      setError(`Could not list installed fonts: ${String(scanned.reason)}`)
    }
    setSystemFontsLoading(false)
  }

  function openSettings() {
    setAppearanceOpen(true)
    void loadSystemFonts()
  }

  function resetSettings() {
    sidebarPreferences.setAppearance(DEFAULT_APPEARANCE)
    sidebarPreferences.setEditing(DEFAULT_EDITING)
    sidebarPreferences.setTransfer(DEFAULT_TRANSFER)
  }

  const activityController: ActivityController = {
    enqueue(activity) {
      const id = globalThis.crypto?.randomUUID?.() ?? `operation:${Date.now()}:${Math.random()}`
      setActivities((current) => [...current, { ...activity, id, status: 'queued', startedAt: Date.now() }])
      return id
    },
    start(id) {
      setActivities((current) =>
        current.map((activity) =>
          activity.id === id ? { ...activity, status: 'running', startedAt: Date.now() } : activity,
        ),
      )
    },
    finish(id) {
      cancelledActivities.delete(id)
      setActivities((current) => current.filter((activity) => activity.id !== id))
    },
    cancelled(id) {
      return cancelledActivities.has(id)
    },
  }

  function cancelActivity(id: string) {
    const activity = activities().find((item) => item.id === id)
    if (!activity || activity.status === 'cancelling') return
    cancelledActivities.add(id)
    setActivities((current) => current.map((item) => (item.id === id ? { ...item, status: 'cancelling' } : item)))
    if (activity.status !== 'queued')
      void api()
        .SessionCancelOperation(activity.sessionID, id)
        .catch((e) => setError(String(e)))
  }

  function cancelAllActivities() {
    for (const activity of activities()) cancelActivity(activity.id)
  }

  const loadSavedConnections = async () => {
    try {
      setSavedConnections((await api().ListSavedConnections()) ?? [])
    } catch (e) {
      setError(String(e))
    }
  }

  onMount(() => {
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    api()
      .ListDatabaseSessions()
      .then((next) => {
        if (cancelled) return
        setSessions(next ?? [])
        setActiveID(next?.[0]?.id ?? '')
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    void loadSavedConnections()
  })

  const blocked = () => busy() || connectionOpen() || Boolean(editingConnection()) || Boolean(failedConnection())

  function beforeLeave(run: () => void | Promise<void>) {
    if (busy()) return
    const workspace = workspaces.get(activeID())
    if (workspace) workspace.beforeLeave(run)
    else void run()
  }

  function newConnection() {
    beforeLeave(() => {
      setError('')
      setConnectionConfig(DEFAULT_POSTGRES_CONFIG)
      setConnectionOpen(true)
    })
  }

  function editSaved(profile: SavedConnection) {
    setConnectionOpen(false)
    setError('')
    setEditingConnection(profile)
  }

  async function saveEditedConnection(profile: SavedConnectionUpdate) {
    setBusy(true)
    setError('')
    try {
      await api().UpdateSavedConnection(profile)
      await loadSavedConnections()
      setEditingConnection(null)
    } catch (e) {
      setError(String(e))
      throw e
    } finally {
      setBusy(false)
    }
  }

  async function connect(open: () => Promise<ConnectionStatus>) {
    setBusy(true)
    setError('')
    try {
      const next = await open()
      if (!next.connected) return
      setSessions((current) => (current.some((item) => item.id === next.id) ? current : [...current, next]))
      setActiveID(next.id)
      setConnectionOpen(false)
      setConnectionConfig(DEFAULT_POSTGRES_CONFIG)
      await loadSavedConnections()
    } finally {
      setBusy(false)
    }
  }

  function connectFile() {
    void connect(() => api().ChooseSQLiteSession()).catch((e) => setError(String(e)))
  }
  function connectDemo() {
    void connect(() => api().OpenDemoSession()).catch((e) => setError(String(e)))
  }

  async function openLazySession(
    pending: WorkspaceSession,
    open: () => Promise<ConnectionStatus>,
    refreshSaved = false,
  ) {
    setError('')
    setConnectionOpen(false)
    setSessions((current) => [...current, pending])
    setActiveID(pending.id)
    try {
      const next = await open()
      if (!next.connected) throw new Error('The database did not accept the connection.')
      setSessions((current) =>
        current.some((item) => item.id === next.id)
          ? current.filter((item) => item.id !== pending.id)
          : current.map((item) => (item.id === pending.id ? next : item)),
      )
      setActiveID((current) => (current === pending.id ? next.id : current))
      if (refreshSaved) await loadSavedConnections()
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/i, '')
      const failed = { ...pending, connectionState: 'failed' as const }
      setSessions((current) => current.map((item) => (item.id === pending.id ? failed : item)))
      setFailedConnection(failed)
      setError(message)
    }
  }

  async function openSaved(profile: SavedConnection) {
    if (profile.driver === 'PostgreSQL' && !profile.hasPassword) {
      setConnectionConfig(configForSaved(profile))
      setConnectionOpen(true)
      return
    }
    const pending: WorkspaceSession = {
      id: `pending:${profile.id}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      database: profile.database || profile.name,
      connected: false,
      name: profile.name,
      path:
        profile.driver === 'PostgreSQL' ? `${profile.host}:${profile.port}/${profile.database}` : (profile.path ?? ''),
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
    const fallback =
      current.find((item) => item.id === session.returnToID)?.id ??
      current.filter((item) => item.id !== session.id).at(-1)?.id ??
      ''
    setSessions((list) => list.filter((item) => item.id !== session.id))
    setActiveID((value) => (value === session.id ? fallback : value))
    workspaces.delete(session.id)
  }

  function editFailedConnection() {
    const failed = failedConnection()
    if (!failed) return
    if (failed.retryDatabase) {
      const retry = failed.retryDatabase
      removeLazySession(failed)
      setFailedConnection(null)
      setError('')
      startDatabaseOpen(retry.sourceID, retry.database)
      return
    }
    if (!failed.profile) return
    const profile = failed.profile
    removeLazySession(failed)
    setFailedConnection(null)
    setError('')
    if (profile.driver === 'PostgreSQL') {
      setConnectionConfig(configForSaved(profile))
      setConnectionOpen(true)
    } else connectFile()
  }

  function closeFailedConnection() {
    const failed = failedConnection()
    if (!failed) return
    removeLazySession(failed)
    setFailedConnection(null)
    setError('')
  }

  async function removeSaved(id: string) {
    setBusy(true)
    try {
      await api().DeleteSavedConnection(id)
      setSavedConnections((current) => current.filter((item) => item.id !== id))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function closeSession(id: string) {
    setBusy(true)
    try {
      for (const activity of activities().filter((item) => item.sessionID === id)) cancelActivity(activity.id)
      await api().CloseDatabaseSession(id)
      const remaining = sessions().filter((item) => item.id !== id)
      setSessions(remaining)
      setActiveID(remaining.at(-1)?.id ?? '')
      workspaces.delete(id)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  function startDatabaseOpen(id: string, database: string) {
    const source = sessions().find((item) => item.id === id)
    if (!source || source.database === database) return
    const path = source.path.includes('/')
      ? source.path.replace(/\/[^/]*$/, `/${database}`)
      : `${source.path}/${database}`
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
    if (sessions().find((item) => item.id === id)?.database === database) return
    beforeLeave(() => startDatabaseOpen(id, database))
  }

  return (
    <div class="app-shell">
      <TitleBar
        activities={activities()}
        onCancel={cancelActivity}
        onCancelAll={cancelAllActivities}
        onSettings={openSettings}
      />
      <Show
        when={sessions().length}
        fallback={
          <Welcome
            onOpen={connectFile}
            onPostgres={newConnection}
            onDemo={connectDemo}
            busy={busy()}
            saved={savedConnections()}
            onSaved={openSaved}
            onEdit={editSaved}
            onRemove={removeSaved}
          />
        }
      >
        <div class="session-layout" aria-busy={busy()}>
          <Show when={sessions().length > 1}>
            <div
              class="resizable-database-rail"
              style={{ width: `${databaseSidebar.width()}px`, 'flex-basis': `${databaseSidebar.width()}px` }}
            >
              <nav class="database-rail" aria-label="Open databases">
                <For each={sessions()}>
                  {(session) => (
                    <button
                      class={`database-rail-tab ${activeID() === session.id ? 'active' : ''} ${session.connectionState ?? ''}`}
                      aria-label={`Switch to ${session.database} (${session.name})`}
                      aria-pressed={activeID() === session.id}
                      title={`${session.database} — ${session.name}\n${session.path}`}
                      disabled={busy()}
                      onClick={() => {
                        if (session.id !== activeID())
                          beforeLeave(() => {
                            setActiveID(session.id)
                          })
                      }}
                    >
                      {session.connectionState === 'connecting' ? (
                        <Refresh size={20} class="spin" />
                      ) : session.connectionState === 'failed' ? (
                        <Alert size={20} />
                      ) : (
                        <Database size={20} />
                      )}
                      <span>{session.database}</span>
                    </button>
                  )}
                </For>
              </nav>
              <SidebarResizeHandle label="Resize database sidebar" sizing={databaseSidebar} />
            </div>
          </Show>
          <div class="database-panels" inert={blocked()}>
            <For each={sessions()}>
              {(session) => (
                <Show
                  when={!session.connectionState}
                  fallback={
                    <ConnectionSkeleton
                      session={session}
                      active={session.id === activeID()}
                      tableSidebar={tableSidebar}
                    />
                  }
                >
                  <DatabaseWorkspace
                    status={session}
                    active={session.id === activeID()}
                    blocked={blocked()}
                    tableSidebar={tableSidebar}
                    transferPreferences={sidebarPreferences.transfer()}
                    editingPreferences={sidebarPreferences.editing()}
                    activity={activityController}
                    registerWorkspace={(handle) => {
                      if (handle) workspaces.set(session.id, handle)
                      else workspaces.delete(session.id)
                    }}
                    onNewConnection={newConnection}
                    onCloseSession={() => closeSession(session.id)}
                    onOpenDatabase={(database) => openDatabase(session.id, database)}
                  />
                </Show>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={error()}>{(message) => <Toast message={message()} onClose={() => setError('')} />}</Show>
      <Show when={connectionOpen()}>
        <ConnectionModal
          config={connectionConfig()}
          setConfig={setConnectionConfig}
          saved={savedConnections()}
          busy={busy()}
          onEdit={editSaved}
          onRemove={removeSaved}
          onSQLite={connectFile}
          onPostgres={(config) => connect(() => api().OpenPostgresSession(config))}
          onSaved={openSaved}
          onError={setError}
          onClose={() => setConnectionOpen(false)}
        />
      </Show>
      <Show when={editingConnection()}>
        {(profile) => (
          <SavedConnectionEditModal
            profile={profile()}
            busy={busy()}
            onSave={saveEditedConnection}
            onClose={() => setEditingConnection(null)}
          />
        )}
      </Show>
      <Show when={failedConnection()}>
        {(session) => (
          <ConnectionFailureModal session={session()} onEdit={editFailedConnection} onClose={closeFailedConnection} />
        )}
      </Show>
      <Show when={appearanceOpen()}>
        <AppearanceModal
          appearance={sidebarPreferences.appearance()}
          transfer={sidebarPreferences.transfer()}
          editing={sidebarPreferences.editing()}
          fonts={systemFonts()}
          fontsLoading={systemFontsLoading()}
          ready={sidebarPreferences.ready()}
          onChange={sidebarPreferences.setAppearance}
          onTransferChange={sidebarPreferences.setTransfer}
          onEditingChange={sidebarPreferences.setEditing}
          onRefreshFonts={() => void loadSystemFonts(true)}
          onReset={resetSettings}
          onClose={() => setAppearanceOpen(false)}
        />
      </Show>
    </div>
  )
}
