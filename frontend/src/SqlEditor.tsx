import { autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap, completionStatus, startCompletion, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { PostgreSQL, SQLite, keywordCompletionSource, sql } from '@codemirror/lang-sql'
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorSelection as CodeMirrorSelection, EditorState } from '@codemirror/state'
import { Decoration, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection, ViewPlugin, type DecorationSet } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { completionContext, scanSql, sqlCompletions, statementsInRange, summarizeStatement, tableAliases, type CompletionTable, type SqlStatement } from './sql'

export type EditorSelection = { start: number; end: number; direction?: 'forward' | 'backward' | 'none' }

type SqlEditorProps = {
  value: string
  driver: string
  running: boolean
  tables: CompletionTable[]
  caret?: EditorSelection & { nonce: number }
  focusNonce: number
  onInput: (value: string, selection: EditorSelection) => void
  onSelectionChange?: (selection: EditorSelection) => void
  onUndo?: (selection: EditorSelection) => void
  onRedo?: (selection: EditorSelection) => void
  onRun: (statements: string[]) => void
  onSave?: () => void
  /** Reports what a run would cover, so the panel header can drive the button. */
  onRunListChange?: (statements: SqlStatement[]) => void
  /** Asks the workspace to load a table's columns the first time one is needed. */
  onNeedColumns?: (table: string) => void
}

const queryNestHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#b28cff', fontWeight: '600' },
  { tag: [tags.string, tags.regexp], color: '#6fca9f' },
  { tag: [tags.number, tags.bool, tags.null], color: '#e0a55f' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], color: '#4f5b68', fontStyle: 'italic' },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: '#c3cad3' },
  { tag: [tags.typeName, tags.className], color: '#6ec5d8' },
  { tag: [tags.operator, tags.punctuation], color: '#77828f' },
])

const queryNestTheme = EditorView.theme({}, { dark: true })
const scopeMark = Decoration.mark({ class: 'cm-sql-scope' })

function runListFor(state: EditorState) {
  const selection = state.selection.main
  return statementsInRange(scanSql(state.doc.toString()).statements, selection.from, selection.to)
}

function scopeDecorations(state: EditorState): DecorationSet {
  const statements = runListFor(state)
  if (statements.length !== 1 || statements[0].start === statements[0].end) return Decoration.none
  return Decoration.set([scopeMark.range(statements[0].start, statements[0].end)])
}

const statementScope = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = scopeDecorations(view.state)
  }

  update(update: { state: EditorState; docChanged: boolean; selectionSet: boolean }) {
    if (update.docChanged || update.selectionSet) this.decorations = scopeDecorations(update.state)
  }
}, { decorations: plugin => plugin.decorations })

function selectionFromState(state: EditorState): EditorSelection {
  const range = state.selection.main
  return {
    start: range.from,
    end: range.to,
    direction: range.empty ? 'none' : range.anchor > range.head ? 'backward' : 'forward',
  }
}

function codeMirrorSelection(selection: EditorSelection | undefined, length: number) {
  const start = Math.min(selection?.start ?? 0, length)
  const end = Math.min(selection?.end ?? start, length)
  if (start === end) return CodeMirrorSelection.cursor(start)
  return selection?.direction === 'backward'
    ? CodeMirrorSelection.range(end, start)
    : CodeMirrorSelection.range(start, end)
}

function contextualCompletionSource(props: SqlEditorProps): CompletionSource {
  return context => {
    const text = context.state.doc.toString()
    const active = completionContext(text, context.pos)
    if (!active || (!context.explicit && !active.prefix && !active.qualifier)) return null

    // Fetch only columns relevant to the current statement. The workspace
    // caches even an empty result, so failed introspection is not retried.
    const wanted = new Set<string>()
    if (active.qualifier) wanted.add(active.qualifier)
    if (active.statement) for (const table of Object.values(tableAliases(active.statement.body))) wanted.add(table)
    for (const name of wanted) {
      const known = props.tables.find(table => table.name.toLowerCase() === name.toLowerCase())
      if (known && !known.columns.length) props.onNeedColumns?.(known.name)
    }

    const options = sqlCompletions(active, props.tables)
      .filter(item => item.kind !== 'keyword')
      .map(item => ({
        label: item.label,
        detail: item.detail,
        type: item.kind === 'column' ? 'property' : 'class',
        boost: item.kind === 'column' ? 90 : 50,
      }))
    return options.length ? { from: active.start, to: active.end, options, filter: false } : null
  }
}

function contextualKeywordSource(props: SqlEditorProps): CompletionSource {
  const dialect = props.driver === 'PostgreSQL' ? PostgreSQL : SQLite
  const keywords = keywordCompletionSource(dialect, true)
  return context => {
    const active = completionContext(context.state.doc.toString(), context.pos)
    if (!active || active.qualifier || active.wants === 'table' || (!context.explicit && !active.prefix)) return null
    const setRange = (result: CompletionResult | null) => result ? { ...result, from: active.start, to: active.end } : null
    const result = keywords(context)
    return result instanceof Promise ? result.then(setRange) : setRange(result)
  }
}

