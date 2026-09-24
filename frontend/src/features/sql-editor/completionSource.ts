import { pickedCompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import { completeSql, type CompletionTable, type SqlCompletion } from './completion'
import type { TableRef } from '../../types'

export function completionInsertion(item: SqlCompletion, following: string) {
  // Reuse punctuation already after a word when completing in its middle.
  const insert =
    item.insertText.endsWith('.') && following.startsWith('.') ? item.insertText.slice(0, -1) : item.insertText
  return { insert, cursor: item.cursorOffset ?? insert.length }
}

export function createSqlCompletionSource(config: {
  driver: () => string
  tables: () => CompletionTable[]
  loadColumns?: (table: TableRef) => Promise<void>
}): CompletionSource {
  return async (context) => {
    // Scope and replacement ranges belong to this exact document snapshot.
    // Do not reuse an in-flight response after the user changes the SQL.
    context.addEventListener('abort', () => {}, { onDocChange: true })
    const text = context.state.doc.toString()
    let result = completeSql(text, context.pos, config.tables(), config.driver())
    if (!result || (!context.explicit && !result.automatic)) return null
    if (result.neededTables.length && config.loadColumns) {
      await Promise.all(result.neededTables.map((table) => config.loadColumns!(table)))
      if (context.aborted) return null
      result = completeSql(text, context.pos, config.tables(), config.driver())
    }
    if (!result?.options.length || context.aborted) return null
    const types = {
      column: 'property',
      table: 'class',
      alias: 'variable',
      schema: 'namespace',
      function: 'function',
      keyword: 'keyword',
    }
    const options: Completion[] = result.options.map((item) => ({
      label: item.label,
      detail: item.detail,
      info: item.info,
      type: types[item.kind],
      apply(view, completion, from, to) {
        const edit = completionInsertion(item, view.state.doc.sliceString(to))
        view.dispatch({
          changes: { from, to, insert: edit.insert },
          selection: { anchor: from + edit.cursor },
          annotations: pickedCompletion.of(completion),
          userEvent: 'input.complete',
        })
      },
    }))
    return { from: result.from, to: result.to, options, filter: false }
  }
}
