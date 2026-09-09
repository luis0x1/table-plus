import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { completionContext, scanSql, sqlCompletions, statementsInRange, summarizeStatement, tableAliases, type Completion, type CompletionTable, type SqlStatement, type SqlToken } from './sql'
import { Play } from './icons'

type SqlEditorProps = {
  value: string
  running: boolean
  tables: CompletionTable[]
  onInput: (value: string) => void
  onRun: (statements: string[]) => void
  onSave?: () => void
  /** Asks the workspace to load a table's columns the first time one is needed. */
  onNeedColumns?: (table: string) => void
}

// The highlight layer already mirrors the textarea exactly, so a range inside it
// gives the caret's on-screen position without a second measuring element.
function caretRect(layer: HTMLElement, offset: number): DOMRect | null {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  let seen = 0
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    if (seen + length >= offset) {
      const range = document.createRange()
      range.setStart(node, offset - seen)
      range.collapse(true)
      return range.getBoundingClientRect()
    }
    seen += length
    node = walker.nextNode()
  }
  return null
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
  let surface!: HTMLDivElement
  const [selection, setSelection] = createSignal({ start: 0, end: 0 })
  const [completing, setCompleting] = createSignal(false)
  const [highlighted, setHighlighted] = createSignal(0)

  const scan = createMemo(() => scanSql(props.value))
  const runList = createMemo(() => statementsInRange(scan().statements, selection().start, selection().end))
  // One statement reads as "this is what runs"; several are already marked by
  // the text selection, and a second tint on top of it only muddies both.
  const scope = () => runList().length === 1 ? runList()[0] : undefined
  const lines = createMemo(() => props.value.split('\n').length)

  const syncSelection = () => setSelection(previous =>
    previous.start === input.selectionStart && previous.end === input.selectionEnd
      ? previous
      : { start: input.selectionStart, end: input.selectionEnd })

  const context = createMemo(() => completing() ? completionContext(props.value, selection().start) : null)
  const suggestions = createMemo<Completion[]>(() => {
    const active = context()
    return active ? sqlCompletions(active, props.tables) : []
  })

  // Columns are fetched only for the tables the statement being written refers
  // to: the one before a dot, and everything its FROM and JOIN clauses name.
  createEffect(() => {
    const active = context()
    if (!active) return
    const wanted = new Set<string>()
    if (active.qualifier) wanted.add(active.qualifier)
    if (active.statement) for (const table of Object.values(tableAliases(active.statement.body))) wanted.add(table)
    for (const name of wanted) {
      const known = props.tables.find(table => table.name.toLowerCase() === name.toLowerCase())
      if (known && !known.columns.length) props.onNeedColumns?.(known.name)
    }
  })

  const completionTarget = () => {
    const active = context()
    return active ? `${active.start}:${active.qualifier}:${active.prefix}` : ''
  }
  createEffect(on(completionTarget, () => setHighlighted(0)))

  const caretPosition = createMemo(() => {
    if (!completing() || !suggestions().length) return null
    const active = context()
    if (!active) return null
    const rect = caretRect(highlight, active.start)
    if (!rect || !surface) return null
    const bounds = surface.getBoundingClientRect()
    return { left: rect.left - bounds.left, top: rect.bottom - bounds.top }
  })

  function accept(item: Completion) {
    const active = context()
    if (!active) return
    const caret = active.start + item.label.length
    props.onInput(props.value.slice(0, active.start) + item.label + props.value.slice(active.end))
    setCompleting(false)
    queueMicrotask(() => { input.focus(); input.setSelectionRange(caret, caret); syncSelection() })
  }

  // Offer suggestions once there is something to match on, or on request.
  function considerCompleting() {
    const active = completionContext(props.value, input.selectionStart)
    setCompleting(Boolean(active && (active.prefix.length >= 1 || active.qualifier)))
  }

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
    <div class="sql-surface" ref={surface}>
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
        onInput={event => { props.onInput(event.currentTarget.value); syncSelection(); considerCompleting() }}
        onScroll={syncScroll}
        onSelect={syncSelection}
        onClick={syncSelection}
        onKeyUp={syncSelection}
        onBlur={() => setCompleting(false)}
        onKeyDown={event => {
          const open = completing() && suggestions().length > 0
          if (open) {
            if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted(index => (index + 1) % suggestions().length); return }
            if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted(index => (index - 1 + suggestions().length) % suggestions().length); return }
            if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); accept(suggestions()[highlighted()]); return }
            if (event.key === 'Escape') { event.preventDefault(); setCompleting(false); return }
          }
          if ((event.ctrlKey || event.metaKey) && event.key === ' ') { event.preventDefault(); setCompleting(true); return }
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); props.onRun(runList().map(statement => statement.body)) }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && props.onSave) { event.preventDefault(); props.onSave() }
        }}
      />
      <Show when={caretPosition()}>{position =>
        <ul class="sql-completions" role="listbox" aria-label="SQL suggestions" style={{ left: `${position().left}px`, top: `${position().top}px` }}>
          <For each={suggestions()}>{(item, index) =>
            <li role="option" aria-selected={index() === highlighted()} class={index() === highlighted() ? 'active' : ''}
              onMouseDown={event => { event.preventDefault(); accept(item) }} onMouseEnter={() => setHighlighted(index())}>
              <span class={`sql-completion-kind ${item.kind}`}>{item.kind[0].toUpperCase()}</span>
              <b>{item.label}</b><small>{item.detail}</small>
            </li>
          }</For>
        </ul>
      }</Show>
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
