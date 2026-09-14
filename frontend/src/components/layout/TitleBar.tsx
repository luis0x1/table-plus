import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { isDesktop, windowAction } from '../../lib/backend/bridge'
import type { DatabaseActivity } from '../../features/workspace/DatabaseWorkspace'
import { Check, Clock, Pending, Refresh, Settings, X } from '../ui/icons'

function activitySummary(statement: string) {
  const compact = statement.replace(/\s+/g, ' ').trim()
  return compact.length > 110 ? `${compact.slice(0, 107)}…` : compact
}

function ActivityCenter(props: {
  activities: DatabaseActivity[]
  onCancel: (id: string) => void
  onCancelAll: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  let root!: HTMLDivElement

  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    const close = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    onCleanup(() => {
      window.clearInterval(timer)
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', escape)
    })
  })

  const elapsed = (startedAt: number) => {
    const seconds = Math.max(0, Math.floor((now() - startedAt) / 1000))
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }

  return (
    <div ref={root} class="activity-center">
      <button
        class={`icon-button activity-trigger ${props.activities.length ? 'active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        onDblClick={(event) => event.stopPropagation()}
        aria-label="Pending database commands"
        aria-expanded={open()}
        title="Pending database commands"
      >
        <Pending size={15} />
        <Show when={props.activities.length}>
          <b>{props.activities.length > 9 ? '9+' : props.activities.length}</b>
        </Show>
      </button>
      <Show when={open()}>
        <section class="activity-popover" onDblClick={(event) => event.stopPropagation()}>
          <header>
            <div>
              <b>Pending commands</b>
              <span>
                {props.activities.length
                  ? `${props.activities.length} active or queued`
                  : 'Database activity will appear here'}
              </span>
            </div>
            <Show when={props.activities.length}>
              <button class="cancel-all" onClick={props.onCancelAll}>
                Cancel all
              </button>
            </Show>
          </header>
          <Show
            when={props.activities.length}
            fallback={
              <div class="activity-empty">
                <Check size={18} />
                <b>No pending commands</b>
                <span>All database operations are complete.</span>
              </div>
            }
          >
            <div class="activity-list">
              <For each={props.activities}>
                {(activity) => (
                  <article class={`activity-item ${activity.status}`}>
                    <div class="activity-state">
                      <Show
                        when={activity.status === 'queued'}
                        fallback={<Refresh size={14} class={activity.status === 'running' ? 'spin' : ''} />}
                      >
                        <Clock size={14} />
                      </Show>
                    </div>
                    <div class="activity-copy">
                      <div>
                        <b>{activity.source === 'script' ? 'SQL script' : 'Database change'}</b>
                        <span>{activity.database}</span>
                        <time>
                          {activity.status === 'queued'
                            ? 'Queued'
                            : activity.status === 'cancelling'
                              ? 'Cancelling…'
                              : elapsed(activity.startedAt)}
                        </time>
                      </div>
                      <code title={activity.statement}>{activitySummary(activity.statement)}</code>
                    </div>
                    <button
                      class="activity-cancel"
                      disabled={activity.status === 'cancelling'}
                      onClick={() => props.onCancel(activity.id)}
                      aria-label={`Cancel ${activitySummary(activity.statement)}`}
                      title="Cancel command"
                    >
                      <X size={14} />
                    </button>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  )
}

export default function TitleBar(props: {
  activities: DatabaseActivity[]
  onCancel: (id: string) => void
  onCancelAll: () => void
  onSettings: () => void
}) {
  return (
    <div class="titlebar" onDblClick={() => windowAction('maximise')}>
      <div class="traffic-lights">
        <button aria-label="Close" onClick={() => windowAction('close')} />
        <button aria-label="Minimise" onClick={() => windowAction('minimise')} />
        <button aria-label="Maximise" onClick={() => windowAction('maximise')} />
      </div>
      <div class="drag-title">QueryNest</div>
      <div class="titlebar-actions">
        <ActivityCenter activities={props.activities} onCancel={props.onCancel} onCancelAll={props.onCancelAll} />
        <button
          class="icon-button appearance-trigger"
          onClick={props.onSettings}
          onDblClick={(event) => event.stopPropagation()}
          aria-label="Appearance settings"
          title="Appearance settings"
        >
          <Settings size={15} />
        </button>
        <div class="build-tag">{isDesktop() ? 'LOCAL' : 'BROWSER PREVIEW'}</div>
      </div>
    </div>
  )
}
