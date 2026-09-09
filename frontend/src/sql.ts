// A small SQL scanner. It exists to answer two questions the editor asks on
// every keystroke: how should this text be coloured, and which statement is the
// cursor in. Both come from one pass, so the highlighting and the statement the
// run button executes can never disagree.

export type SqlTokenType = 'keyword' | 'string' | 'comment' | 'number' | 'quoted' | 'operator' | 'plain'

export type SqlToken = { type: SqlTokenType; start: number; end: number }

export type SqlStatement = { start: number; end: number; body: string }

const KEYWORDS = new Set([
  'abort', 'add', 'all', 'alter', 'analyze', 'and', 'as', 'asc', 'attach', 'begin', 'between', 'by',
  'cascade', 'case', 'cast', 'check', 'collate', 'column', 'commit', 'conflict', 'constraint', 'create',
  'cross', 'current_date', 'current_time', 'current_timestamp', 'database', 'default', 'deferrable',
  'delete', 'desc', 'distinct', 'do', 'drop', 'else', 'end', 'escape', 'except', 'exists', 'explain',
  'filter', 'first', 'following', 'for', 'foreign', 'from', 'full', 'generated', 'group', 'having',
  'if', 'ignore', 'immediate', 'in', 'index', 'inner', 'insert', 'instead', 'intersect', 'into', 'is',
  'isnull', 'join', 'key', 'last', 'left', 'like', 'limit', 'materialized', 'natural', 'no', 'not',
  'nothing', 'notnull', 'null', 'nulls', 'of', 'offset', 'on', 'or', 'order', 'outer', 'over',
  'partition', 'pragma', 'primary', 'procedure', 'range', 'recursive', 'references', 'reindex',
  'release', 'rename', 'replace', 'restrict', 'returning', 'right', 'rollback', 'row', 'rows',
  'savepoint', 'select', 'set', 'table', 'temp', 'temporary', 'then', 'to', 'transaction', 'trigger',
  'union', 'unique', 'update', 'using', 'vacuum', 'values', 'view', 'virtual', 'when', 'where',
  'window', 'with', 'without',
])

const identifierStart = /[A-Za-z_]/
const identifierPart = /[A-Za-z0-9_$]/
const digit = /[0-9]/
const whitespace = /\s/

// A CREATE TRIGGER body is the one place a semicolon does not end a statement.
const triggerHeader = /\bcreate\b[\s\S]*\btrigger\b/i

const closingQuote: Record<string, string> = { '"': '"', '`': '`', '[': ']' }

function readDollarTag(text: string, index: number) {
  if (text[index] !== '$') return null
  let end = index + 1
  while (end < text.length && identifierPart.test(text[end]) && text[end] !== '$') end++
  if (text[end] !== '$') return null
  return text.slice(index, end + 1)
}

/**
 * scanSql tokenizes `text` and splits it into statements in a single pass.
 * A statement claims any comment that precedes it, because that is how a reader
 * sees it, but a trailing comment with no SQL after it is not a statement.
 */
export function scanSql(text: string): { tokens: SqlToken[]; statements: SqlStatement[] } {
  const tokens: SqlToken[] = []
  const statements: SqlStatement[] = []
  let index = 0
  let statementStart = -1
  let hasCode = false
  let beginDepth = 0

  const push = (type: SqlTokenType, start: number, end: number) => {
    if (statementStart < 0) statementStart = start
    if (type !== 'comment') hasCode = true
    tokens.push({ type, start, end })
  }

  const closeStatement = (end: number) => {
    if (statementStart >= 0 && hasCode) statements.push({ start: statementStart, end, body: text.slice(statementStart, end) })
    statementStart = -1
    hasCode = false
    beginDepth = 0
  }

  while (index < text.length) {
    const char = text[index]

    if (whitespace.test(char)) { index++; continue }

    if (char === '-' && text[index + 1] === '-') {
      const newline = text.indexOf('\n', index)
      const end = newline === -1 ? text.length : newline
      push('comment', index, end)
      index = end
      continue
    }

    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2)
      const end = close === -1 ? text.length : close + 2
      push('comment', index, end)
      index = end
      continue
    }

    const tag = readDollarTag(text, index)
    if (tag) {
      const close = text.indexOf(tag, index + tag.length)
      const end = close === -1 ? text.length : close + tag.length
      push('string', index, end)
      index = end
      continue
    }

    if (char === "'") {
      let end = index + 1
      while (end < text.length) {
        if (text[end] === "'") {
          if (text[end + 1] === "'") { end += 2; continue }
          end++
          break
        }
        end++
      }
      push('string', index, end)
      index = end
      continue
    }

    const closer = closingQuote[char]
    if (closer) {
      let end = index + 1
      while (end < text.length) {
        if (text[end] === closer) {
          if (closer !== ']' && text[end + 1] === closer) { end += 2; continue }
          end++
          break
        }
        end++
      }
      push('quoted', index, end)
      index = end
      continue
    }

    if (digit.test(char) || (char === '.' && digit.test(text[index + 1] ?? ''))) {
      let end = index
      while (end < text.length && /[0-9.]/.test(text[end])) end++
      if (/[eE]/.test(text[end] ?? '')) {
        end++
        if (/[+-]/.test(text[end] ?? '')) end++
        while (end < text.length && digit.test(text[end])) end++
      }
      push('number', index, end)
      index = end
      continue
    }

    if (identifierStart.test(char)) {
      let end = index
      while (end < text.length && identifierPart.test(text[end])) end++
      const word = text.slice(index, end).toLowerCase()
      const keyword = KEYWORDS.has(word)
      if (keyword && word === 'begin' && statementStart >= 0 && triggerHeader.test(text.slice(statementStart, index))) beginDepth++
      else if (keyword && word === 'end' && beginDepth > 0) beginDepth--
      push(keyword ? 'keyword' : 'plain', index, end)
      index = end
      continue
    }

    if (char === ';') {
      push('operator', index, index + 1)
      index++
      if (beginDepth === 0) closeStatement(index)
      continue
    }

    push('operator', index, index + 1)
    index++
  }

  closeStatement(text.length)
  return { tokens, statements }
}

/**
 * statementsInRange reports what a run would execute. A selection runs every
 * statement it touches; a plain cursor runs the statement it sits in, or the
 * nearest one when it sits between them.
 */
export function statementsInRange(statements: SqlStatement[], selectionStart: number, selectionEnd: number): SqlStatement[] {
  if (!statements.length) return []
  if (selectionEnd > selectionStart) {
    const touched = statements.filter(statement => statement.start < selectionEnd && statement.end > selectionStart)
    if (touched.length) return touched
  }
  const caret = selectionStart
  const containing = statements.find(statement => caret >= statement.start && caret < statement.end)
  if (containing) return [containing]
  let nearest = statements[0]
  let best = Infinity
  for (const statement of statements) {
    const distance = caret < statement.start ? statement.start - caret : caret - statement.end
    if (distance < best) { best = distance; nearest = statement }
  }
  return [nearest]
}

/** summarizeStatement renders the short label the run list shows. */
export function summarizeStatement(body: string, limit = 46): string {
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
  const collapsed = withoutComments.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()
  if (!collapsed) return '(comment only)'
  return collapsed.length > limit ? collapsed.slice(0, limit - 1).trimEnd() + '…' : collapsed
}
