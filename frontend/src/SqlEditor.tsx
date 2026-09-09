import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { scanSql, statementsInRange, summarizeStatement, type SqlStatement, type SqlToken } from './sql'
import { Play } from './icons'

type SqlEditorProps = {
  value: string
  running: boolean
  onInput: (value: string) => void
  onRun: (statements: string[]) => void
  onSave?: () => void
}

// The highlight layer mirrors the textarea character for character, so the two
// are built from the same offsets and share every metric in the stylesheet.
function highlightNodes(text: string, tokens: SqlToken[], scope: SqlStatement | undefined): JSX.Element[] {
  const pieces: { text: string; cls: string; start: number }[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) pieces.push({ text: text.slice(cursor, token.start), cls: '', start: cursor })
    pieces.push({ text: text.slice(token.start, token.end), cls: `sql-${token.type}`, start: token.start })
    cursor = token.end
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), cls: '', start: cursor })

  const paint = (list: typeof pieces) => list.map(piece => piece.cls ? <span class={piece.cls}>{piece.text}</span> : piece.text)
  if (!scope) return [...paint(pieces), '\n']
  // Statement boundaries always fall on token boundaries, so no piece straddles them.
  return [
    ...paint(pieces.filter(piece => piece.start < scope.start)),
    <span class="sql-scope">{paint(pieces.filter(piece => piece.start >= scope.start && piece.start < scope.end))}</span>,
    ...paint(pieces.filter(piece => piece.start >= scope.end)),
    '\n',
  ]
}

export default function SqlEditor(props: SqlEditorProps) {
  let input!: HTMLTextAreaElement
  let highlight!: HTMLPreElement
  let gutter!: HTMLDivElement
  const [selection, setSelection] = createSignal({ start: 0, end: 0 })

  const scan = createMemo(() => scanSql(props.value))
  const runList = createMemo(() => statementsInRange(scan().statements, selection().start, selection().end))
  // One statement reads as "this is what runs"; several are already marked by
  // the text selection, and a second tint on top of it only muddies both.
  const scope = () => runList().length === 1 ? runList()[0] : undefined
  const lines = createMemo(() => props.value.split('\n').length)

  const syncSelection = () => setSelection({ start: input.selectionStart, end: input.selectionEnd })

  const syncScroll = () => {
    highlight.scrollTop = input.scrollTop
    highlight.scrollLeft = input.scrollLeft
    gutter.scrollTop = input.scrollTop
  }

  onMount(() => {
    // selectionchange is the only event that covers every way a caret moves:
    // typing, arrows, dragging, and the system's own text services.
    const onSelectionChange = () => { if (document.activeElement === input) syncSelection() }
    document.addEventListener('selectionchange', onSelectionChange)
    onCleanup(() => document.removeEventListener('selectionchange', onSelectionChange))
    syncSelection()
  })

  // Replacing the document from outside, such as opening another script, leaves
  // the old scroll offset behind on the layer that does not scroll itself.
  createEffect(on(() => props.value, () => queueMicrotask(syncScroll), { defer: true }))

  const runLabel = () => {
    if (props.running) return 'Running…'
    const count = runList().length
    if (!count) return 'Run'
    return count === 1 ? 'Run statement' : `Run ${count} statements`
  }

  return <div class="editor-wrap">
    <div class="line-numbers" ref={gutter} aria-hidden="true">
      <For each={Array.from({ length: lines() }, (_, line) => line + 1)}>{line => <span>{line}</span>}</For>
    </div>
    <div class="sql-surface">
      <pre class="sql-highlight" ref={highlight} aria-hidden="true">{highlightNodes(props.value, scan().tokens, scope())}</pre>
      <textarea
        ref={input}
        class="sql-input"
        value={props.value}
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        wrap="off"
        aria-label="SQL editor"
        onInput={event => { props.onInput(event.currentTarget.value); syncSelection() }}
        onScroll={syncScroll}
        onSelect={syncSelection}
        onClick={syncSelection}
        onKeyUp={syncSelection}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); props.onRun(runList().map(statement => statement.body)) }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && props.onSave) { event.preventDefault(); props.onSave() }
        }}
      />
    </div>
    <Show when={runList().length > 1}>
      <aside class="sql-run-list" role="status" aria-label="Statements this run will execute">
        <header>{runList().length} statements will run</header>
        <ol><For each={runList()}>{statement => <li>{summarizeStatement(statement.body)}</li>}</For></ol>
      </aside>
    </Show>
    <button class="run-query" disabled={props.running || !runList().length} onClick={() => props.onRun(runList().map(statement => statement.body))}>
      <Play size={14}/>{runLabel()}
    </button>
  </div>
}
