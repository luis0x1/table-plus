import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type Setter } from 'solid-js'
import { api } from '../../lib/backend/bridge'
import type { PostgresConfig, SavedConnection, SavedConnectionUpdate } from '../../types'
import type { WorkspaceSession } from '../workspace/DatabaseWorkspace'
import {
  Alert,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Edit,
  File,
  Key,
  Play,
  Refresh,
  Save,
  Settings,
  X,
} from '../../components/ui/icons'

type SavedConnectionsProps = {
  saved: SavedConnection[]
  busy: boolean
  onSaved: (profile: SavedConnection) => void
  onEdit: (profile: SavedConnection) => void
  onRemove: (id: string) => void
}

function SavedConnections(props: SavedConnectionsProps) {
  return (
    <Show when={props.saved.length}>
      <section class="saved-connections" aria-label="Saved connections">
        <div class="saved-title">
          <span>Saved connections</span>
          <em>{props.saved.length}</em>
        </div>
        <div class="saved-list">
          <For each={props.saved}>
            {(profile) => (
              <div class="saved-item">
                <button class="saved-row" onClick={() => props.onSaved(profile)} disabled={props.busy}>
                  <span class={`kind-logo ${profile.driver === 'PostgreSQL' ? 'postgres' : 'sqlite'}`}>
                    {profile.driver === 'PostgreSQL' ? 'PG' : 'SQ'}
                  </span>
                  <span>
                    <b>{profile.name}</b>
                    <small>
                      {profile.driver === 'PostgreSQL'
                        ? `${profile.host}:${profile.port}/${profile.database}`
                        : profile.path}
                    </small>
                  </span>
                  <Show when={profile.hasPassword}>
                    <Key size={13} />
                  </Show>
                  <ChevronRight size={14} />
                </button>
                <button
                  class="icon-button saved-edit"
                  aria-label={`Edit ${profile.name}`}
                  title="Edit connection"
                  onClick={() => props.onEdit(profile)}
                  disabled={props.busy}
                >
                  <Edit size={13} />
                </button>
                <button
                  class="icon-button saved-remove"
                  aria-label={`Delete ${profile.name}`}
                  onClick={() => props.onRemove(profile.id)}
                  disabled={props.busy}
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}

export const DEFAULT_POSTGRES_CONFIG: PostgresConfig = {
  id: '',
  name: 'Local PostgreSQL',
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '',
  database: 'postgres',
  sslMode: 'prefer',
  sslRootCert: '',
  sslClientCert: '',
  sslClientKey: '',
  tlsServerName: '',
  readOnly: false,
  saveConnection: true,
  savePassword: true,
}

export function configForSaved(profile: SavedConnection): PostgresConfig {
  const host = profile.host ?? 'localhost'
  return {
    ...DEFAULT_POSTGRES_CONFIG,
    id: profile.id,
    name: profile.name,
    host,
    port: profile.port ?? 5432,
    user: profile.user ?? 'postgres',
    database: profile.database ?? 'postgres',
    sslMode: (profile.sslMode as PostgresConfig['sslMode']) ?? (localPostgresHost(host) ? 'prefer' : 'verify-full'),
    sslRootCert: profile.sslRootCert ?? '',
    sslClientCert: profile.sslClientCert ?? '',
    sslClientKey: profile.sslClientKey ?? '',
    tlsServerName: profile.tlsServerName ?? '',
    readOnly: profile.readOnly,
    savePassword: profile.hasPassword,
  }
}

const localPostgresHost = (host: string) =>
  /^(localhost|127(?:\.\d+){3}|\[?::1\]?)$/i.test(host.trim()) || host.trim().startsWith('/')

const weakPostgresTLS = (host: string, mode: PostgresConfig['sslMode']) =>
  !localPostgresHost(host) && mode !== 'verify-ca' && mode !== 'verify-full'

export function Welcome(
  props: SavedConnectionsProps & { onOpen: () => void; onPostgres: () => void; onDemo: () => void },
) {
  return (
    <main class="welcome">
      <div class="welcome-glow" />
      <div class={`welcome-content ${props.saved.length ? 'has-saved' : ''}`}>
        <div class="welcome-mark">
          <Database size={34} />
        </div>
        <p class="eyebrow">DATABASE WORKSPACE</p>
        <h1>
          Your data, without
          <br />
          <span>the noise.</span>
        </h1>
        <p class="welcome-copy">
          A fast, focused database browser for inspecting schemas, exploring records, and running safe queries.
        </p>
        <SavedConnections
          saved={props.saved}
          busy={props.busy}
          onSaved={props.onSaved}
          onEdit={props.onEdit}
          onRemove={props.onRemove}
        />
        <div class="welcome-actions">
          <button class="primary large" onClick={props.onOpen} disabled={props.busy}>
            <File size={17} /> Open SQLite database
          </button>
          <button class="secondary large postgres-button" onClick={props.onPostgres} disabled={props.busy}>
            <Database size={16} /> Connect PostgreSQL
          </button>
        </div>
        <button class="demo-link" onClick={props.onDemo} disabled={props.busy}>
          <Play size={13} /> Explore with demo data
        </button>
        <div class="welcome-features">
          <span>
            <Check size={14} /> Native desktop app
          </span>
          <span>
            <Check size={14} /> Read-only by default
          </span>
          <span>
            <Check size={14} /> Data stays local
          </span>
        </div>
      </div>
    </main>
  )
}

export function ConnectionFailureModal(props: { session: WorkspaceSession; onEdit: () => void; onClose: () => void }) {
  const switchingDatabase = () => Boolean(props.session.retryDatabase)
  return (
    <div class="modal-backdrop connection-failure-backdrop">
      <section
        class="connection-failure-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="connection-failure-title"
        aria-describedby="connection-failure-copy"
      >
        <div class="connection-failure-icon">
          <Alert size={23} />
        </div>
        <h3 id="connection-failure-title">Connection failed</h3>
        <p id="connection-failure-copy">
          QueryNest couldn’t open <b>{switchingDatabase() ? props.session.database : props.session.name}</b>.{' '}
          {switchingDatabase()
            ? 'Try opening this database again, or close this workspace.'
            : 'Edit its connection details and try again, or close this workspace.'}
        </p>
        <div class="failed-connection-summary">
          <span class={`kind-logo ${props.session.driver === 'PostgreSQL' ? 'postgres' : 'sqlite'}`}>
            {props.session.driver === 'PostgreSQL' ? 'PG' : 'SQ'}
          </span>
          <span>
            <b>{props.session.name}</b>
            <small>{props.session.path}</small>
          </span>
        </div>
        <footer>
          <button class="secondary" onClick={props.onClose}>
            Close connection
          </button>
          <button class="primary" onClick={props.onEdit}>
            {switchingDatabase() ? <Refresh size={15} /> : <Settings size={15} />}{' '}
            {switchingDatabase() ? 'Try again' : 'Edit connection'}
          </button>
        </footer>
      </section>
    </div>
  )
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
  const selected = () => props.options.find((option) => option.value === props.value) ?? props.options[0]

  createEffect(() => {
    if (!open()) return
    const closeOutside = (event: MouseEvent) => {
      if (!root?.contains(event.target as Node)) setOpen(false)
    }
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger?.focus()
      }
    }
    document.addEventListener('mousedown', closeOutside)
    window.addEventListener('keydown', closeWithEscape)
    onCleanup(() => {
      document.removeEventListener('mousedown', closeOutside)
      window.removeEventListener('keydown', closeWithEscape)
    })
  })

  function moveFocus(current: HTMLButtonElement, direction: number) {
    const items = Array.from(root?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const index = items.indexOf(current)
    items[(index + direction + items.length) % items.length]?.focus()
  }

  return (
    <div ref={root} class={`custom-select ${open() ? 'open' : ''}`}>
      <button
        ref={trigger}
        type="button"
        class="custom-select-trigger"
        disabled={props.disabled}
        aria-label={`${props.label}: ${selected()?.label ?? props.value}`}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            requestAnimationFrame(() =>
              root?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus(),
            )
          }
        }}
      >
        <span>{selected()?.label}</span>
        <ChevronDown size={14} />
      </button>
      <Show when={open()}>
        <div class="custom-select-menu" role="listbox" aria-label={props.label}>
          <For each={props.options}>
            {(option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === props.value}
                onClick={() => {
                  props.onChange(option.value)
                  setOpen(false)
                  trigger?.focus()
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    moveFocus(event.currentTarget, 1)
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    moveFocus(event.currentTarget, -1)
                  }
                }}
              >
                <span>
                  <b>{option.label}</b>
                  <Show when={option.description}>
                    <small>{option.description}</small>
                  </Show>
                </span>
                <Show when={option.value === props.value}>
                  <Check size={14} />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export function ConnectionModal(
  props: SavedConnectionsProps & {
    config: PostgresConfig
    setConfig: Setter<PostgresConfig>
    onSQLite: () => void
    onPostgres: (config: PostgresConfig) => Promise<void>
    onError: (message: string) => void
    onClose: () => void
  },
) {
  const [submitting, setSubmitting] = createSignal(false)
  const [testing, setTesting] = createSignal(false)
  const [success, setSuccess] = createSignal('')
  const pending = () => props.busy || submitting() || testing()
  const update = <K extends keyof PostgresConfig>(key: K, value: PostgresConfig[K]) =>
    props.setConfig((current) => ({ ...current, [key]: value }))
  const updateHost = (host: string) =>
    props.setConfig((current) => ({
      ...current,
      host,
      sslMode:
        localPostgresHost(current.host) && !localPostgresHost(host) && current.sslMode === 'prefer'
          ? 'verify-full'
          : current.sslMode,
    }))

  createEffect(
    on(
      () => props.config,
      () => setSuccess(''),
    ),
  )

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
    } catch (e) {
      props.onError(String(e).replace(/^Error:\s*/i, ''))
    } finally {
      setSubmitting(false)
      setTesting(false)
    }
  }

  return (
    <div
      class="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending()) props.onClose()
      }}
    >
      <section class="connection-modal" role="dialog" aria-modal="true" aria-label="New database connection">
        <header>
          <div class="modal-mark">
            <Database size={19} />
          </div>
          <div>
            <h3>New connection</h3>
            <p>Connect securely to your database</p>
          </div>
          <button class="icon-button" aria-label="Close connection form" disabled={pending()} onClick={props.onClose}>
            <X size={17} />
          </button>
        </header>
        <SavedConnections
          saved={props.saved}
          busy={pending()}
          onSaved={props.onSaved}
          onEdit={props.onEdit}
          onRemove={props.onRemove}
        />
        <div class="connection-kinds">
          <button class="kind-card" onClick={props.onSQLite} disabled={pending()}>
            <span class="kind-logo sqlite">SQ</span>
            <span>
              <b>SQLite</b>
              <small>Open a local database file</small>
            </span>
            <ChevronRight size={15} />
          </button>
          <div class="kind-card active">
            <span class="kind-logo postgres">PG</span>
            <span>
              <b>PostgreSQL</b>
              <small>Host and credentials</small>
            </span>
            <Check size={15} />
          </div>
        </div>
        <form onSubmit={submit}>
          <fieldset disabled={pending()}>
            <div class="form-grid">
              <label class="span-2">
                <span>Connection name</span>
                <input
                  required
                  value={props.config.name}
                  onInput={(e) => update('name', e.currentTarget.value)}
                  placeholder="Production database"
                />
              </label>
              <label class="span-2">
                <span>Host</span>
                <input
                  required
                  value={props.config.host}
                  onInput={(e) => updateHost(e.currentTarget.value)}
                  placeholder="localhost"
                  ref={(el) => queueMicrotask(() => el.focus())}
                />
              </label>
              <label>
                <span>Port</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={props.config.port}
                  onInput={(e) => update('port', Number(e.currentTarget.value))}
                />
              </label>
              <div class="form-field">
                <span>SSL mode</span>
                <CustomSelect
                  label="SSL mode"
                  value={props.config.sslMode}
                  options={SSL_MODE_OPTIONS}
                  disabled={pending()}
                  onChange={(value) => update('sslMode', value as PostgresConfig['sslMode'])}
                />
              </div>
              <label class="span-2">
                <span>Database</span>
                <input
                  required
                  value={props.config.database}
                  onInput={(e) => update('database', e.currentTarget.value)}
                  placeholder="postgres"
                />
              </label>
              <label>
                <span>User</span>
                <input
                  required
                  value={props.config.user}
                  onInput={(e) => update('user', e.currentTarget.value)}
                  placeholder="postgres"
                  autocomplete="username"
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  value={props.config.password}
                  onInput={(e) => update('password', e.currentTarget.value)}
                  placeholder="Optional"
                  autocomplete="current-password"
                />
              </label>
              <label class="span-2">
                <span>Root CA certificate</span>
                <input
                  value={props.config.sslRootCert}
                  onInput={(e) => update('sslRootCert', e.currentTarget.value)}
                  placeholder="Optional path to CA certificate"
                />
              </label>
              <label>
                <span>Client certificate</span>
                <input
                  value={props.config.sslClientCert}
                  onInput={(e) => update('sslClientCert', e.currentTarget.value)}
                  placeholder="Optional certificate path"
                />
              </label>
              <label>
                <span>Client key</span>
                <input
                  value={props.config.sslClientKey}
                  onInput={(e) => update('sslClientKey', e.currentTarget.value)}
                  placeholder="Optional private-key path"
                />
              </label>
              <label class="span-2">
                <span>TLS server name</span>
                <input
                  value={props.config.tlsServerName}
                  onInput={(e) => update('tlsServerName', e.currentTarget.value)}
                  placeholder="Defaults to the connection host"
                />
              </label>
            </div>
            <div class="connection-options">
              <label>
                <input
                  type="checkbox"
                  checked={props.config.saveConnection}
                  onChange={(e) => update('saveConnection', e.currentTarget.checked)}
                />
                <span>Save connection</span>
              </label>
              <label class={!props.config.saveConnection ? 'disabled' : ''}>
                <input
                  type="checkbox"
                  checked={props.config.savePassword}
                  disabled={!props.config.saveConnection}
                  onChange={(e) => update('savePassword', e.currentTarget.checked)}
                />
                <span>Save password securely</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={props.config.readOnly}
                  onChange={(e) => update('readOnly', e.currentTarget.checked)}
                />
                <span>Read-only</span>
              </label>
            </div>
          </fieldset>
          <Show when={weakPostgresTLS(props.config.host, props.config.sslMode)}>
            <div class="connection-feedback warning" role="alert">
              <Alert size={15} />
              <span>
                This mode does not authenticate a remote PostgreSQL server and may permit interception. Use Verify full
                whenever possible.
              </span>
            </div>
          </Show>
          <Show when={success()}>
            <div class="connection-feedback success" role="status">
              <Check size={15} />
              <span>{success()}</span>
            </div>
          </Show>
          <footer>
            <button type="button" class="secondary" onClick={props.onClose} disabled={pending()}>
              Cancel
            </button>
            <button type="submit" name="action" value="connect" class="primary" disabled={pending()}>
              {submitting() ? <Refresh size={15} class="spin" /> : <Database size={15} />}{' '}
              {submitting() ? 'Connecting…' : 'Connect'}
            </button>
            <button type="submit" name="action" value="test" class="secondary test-connection" disabled={pending()}>
              {testing() ? <Refresh size={15} class="spin" /> : <Play size={15} />}{' '}
              {testing() ? 'Testing…' : 'Test connection'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

export function SavedConnectionEditModal(props: {
  profile: SavedConnection
  busy: boolean
  onSave: (profile: SavedConnectionUpdate) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = createSignal<SavedConnectionUpdate>({
    ...props.profile,
    password: '',
    savePassword: props.profile.hasPassword,
  })
  const [saving, setSaving] = createSignal(false)
  const pending = () => props.busy || saving()
  const update = <K extends keyof SavedConnectionUpdate>(key: K, value: SavedConnectionUpdate[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  onMount(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending()) props.onClose()
    }
    window.addEventListener('keydown', close)
    onCleanup(() => window.removeEventListener('keydown', close))
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (pending()) return
    setSaving(true)
    try {
      await props.onSave(draft())
    } finally {
      setSaving(false)
    }
  }

  const postgres = () => props.profile.driver === 'PostgreSQL'
  return (
    <div
      class="modal-backdrop saved-editor-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending()) props.onClose()
      }}
    >
      <section
        class="connection-modal saved-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-editor-title"
      >
        <header>
          <div class="modal-mark">
            <Edit size={18} />
          </div>
          <div>
            <h3 id="saved-editor-title">Edit saved connection</h3>
            <p>{postgres() ? 'Update PostgreSQL connection details' : 'Update SQLite connection details'}</p>
          </div>
          <button
            class="icon-button"
            aria-label="Close saved connection editor"
            disabled={pending()}
            onClick={props.onClose}
          >
            <X size={17} />
          </button>
        </header>
        <form onSubmit={submit}>
          <fieldset disabled={pending()}>
            <div class="saved-editor-summary">
              <span class={`kind-logo ${postgres() ? 'postgres' : 'sqlite'}`}>{postgres() ? 'PG' : 'SQ'}</span>
              <span>
                <b>{props.profile.name}</b>
                <small>{props.profile.driver}</small>
              </span>
              <Show when={props.profile.hasPassword}>
                <span class={`saved-password-note ${draft().savePassword ? '' : 'remove'}`}>
                  <Key size={13} />{' '}
                  {draft().savePassword ? 'Password stays in system storage' : 'Saved password will be removed'}
                </span>
              </Show>
            </div>
            <div class="form-grid">
              <label class="span-2">
                <span>Connection name</span>
                <input
                  required
                  value={draft().name}
                  onInput={(event) => update('name', event.currentTarget.value)}
                  ref={(el) => queueMicrotask(() => el.focus())}
                />
              </label>
              <Show
                when={postgres()}
                fallback={
                  <label class="span-2">
                    <span>Database file</span>
                    <input
                      required
                      value={draft().path ?? ''}
                      onInput={(event) => update('path', event.currentTarget.value)}
                    />
                  </label>
                }
              >
                <label class="span-2">
                  <span>Host</span>
                  <input
                    required
                    value={draft().host ?? ''}
                    onInput={(event) => update('host', event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>Port</span>
                  <input
                    required
                    type="number"
                    min={1}
                    max={65535}
                    value={draft().port ?? 5432}
                    onInput={(event) => update('port', Number(event.currentTarget.value))}
                  />
                </label>
                <div class="form-field">
                  <span>SSL mode</span>
                  <CustomSelect
                    label="SSL mode"
                    value={draft().sslMode ?? 'prefer'}
                    options={SSL_MODE_OPTIONS}
                    disabled={pending()}
                    onChange={(value) => update('sslMode', value)}
                  />
                </div>
                <label class="span-2">
                  <span>Database</span>
                  <input
                    required
                    value={draft().database ?? ''}
                    onInput={(event) => update('database', event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>User</span>
                  <input
                    required
                    value={draft().user ?? ''}
                    onInput={(event) => update('user', event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={draft().password ?? ''}
                    disabled={!draft().savePassword}
                    onInput={(event) => update('password', event.currentTarget.value)}
                    placeholder={props.profile.hasPassword ? 'Leave blank to keep current' : 'Optional'}
                    autocomplete="new-password"
                  />
                </label>
                <label class="span-2">
                  <span>Root CA certificate</span>
                  <input
                    value={draft().sslRootCert ?? ''}
                    onInput={(event) => update('sslRootCert', event.currentTarget.value)}
                    placeholder="Optional path to CA certificate"
                  />
                </label>
                <label>
                  <span>Client certificate</span>
                  <input
                    value={draft().sslClientCert ?? ''}
                    onInput={(event) => update('sslClientCert', event.currentTarget.value)}
                    placeholder="Optional certificate path"
                  />
                </label>
                <label>
                  <span>Client key</span>
                  <input
                    value={draft().sslClientKey ?? ''}
                    onInput={(event) => update('sslClientKey', event.currentTarget.value)}
                    placeholder="Optional private-key path"
                  />
                </label>
                <label class="span-2">
                  <span>TLS server name</span>
                  <input
                    value={draft().tlsServerName ?? ''}
                    onInput={(event) => update('tlsServerName', event.currentTarget.value)}
                    placeholder="Defaults to the connection host"
                  />
                </label>
              </Show>
            </div>
            <Show when={postgres()}>
              <div class="connection-options">
                <label>
                  <input
                    type="checkbox"
                    checked={draft().savePassword}
                    onChange={(event) => update('savePassword', event.currentTarget.checked)}
                  />
                  <span>Save password securely</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft().readOnly}
                    onChange={(event) => update('readOnly', event.currentTarget.checked)}
                  />
                  <span>Read-only</span>
                </label>
              </div>
            </Show>
          </fieldset>
          <Show
            when={
              postgres() &&
              weakPostgresTLS(draft().host ?? '', (draft().sslMode ?? 'prefer') as PostgresConfig['sslMode'])
            }
          >
            <div class="connection-feedback warning" role="alert">
              <Alert size={15} />
              <span>
                This mode does not authenticate a remote PostgreSQL server and may permit interception. Use Verify full
                whenever possible.
              </span>
            </div>
          </Show>
          <footer>
            <button type="button" class="secondary" onClick={props.onClose} disabled={pending()}>
              Cancel
            </button>
            <button type="submit" class="primary" disabled={pending()}>
              {saving() ? <Refresh size={15} class="spin" /> : <Save size={15} />}{' '}
              {saving() ? 'Saving…' : 'Save changes'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
