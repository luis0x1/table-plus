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

export type CompletionKind = 'keyword' | 'table' | 'column'

export type Completion = { label: string; detail: string; kind: CompletionKind }

export type CompletionTable = { schema: string; name: string; columns: string[] }

export type CompletionContext = {
  /** The word under the caret, which the accepted suggestion replaces whole. */
  prefix: string
  start: number
  end: number
  /** The table or alias before a dot, when the caret follows one. */
  qualifier: string
  wants: CompletionKind | 'any'
  statement?: SqlStatement
}

const identifierChar = /[A-Za-z0-9_]/
// After these, a name is a relation rather than a column.
const relationKeywords = new Set(['from', 'join', 'into', 'update', 'table'])

/**
 * tableAliases maps the aliases a statement introduces back to their tables, so
 * `c.` after `FROM customers c` can offer that table's columns.
 */
export function tableAliases(statement: string): Record<string, string> {
  const { tokens } = scanSql(statement)
  const words = tokens.filter(token => token.type === 'keyword' || token.type === 'plain' || token.type === 'quoted')
  const unquote = (value: string) => /^["`[]/.test(value) ? value.slice(1, -1) : value
  const aliases: Record<string, string> = {}
  for (let index = 0; index < words.length; index++) {
    const word = statement.slice(words[index].start, words[index].end).toLowerCase()
    if (words[index].type !== 'keyword' || (word !== 'from' && word !== 'join' && word !== 'update')) continue
    let position = index + 1
    if (position >= words.length || words[position].type === 'keyword') continue
    let table = unquote(statement.slice(words[position].start, words[position].end))
    // A qualified name spends two more tokens on the dot and the table.
    if (statement[words[position].end] === '.' && words[position + 1]) {
      position += 1
      table = unquote(statement.slice(words[position].start, words[position].end))
    }
    aliases[table.toLowerCase()] = table
    let next = words[position + 1]
    if (next && next.type === 'keyword' && statement.slice(next.start, next.end).toLowerCase() === 'as') next = words[position + 2]
    if (next && next.type !== 'keyword') {
      const alias = unquote(statement.slice(next.start, next.end))
      if (alias && !alias.includes('(')) aliases[alias.toLowerCase()] = table
    }
  }
  return aliases
}

/**
 * completionContext describes what the caret is asking for, or null where
 * suggesting anything would be wrong - inside a string or a comment.
 */
export function completionContext(text: string, caret: number): CompletionContext | null {
  const { tokens, statements } = scanSql(text)
  // The end of a comment line, and the end of a string still being typed, are
  // both inside it, so the upper bound is inclusive.
  const enclosing = tokens.find(token => caret > token.start && caret <= token.end)
  if (enclosing && (enclosing.type === 'string' || enclosing.type === 'comment')) return null

  let start = caret
  while (start > 0 && identifierChar.test(text[start - 1])) start--
  // Accepting replaces the whole word, so a completion taken mid-word does not
  // leave its tail behind.
  let end = caret
  while (end < text.length && identifierChar.test(text[end])) end++
  const prefix = text.slice(start, caret)

  let qualifier = ''
  if (text[start - 1] === '.') {
    let qualifierStart = start - 1
    while (qualifierStart > 0 && identifierChar.test(text[qualifierStart - 1])) qualifierStart--
    qualifier = text.slice(qualifierStart, start - 1)
  }

  // The last keyword before the word decides whether a relation is expected.
  let wants: CompletionContext['wants'] = qualifier ? 'column' : 'any'
  if (!qualifier) {
    const previous = [...tokens].reverse().find(token => token.end <= start && token.type === 'keyword')
    if (previous && relationKeywords.has(text.slice(previous.start, previous.end).toLowerCase())) wants = 'table'
  }

  const statement = statements.find(item => caret >= item.start && caret <= item.end)
  return { prefix, start, end, qualifier, wants, statement }
}

function rank(label: string, prefix: string): number {
  if (!prefix) return 1
  const haystack = label.toLowerCase()
  const needle = prefix.toLowerCase()
  if (haystack.startsWith(needle)) return 0
  return haystack.includes(needle) ? 1 : -1
}

/** sqlCompletions builds the suggestion list for a context, best match first. */
export function sqlCompletions(context: CompletionContext, tables: CompletionTable[], limit = 40): Completion[] {
  const aliases = context.statement ? tableAliases(context.statement.body) : {}
  const findTable = (name: string) => {
    const target = (aliases[name.toLowerCase()] ?? name).toLowerCase()
    return tables.find(table => table.name.toLowerCase() === target)
  }

  const candidates: Completion[] = []
  if (context.qualifier) {
    const table = findTable(context.qualifier)
    for (const column of table?.columns ?? []) candidates.push({ label: column, detail: table!.name, kind: 'column' })
  } else {
    for (const table of tables) candidates.push({ label: table.name, detail: table.schema, kind: 'table' })
    if (context.wants !== 'table') {
      // Columns of the tables this statement already mentions come before
      // keywords, because they are what the writer is most likely reaching for.
      const mentioned = new Set(Object.values(aliases).map(name => name.toLowerCase()))
      for (const table of tables) {
        if (!mentioned.has(table.name.toLowerCase())) continue
        for (const column of table.columns) candidates.push({ label: column, detail: table.name, kind: 'column' })
      }
      for (const keyword of KEYWORDS) candidates.push({ label: keyword.toUpperCase(), detail: 'keyword', kind: 'keyword' })
    }
  }

  const order: Record<CompletionKind, number> = { column: 0, table: 1, keyword: 2 }
  const seen = new Set<string>()
  return candidates
    .map(item => ({ item, score: rank(item.label, context.prefix) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => a.score - b.score || order[a.item.kind] - order[b.item.kind])
    .filter(entry => {
      const key = `${entry.item.kind}:${entry.item.label.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
    .map(entry => entry.item)
}