export default function SqlEditor(props: SqlEditorProps) {
  let host!: HTMLDivElement
  let view: EditorView | undefined
  let applyingExternal = false
  let restoreAfterWindowFocus = false
  const [runList, setRunList] = createSignal<SqlStatement[]>([])

  const reportRunList = (state: EditorState) => {
    const statements = runListFor(state)
    setRunList(statements)
    props.onRunListChange?.(statements)
  }

  const restoreFocus = (selection: EditorSelection | undefined = props.caret) => {
    if (!view) return
    view.dispatch({ selection: codeMirrorSelection(selection, view.state.doc.length), scrollIntoView: true })
    view.focus()
  }

  onMount(() => {
    const dialect = props.driver === 'PostgreSQL' ? PostgreSQL : SQLite
    const relationCompletion = contextualCompletionSource(props)
    const keywordCompletion = contextualKeywordSource(props)
    const run = () => {
      if (!view || props.running) return true
      props.onRun(runListFor(view.state).map(statement => statement.body))
      return true
    }
    const save = () => {
      if (!props.onSave) return false
      props.onSave()
      return true
    }
    const undo = () => {
      if (!view || !props.onUndo) return false
      props.onUndo(selectionFromState(view.state))
      return true
    }
    const redo = () => {
      if (!view || !props.onRedo) return false
      props.onRedo(selectionFromState(view.state))
      return true
    }

    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        selection: codeMirrorSelection(props.caret, props.value.length),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          sql({ dialect }),
          syntaxHighlighting(queryNestHighlight),
          queryNestTheme,
          statementScope,
          autocompletion({ override: [relationCompletion, keywordCompletion], activateOnTyping: true, closeOnBlur: true }),
          keymap.of([
            { key: 'Mod-Enter', run },
            { key: 'Mod-s', run: save },
            { key: 'Mod-z', run: undo },
            { key: 'Mod-Shift-z', run: redo },
            { key: 'Mod-y', run: redo },
            ...completionKeymap,
            ...closeBracketsKeymap,
            indentWithTab,
            ...searchKeymap,
            ...foldKeymap,
            ...defaultKeymap,
          ]),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL editor', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' }),
          EditorView.updateListener.of(update => {
            // Depending on the WebView, the editor may lose focus just before
            // the window blur event. Remember that path from either event so
            // returning with Alt+Tab restores the real CodeMirror selection.
            if (update.focusChanged && !update.view.hasFocus && !document.hasFocus()) restoreAfterWindowFocus = true
            if (applyingExternal) return
            const selection = selectionFromState(update.state)
            if (update.docChanged) props.onInput(update.state.doc.toString(), selection)
            if (update.docChanged || update.selectionSet) {
              props.onSelectionChange?.(selection)
              reportRunList(update.state)
            }
          }),
        ],
      }),
    })
    reportRunList(view.state)

    const onWindowBlur = () => { if (view?.hasFocus) restoreAfterWindowFocus = true }
    const onWindowFocus = () => {
      if (!restoreAfterWindowFocus) return
      restoreAfterWindowFocus = false
      queueMicrotask(() => { if (view) restoreFocus(selectionFromState(view.state)) })
    }
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    queueMicrotask(() => restoreFocus())

    onCleanup(() => {
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      view?.destroy()
      view = undefined
    })
  })

  createEffect(on(() => props.value, value => {
    if (!view || value === view.state.doc.toString()) return
    const current = selectionFromState(view.state)
    applyingExternal = true
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: codeMirrorSelection(current, value.length),
      })
      reportRunList(view.state)
    } finally { applyingExternal = false }
  }, { defer: true }))

  createEffect(on(() => props.caret?.nonce, () => queueMicrotask(() => restoreFocus()), { defer: true }))
  createEffect(on(() => props.focusNonce, () => queueMicrotask(() => restoreFocus()), { defer: true }))

  // Refresh an open completion popup when lazy column metadata arrives.
  createEffect(on(() => props.tables.map(table => `${table.schema}.${table.name}:${table.columns.join(',')}`).join('|'), () => {
    if (!view || completionStatus(view.state) !== 'active') return
    closeCompletion(view)
    queueMicrotask(() => { if (view) startCompletion(view) })
  }, { defer: true }))

  return <div class="editor-wrap">
    <div class="sql-editor-host" ref={host}/>
    <Show when={runList().length > 1}>
      <aside class="sql-run-list" role="status" aria-label="Statements this run will execute">
        <header>{runList().length} statements will run</header>
        <ol><For each={runList()}>{statement => <li>{summarizeStatement(statement.body)}</li>}</For></ol>
      </aside>
    </Show>
  </div>
}
