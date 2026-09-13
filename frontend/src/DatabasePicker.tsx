import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { api } from './bridge'
import type { ConnectionStatus } from './types'
import { Alert, Check, ChevronDown, Database, Plus, Refresh, Search, X } from './icons'

export default function DatabasePicker(props: { status: ConnectionStatus; onSelect: (database: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const [databases, setDatabases] = createSignal<string[]>([])
  const [filter, setFilter] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [retry, setRetry] = createSignal(0)
  const [creating, setCreating] = createSignal(false)
  const [createName, setCreateName] = createSignal('')
  const [createError, setCreateError] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)
  let container!: HTMLDivElement
  let trigger!: HTMLButtonElement

  createEffect(() => {
    if (!open()) return
    const id = props.status.id
    retry()
    let cancelled = false
    onCleanup(() => { cancelled = true })
    setLoading(true); setError(''); setFilter(''); setDatabases([]); setCreating(false); setCreateName(''); setCreateError('')
    api().ListDatabases(id).then(next => { if (!cancelled) setDatabases(next ?? []) })
      .catch(e => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
  })

  createEffect(() => {
    if (!open()) return
    const outside = (event: PointerEvent) => { if (!container?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (creating()) { setCreating(false); setCreateName(''); setCreateError('') }
      else { setOpen(false); trigger?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    onCleanup(() => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) })
  })

  async function createDatabase(event: SubmitEvent) {
    event.preventDefault()
    const name = createName().trim()
    if (!name || submitting()) return
    setSubmitting(true); setCreateError('')
    try {
      await api().CreateDatabase(props.status.id, name)
      setDatabases(current => [...new Set([...current, name])].sort((left, right) => left.localeCompare(right)))
      setOpen(false); trigger?.focus(); props.onSelect(name)
    } catch (error) {
      setCreateError(String(error).replace(/^Error:\s*/i, ''))
    } finally { setSubmitting(false) }
  }

  const filtered = () => databases().filter(name => name.toLowerCase().includes(filter().toLowerCase()))
  return <div class="database-picker" ref={container}>
    <button class="database-picker-trigger" ref={trigger} aria-label={`Choose database: ${props.status.database}`} aria-haspopup="dialog" aria-expanded={open()} title={props.status.database} onClick={() => setOpen(value => !value)}><Database size={16}/><span>{props.status.database}</span><ChevronDown size={13} class={open() ? '' : 'flip-vertical'}/></button>
    <Show when={open()}><section class="database-menu" role="dialog" aria-label="Databases">
      <header><b>Databases</b><span>{props.status.driver === 'PostgreSQL' ? props.status.name : 'SQLite'}</span></header>
      <label class="database-menu-search"><Search size={14}/><input ref={el => queueMicrotask(() => el.focus())} aria-label="Search databases" placeholder="Search databases…" value={filter()} onInput={event => setFilter(event.currentTarget.value)}/></label>
      <Show when={!loading()} fallback={<div class="database-menu-message" role="status"><Refresh size={14} class="spin"/> Loading databases…</div>}>
        <Show when={!error()} fallback={<div class="database-menu-message error" role="alert"><Alert size={15}/><span>{error()}</span><button class="secondary" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}>
          <div class="database-menu-list">
            <For each={filtered()}>{name => <button class={name === props.status.database ? 'active' : ''} title={name} aria-pressed={name === props.status.database} onClick={() => { setOpen(false); trigger?.focus(); props.onSelect(name) }}><Database size={15}/><span>{name}</span><Show when={name === props.status.database}><Check size={14}/></Show></button>}</For>
            <Show when={!filtered().length}><p class="database-menu-message">No databases found.</p></Show>
          </div>
          <Show when={props.status.driver === 'PostgreSQL'}>
            <Show when={!creating()} fallback={
              <form class="database-create-form" onSubmit={createDatabase}>
                <div><label for="new-database-name">Database name</label><button type="button" disabled={submitting()} aria-label="Cancel database creation" onClick={() => { setCreating(false); setCreateName(''); setCreateError('') }}><X size={13}/></button></div>
                <input id="new-database-name" ref={element => queueMicrotask(() => element.focus())} value={createName()} maxlength="63" autocomplete="off" placeholder="e.g. analytics_dev" disabled={submitting()} onInput={event => setCreateName(event.currentTarget.value)}/>
                <Show when={createError()}><p role="alert">{createError()}</p></Show>
                <button type="submit" class="primary" disabled={!createName().trim() || submitting()}>{submitting() ? <Refresh size={13} class="spin"/> : <Plus size={13}/>} {submitting() ? 'Creating…' : 'Create & open'}</button>
              </form>
            }>
              <button class="database-create-button" disabled={props.status.readOnly} title={props.status.readOnly ? 'Reconnect with editing enabled to create a database' : 'Create a PostgreSQL database'} onClick={() => { setCreating(true); setCreateError(''); setFilter('') }}><Plus size={14}/><span>Create database</span></button>
            </Show>
          </Show>
        </Show>
      </Show>
    </section></Show>
  </div>
}
