import { createEffect, createSignal, For, Index, on, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { ColumnInfo, IndexInfo, TableSummary } from '../../types'
import { Alert, ChevronDown, ChevronRight, Columns, Eye, Key, Refresh, Table } from '../../components/ui/icons'

export type ContextMenuAction = {
  label: string
  icon: JSX.Element
  run: () => void
  danger?: boolean
  separator?: boolean
}
export type MouseEventOn<T extends Element> = MouseEvent & { currentTarget: T }

export function ObjectGroup(props: { label: string; count: number; children: JSX.Element }) {
  const [open, setOpen] = createSignal(true)
  return (
    <div class={`object-group ${open() ? 'open' : ''}`}>
      <button class="group-title" onClick={() => setOpen((value) => !value)} aria-expanded={open()}>
        {open() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{props.label}</span>
        <em>{props.count}</em>
      </button>
      <Show when={open()}>
        <div class="object-children">{props.children}</div>
      </Show>
    </div>
  )
}

export function ObjectRow(props: {
  item: TableSummary
  stagger: number
  active: boolean
  selected: boolean
  countLoading: boolean
  onClick: (event: MouseEventOn<HTMLButtonElement>) => void
  onContextMenu: (event: MouseEventOn<HTMLButtonElement>) => void
}) {
  return (
    <button
      title={`${props.item.schema}.${props.item.name}`}
      aria-selected={props.selected}
      style={{ '--stagger': String(props.stagger) }}
      class={`object-row ${props.active ? 'active' : ''} ${props.selected ? 'selected' : ''}`}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
    >
      {props.item.type === 'view' ? <Eye size={14} /> : <Table size={14} />}
      <span>{props.item.name}</span>
      <small>
        {props.countLoading ? (
          <i class="row-count-skeleton" aria-label="Loading row count" />
        ) : props.item.rows >= 0 ? (
          props.item.rows.toLocaleString()
        ) : (
          '—'
        )}
      </small>
    </button>
  )
}

export function ContextMenu(props: {
  x: number
  y: number
  label: string
  actions: ContextMenuAction[]
  onClose: () => void
}) {
  let menu!: HTMLDivElement
  const left = () => Math.max(8, Math.min(props.x, window.innerWidth - 216))
  const top = () => Math.max(42, Math.min(props.y, window.innerHeight - props.actions.length * 35 - 18))

  createEffect(
    on(
      () => [props.x, props.y] as const,
      () => {
        menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
      },
    ),
  )

  onMount(() => {
    const pointer = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node)) props.onClose()
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        props.onClose()
        return
      }
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

  return (
    <div
      ref={menu}
      class="context-menu"
      role="menu"
      aria-label={props.label}
      style={{ left: `${left()}px`, top: `${top()}px` }}
    >
      <For each={props.actions}>
        {(action) => (
          <button
            role="menuitem"
            class={`${action.separator ? 'separator' : ''} ${action.danger ? 'danger' : ''}`}
            onClick={() => {
              props.onClose()
              action.run()
            }}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        )}
      </For>
    </div>
  )
}

export function SidebarSkeleton() {
  return (
    <div class="sidebar-skeleton" role="status" aria-label="Loading database objects">
      <i class="skeleton-line heading" />
      <Index each={[72, 88, 64, 80, 58]}>
        {(width) => <i class="skeleton-line row" style={{ width: `${width()}%` }} />}
      </Index>
      <i class="skeleton-line heading short" />
      <Index each={[68, 82]}>{(width) => <i class="skeleton-line row" style={{ width: `${width()}%` }} />}</Index>
    </div>
  )
}

export function WorkspaceSkeleton() {
  const widths = [44, 160, 200, 150, 180]
  return (
    <div class="workspace-skeleton" role="status" aria-label="Loading database">
      <div class="skeleton-header">
        <span>
          <i />
          <i />
        </span>
        <i />
      </div>
      <div class="skeleton-toolbar">
        <i />
        <i />
        <span />
        <i />
      </div>
      <div class="skeleton-grid">
        <div>
          <Index each={widths}>{(width) => <i style={{ width: `${width()}px` }} />}</Index>
        </div>
        <Index each={Array.from({ length: 7 }, (_, row) => row)}>
          {(row) => (
            <div>
              <Index each={widths}>
                {(width, column) => <i style={{ width: `${width() - 24 - ((row() + column) % 3) * 18}px` }} />}
              </Index>
            </div>
          )}
        </Index>
      </div>
    </div>
  )
}

export function TableLoadError(props: { message: string; onRetry: () => void }) {
  return (
    <div class="table-load-error" role="alert">
      <span>
        <Alert size={22} />
      </span>
      <h3>Could not load this table</h3>
      <p>{props.message}</p>
      <button class="secondary" onClick={props.onRetry}>
        <Refresh size={14} /> Try again
      </button>
    </div>
  )
}

export function SchemaView(props: { schema: ColumnInfo[]; indexes: IndexInfo[]; error: string }) {
  return (
    <div class="schema-wrap structure-wrap">
      <Show when={props.error}>
        <div class="structure-error" role="alert">
          <Alert size={15} />
          <span>{props.error}</span>
        </div>
      </Show>
      <section class="structure-section">
        <header>
          <h3>Columns</h3>
          <span>{props.schema.length}</span>
        </header>
        <table class="schema-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Key</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.schema}>
              {(column, index) => (
                <tr style={{ '--stagger': String(index()) }}>
                  <td>
                    <span class="field-icon">{column.primaryKey ? <Key size={13} /> : <Columns size={13} />}</span>
                    <b>{column.name}</b>
                  </td>
                  <td>
                    <code>{column.type || 'ANY'}</code>
                  </td>
                  <td>{column.nullable ? 'YES' : 'NO'}</td>
                  <td>{column.default === null ? <span class="muted">—</span> : String(column.default)}</td>
                  <td>
                    {column.primaryKey ? (
                      <span class="primary-key">
                        <Key size={12} /> PRIMARY
                      </span>
                    ) : (
                      <span class="muted">—</span>
                    )}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
      <section class="structure-section indexes-section">
        <header>
          <h3>Indexes</h3>
          <span>{props.indexes.length}</span>
        </header>
        <Show
          when={props.indexes.length}
          fallback={
            <div class="empty-indexes">
              <Key size={17} />
              <span>No indexes</span>
            </div>
          }
        >
          <table class="schema-table indexes-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns / Expressions</th>
                <th>Type</th>
                <th>Properties</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.indexes}>
                {(index, position) => (
                  <tr style={{ '--stagger': String(position()) }}>
                    <td>
                      <span class="field-icon">
                        <Key size={13} />
                      </span>
                      <b>{index.name}</b>
                    </td>
                    <td>
                      <code>{index.columns.join(', ') || '—'}</code>
                    </td>
                    <td>{index.type || '—'}</td>
                    <td>
                      <div class="index-properties">
                        <Show when={index.primary}>
                          <span class="primary">PRIMARY</span>
                        </Show>
                        <Show when={index.unique}>
                          <span class="unique">UNIQUE</span>
                        </Show>
                        <Show when={index.partial}>
                          <span>PARTIAL</span>
                        </Show>
                        <Show when={!index.primary && !index.unique && !index.partial}>
                          <span>INDEX</span>
                        </Show>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </section>
    </div>
  )
}
