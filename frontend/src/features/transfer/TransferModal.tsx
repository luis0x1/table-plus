import { For, Index, onCleanup, onMount, Show } from 'solid-js'
import type { TableRef, TransferPreview } from '../../types'
import { Alert, File, Plus, Refresh, Save, Table, X } from '../../components/ui/icons'

export type TransferState = {
  preview: TransferPreview
  tables: TableRef[]
  format: 'csv' | 'csv-raw' | 'json'
  conflict: 'abort' | 'skip'
  restoreCode: boolean
}

export default function TransferModal(props: {
  state: TransferState
  busy: boolean
  onChange: (next: TransferState) => void
  onClose: () => void
  onRun: () => void
}) {
  const preview = () => props.state.preview
  const first = () => preview().tables[0]
  const incompatible = () =>
    preview().kind === 'import' && Boolean(first()?.extraColumns?.length || first()?.requiredMissing?.length)
  const noWork = () =>
    preview().kind === 'restore' && preview().format === 'sql' ? !preview().statements : !preview().tables.length
  const title = () => {
    const kind = preview().kind
    return kind === 'backup'
      ? 'Back up database'
      : kind === 'restore'
        ? 'Restore database'
        : kind === 'export'
          ? `Export ${preview().tables.length === 1 ? 'table' : 'tables'}`
          : 'Import table'
  }
  const action = () => {
    const kind = preview().kind
    return kind === 'backup'
      ? 'Choose location & back up'
      : kind === 'restore'
        ? 'Restore database'
        : kind === 'export'
          ? 'Choose location & export'
          : 'Import data'
  }

  onMount(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) props.onClose()
    }
    window.addEventListener('keydown', close)
    onCleanup(() => window.removeEventListener('keydown', close))
  })

  return (
    <div
      class="modal-backdrop transfer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onClose()
      }}
    >
      <section class="transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
        <header>
          <div class={`modal-mark ${preview().kind === 'restore' || preview().kind === 'import' ? 'warning' : ''}`}>
            {preview().kind === 'backup' ? (
              <Save size={18} />
            ) : preview().kind === 'restore' ? (
              <Refresh size={18} />
            ) : preview().kind === 'export' ? (
              <File size={18} />
            ) : (
              <Plus size={18} />
            )}
          </div>
          <div>
            <h3 id="transfer-title">{title()}</h3>
            <p>
              {preview().database} · {preview().driver}
            </p>
          </div>
          <button class="icon-button" disabled={props.busy} onClick={props.onClose} aria-label="Close transfer preview">
            <X size={16} />
          </button>
        </header>
        <div class="transfer-content">
          <Show when={preview().path}>
            <div class="transfer-path">
              <File size={14} />
              <span title={preview().path}>{preview().path}</span>
            </div>
          </Show>
          <div class="transfer-summary">
            <Show
              when={preview().format === 'sql'}
              fallback={
                <>
                  <span>
                    <b>{preview().tables.length.toLocaleString()}</b> tables
                  </span>
                  <span>
                    <b>
                      {preview()
                        .tables.reduce((total, table) => total + table.rows, 0)
                        .toLocaleString()}
                    </b>{' '}
                    rows
                  </span>
                </>
              }
            >
              <span>
                <b>{(preview().statements ?? 0).toLocaleString()}</b> statements
              </span>
            </Show>
            <Show when={preview().format}>
              <span>
                <b>{preview().format.toUpperCase()}</b> format
              </span>
            </Show>
          </div>
          <Show when={preview().skipped?.length}>
            <section class="transfer-skipped" role="alert">
              <header>
                <Alert size={14} />
                <b>
                  {preview().skipped!.length} {preview().skipped!.length === 1 ? 'object is' : 'objects are'} not
                  included in this backup
                </b>
              </header>
              <For each={preview().skipped}>
                {(item) => (
                  <div>
                    <code>
                      {item.schema}.{item.name}
                    </code>
                    <small>{item.reason}</small>
                  </div>
                )}
              </For>
            </section>
          </Show>
          <Show when={preview().kind === 'backup'}>
            <div class="transfer-note">
              <Alert size={14} />
              <span>
                Data streams into a <code>.pqnb</code> pending file with checkpoints. It becomes <code>.qnb</code> only
                after a complete, durable write.
              </span>
            </div>
          </Show>
          <Show when={preview().kind === 'restore'}>
            <div class="transfer-note danger">
              <Alert size={14} />
              <span>
                {preview().format === 'sql'
                  ? `This SQL dump will execute ${(preview().statements ?? 0).toLocaleString()} statements against the current database.`
                  : 'Rows and schema objects in the archived tables will be replaced.'}{' '}
                The restore runs in one transaction and cannot be undone after it commits.
              </span>
            </div>
          </Show>
          <Show when={preview().kind === 'restore' && preview().format !== 'sql'}>
            <section class="transfer-options">
              <b>Database code</b>
              <div>
                <button
                  class={!props.state.restoreCode ? 'active' : ''}
                  onClick={() => props.onChange({ ...props.state, restoreCode: false })}
                >
                  Skip routines &amp; triggers
                </button>
                <button
                  class={props.state.restoreCode ? 'active' : ''}
                  onClick={() => props.onChange({ ...props.state, restoreCode: true })}
                >
                  Restore database code
                </button>
              </div>
              <small>Only enable database code for backups you trust.</small>
            </section>
          </Show>
          <Show when={preview().kind === 'export'}>
            <section class="transfer-options">
              <b>Export format</b>
              <div>
                <button
                  class={props.state.format === 'csv' ? 'active' : ''}
                  disabled={preview().tables.length > 1}
                  onClick={() => props.onChange({ ...props.state, format: 'csv' })}
                >
                  CSV (safe)
                </button>
                <button
                  class={props.state.format === 'csv-raw' ? 'active' : ''}
                  disabled={preview().tables.length > 1}
                  onClick={() => props.onChange({ ...props.state, format: 'csv-raw' })}
                >
                  CSV raw
                </button>
                <button
                  class={props.state.format === 'json' ? 'active' : ''}
                  onClick={() => props.onChange({ ...props.state, format: 'json' })}
                >
                  JSON
                </button>
              </div>
              <small>
                {props.state.format === 'csv-raw'
                  ? 'Raw CSV preserves exact values and may execute formulas when opened in spreadsheet software.'
                  : preview().tables.length > 1
                    ? 'Multiple tables are exported as one JSON bundle.'
                    : 'Safe CSV neutralizes spreadsheet formula prefixes.'}
              </small>
            </section>
          </Show>
          <Show when={preview().kind === 'import'}>
            <section class="transfer-options">
              <b>When a key conflicts</b>
              <div>
                <button
                  class={props.state.conflict === 'abort' ? 'active' : ''}
                  onClick={() => props.onChange({ ...props.state, conflict: 'abort' })}
                >
                  Abort import
                </button>
                <button
                  class={props.state.conflict === 'skip' ? 'active' : ''}
                  onClick={() => props.onChange({ ...props.state, conflict: 'skip' })}
                >
                  Skip row
                </button>
              </div>
            </section>
          </Show>
          <Show when={preview().format !== 'sql'}>
            <section class="transfer-tables">
              <header>
                <b>Column preview</b>
                <span>
                  {preview().tables.length > 100
                    ? `First 100 of ${preview().tables.length.toLocaleString()}`
                    : `${preview().tables.length} table${preview().tables.length === 1 ? '' : 's'}`}
                </span>
              </header>
              <For each={preview().tables.slice(0, 100)}>
                {(table) => (
                  <div class="transfer-table">
                    <div>
                      <Table size={14} />
                      <b>
                        {table.schema}.{table.name}
                      </b>
                      <span>{table.rows.toLocaleString()} rows</span>
                    </div>
                    <div class="transfer-columns">
                      <For each={table.columns}>
                        {(column) => <code class={table.extraColumns?.includes(column) ? 'extra' : ''}>{column}</code>}
                      </For>
                    </div>
                    <Show when={table.missingColumns?.length}>
                      <small class={table.requiredMissing?.length ? 'invalid' : ''}>
                        Missing target columns: {table.missingColumns.join(', ')}
                      </small>
                    </Show>
                  </div>
                )}
              </For>
            </section>
          </Show>
          <Show when={first()?.sampleRows?.length}>
            <div class="transfer-sample">
              <table>
                <thead>
                  <tr>
                    <For each={first().columns}>{(column) => <th>{column}</th>}</For>
                  </tr>
                </thead>
                <tbody>
                  <For each={first().sampleRows}>
                    {(row) => (
                      <tr>
                        <Index each={first().columns}>
                          {(_column, columnIndex) => <td>{String((row as unknown[])[columnIndex] ?? 'NULL')}</td>}
                        </Index>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
          <Show when={incompatible()}>
            <div class="transfer-validation" role="alert">
              <Alert size={14} />
              <span>
                Fix the source columns before importing. Extra columns and missing required columns cannot be imported
                safely.
              </span>
            </div>
          </Show>
        </div>
        <footer>
          <button class="secondary" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </button>
          <button
            class={`primary ${preview().kind === 'restore' ? 'danger-primary' : ''}`}
            disabled={props.busy || incompatible() || noWork()}
            onClick={props.onRun}
          >
            <Show when={props.busy}>
              <Refresh size={14} class="spin" />
            </Show>
            {props.busy ? 'Working…' : action()}
          </button>
        </footer>
      </section>
    </div>
  )
}
