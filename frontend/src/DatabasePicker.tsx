import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { api } from './bridge'
import type { ConnectionStatus } from './types'
import { Alert, Check, ChevronDown, Database, Refresh, Search } from './icons'

export default function DatabasePicker(props: { status: ConnectionStatus; onSelect: (database: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const [databases, setDatabases] = createSignal<string[]>([])
  const [filter, setFilter] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [retry, setRetry] = createSignal(0)
  let container!: HTMLDivElement
  let trigger!: HTMLButtonElement

  createEffect(() => {
    if (!open()) return
    const id = props.status.id
    retry()
    let cancelled = false
    onCleanup(() => { cancelled = true })
    setLoading(true); setError(''); setFilter(''); setDatabases([])
    api().ListDatabases(id).then(next => { if (!cancelled) setDatabases(next ?? []) })
      .catch(e => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
  })

  createEffect(() => {
    if (!open()) return
    const outside = (event: PointerEvent) => { if (!container?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    onCleanup(() => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) })
  })

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
        </Show>
      </Show>
    </section></Show>
  </div>
}
