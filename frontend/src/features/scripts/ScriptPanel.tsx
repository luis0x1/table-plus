import { createSignal, lazy, Show, Suspense } from 'solid-js'
import DataGrid from '../data-grid/DataGrid'
import type { EditorSelection } from '../sql-editor/SqlEditor'
import type { CompletionTable, PaginationPlan, SqlStatement } from '../sql-editor/sql'
import type { QueryResult } from '../../types'
import { Check, ChevronRight, Code, Play, Save, X } from '../../components/ui/icons'

const SqlEditor = lazy(() => import('../sql-editor/SqlEditor'))
const SCRIPT_PAGE_SIZE = 100

type EditSnapshot = EditorSelection & { text: string }

export type ScriptBuffer = {
  text: string
  saved: string
  result: QueryResult | null
  running: boolean
  past: EditSnapshot[]
  future: EditSnapshot[]
  /** When the last edit landed, used to group a run of typing into one step. */
  editedAt: number
  /** A bumped nonce tells the editor to restore this caret. */
  caret: EditorSelection & { nonce: number }
  /** What the last run covered, so a page can re-run it. */
  statements: string[]
  /** Null when the query cannot be paged without changing its meaning. */
  plan: PaginationPlan | null
  page: number
}

export const newScriptBuffer = (text: string): ScriptBuffer => ({
  text,
  saved: text,
  result: null,
  running: false,
  past: [],
  future: [],
  editedAt: 0,
  caret: { start: 0, end: 0, direction: 'none', nonce: 0 },
  statements: [],
  plan: null,
  page: 0,
})

/**
 * ScriptPanel is the whole editing surface for one script: its own header with
 * the actions, the editor, and the results of its last run underneath. The run
 * button lives beside save because both act on this script, and it needs to know
 * what a run would cover, which is why the editor reports its run list up.
 */
export default function ScriptPanel(props: {
  name: string
  driver: string
  text: string
  dirty: boolean
  readOnly: boolean
  result: QueryResult | null
  running: boolean
  page: number
  pageable: boolean
  onPage: (page: number) => void
  tables: CompletionTable[]
  onNeedColumns: (table: string) => void
  caret: EditorSelection & { nonce: number }
  focusNonce: number
  onInput: (value: string, selection: EditorSelection) => void
  onSelectionChange: (selection: EditorSelection) => void
  onUndo: (selection: EditorSelection) => void
  onRedo: (selection: EditorSelection) => void
  onRun: (statements: string[]) => void
  onSave: () => void
  onClose: () => void
}) {
  const [runList, setRunList] = createSignal<SqlStatement[]>([])
  const label = () => (props.name ? props.name.replace(/\.sql$/i, '') : 'Query')
  const runLabel = () => (props.running ? 'Running…' : runList().length > 1 ? `Run ${runList().length}` : 'Run')
  const run = () => props.onRun(runList().map((statement) => statement.body))

  return (
    <div class="script-panel">
      <header class="script-panel-head">
        <div class="script-title">
          <Code size={15} />
          <b>{label()}</b>
          <Show when={props.dirty}>
            <i class="script-dirty" title="Unsaved changes" />
          </Show>
          <span
            class={props.readOnly ? 'read-only' : 'writable'}
            title={
              props.readOnly
                ? 'Scratch queries and read-only connections cannot change data'
                : 'Saved scripts can change this database'
            }
          >
            {props.readOnly ? 'Read-only' : 'Write enabled'}
          </span>
        </div>
        <div class="script-panel-actions">
          <Show when={props.name}>
            <button class="secondary" disabled={!props.dirty} onClick={props.onSave}>
              <Save size={14} /> Save<kbd>Ctrl S</kbd>
            </button>
          </Show>
          <button class="primary" disabled={props.running || !runList().length} onClick={run}>
            <Play size={14} /> {runLabel()}
            <kbd>⌘ ↵</kbd>
          </button>
          <button class="icon-button" onClick={props.onClose} aria-label="Close script">
            <X size={15} />
          </button>
        </div>
      </header>
      <div class="script-body">
        <Suspense
          fallback={
            <div class="editor-wrap sql-editor-loading" role="status" aria-label="Loading SQL editor">
              <i />
              <i />
              <i />
            </div>
          }
        >
          <SqlEditor
            value={props.text}
            driver={props.driver}
            running={props.running}
            tables={props.tables}
            caret={props.caret}
            focusNonce={props.focusNonce}
            onNeedColumns={props.onNeedColumns}
            onInput={props.onInput}
            onSelectionChange={props.onSelectionChange}
            onUndo={props.onUndo}
            onRedo={props.onRedo}
            onRun={props.onRun}
            onRunListChange={setRunList}
            onSave={props.name ? props.onSave : undefined}
          />
        </Suspense>
        <Show
          when={props.result}
          fallback={
            <section class="script-results empty">
              <div class="result-placeholder">
                <Play size={20} />
                <span>Run a statement to see its rows</span>
              </div>
            </section>
          }
        >
          {(result) => (
            <section class="script-results">
              <div class="result-meta">
                <Check size={13} />
                {result().message}
                <span>{result().durationMs} ms</span>
              </div>
              <DataGrid data={result()} compact rowOffset={props.pageable ? props.page * SCRIPT_PAGE_SIZE : 0} />
              <footer class="script-pagination">
                <Show
                  when={props.pageable}
                  fallback={
                    <span class="script-page-note">
                      {result().rows.length >= 1000
                        ? 'First 1000 rows. Add a LIMIT, or run one query on its own, to page through the rest.'
                        : `${result().rows.length.toLocaleString()} rows`}
                    </span>
                  }
                >
                  <span>
                    {result().rows.length
                      ? `${(props.page * SCRIPT_PAGE_SIZE + 1).toLocaleString()}–${(props.page * SCRIPT_PAGE_SIZE + result().rows.length).toLocaleString()}`
                      : 'No more rows'}
                  </span>
                  <div class="page-controls">
                    <button
                      aria-label="Previous page"
                      disabled={props.page === 0 || props.running}
                      onClick={() => props.onPage(props.page - 1)}
                    >
                      <ChevronRight size={14} class="flip" />
                    </button>
                    <span>Page {props.page + 1}</span>
                    <button
                      aria-label="Next page"
                      disabled={props.running || result().rows.length < SCRIPT_PAGE_SIZE}
                      onClick={() => props.onPage(props.page + 1)}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </Show>
              </footer>
            </section>
          )}
        </Show>
      </div>
    </div>
  )
}
