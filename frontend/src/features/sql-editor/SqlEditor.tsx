import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { PostgreSQL, SQLite, sql } from '@codemirror/lang-sql'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorSelection as CodeMirrorSelection, EditorState } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type DecorationSet,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { scanSql, statementsInRange, summarizeStatement, type SqlStatement } from './sql'
import type { CompletionTable } from './completion'
import { createSqlCompletionSource } from './completionSource'
import type { TableRef } from '../../types'

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
  onNeedColumns?: (table: TableRef) => Promise<void>
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

const statementScope = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = scopeDecorations(view.state)
    }

    update(update: { state: EditorState; docChanged: boolean; selectionSet: boolean }) {
      if (update.docChanged || update.selectionSet) this.decorations = scopeDecorations(update.state)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

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
    const completion = createSqlCompletionSource({
      driver: () => props.driver,
      tables: () => props.tables,
      loadColumns: (table) => props.onNeedColumns?.(table) ?? Promise.resolve(),
    })
    const run = () => {
      if (!view || props.running) return true
      props.onRun(runListFor(view.state).map((statement) => statement.body))
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
          autocompletion({
            override: [completion],
            activateOnTyping: true,
            closeOnBlur: true,
            activateOnCompletion: (item) => item.type === 'namespace' || item.type === 'variable',
          }),
          keymap.of([
            { key: 'Mod-Enter', run },
            { key: 'Mod-s', run: save },
            { key: 'Mod-z', run: undo },
            { key: 'Mod-Shift-z', run: redo },
            { key: 'Mod-y', run: redo },
            { key: 'Tab', run: acceptCompletion },
            ...completionKeymap,
            ...closeBracketsKeymap,
            indentWithTab,
            ...searchKeymap,
            ...foldKeymap,
            ...defaultKeymap,
          ]),
          EditorView.contentAttributes.of({
            'aria-label': 'SQL editor',
            spellcheck: 'false',
            autocapitalize: 'off',
            autocomplete: 'off',
          }),
          EditorView.updateListener.of((update) => {
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

    const onWindowBlur = () => {
      if (view?.hasFocus) restoreAfterWindowFocus = true
    }
    const onWindowFocus = () => {
      if (!restoreAfterWindowFocus) return
      restoreAfterWindowFocus = false
      queueMicrotask(() => {
        if (view) restoreFocus(selectionFromState(view.state))
      })
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

  createEffect(
    on(
      () => props.value,
      (value) => {
        if (!view || value === view.state.doc.toString()) return
        const current = selectionFromState(view.state)
        applyingExternal = true
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
            selection: codeMirrorSelection(current, value.length),
          })
          reportRunList(view.state)
        } finally {
          applyingExternal = false
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.caret?.nonce,
      () => queueMicrotask(() => restoreFocus()),
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => props.focusNonce,
      () => queueMicrotask(() => restoreFocus()),
      { defer: true },
    ),
  )

  return (
    <div class="editor-wrap">
      <div class="sql-editor-host" ref={host} />
      <Show when={runList().length > 1}>
        <aside class="sql-run-list" role="status" aria-label="Statements this run will execute">
          <header>{runList().length} statements will run</header>
          <ol>
            <For each={runList()}>{(statement) => <li>{summarizeStatement(statement.body)}</li>}</For>
          </ol>
        </aside>
      </Show>
    </div>
  )
}
