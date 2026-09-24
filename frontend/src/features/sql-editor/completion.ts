import { PostgreSQL, SQLite } from '@codemirror/lang-sql'
import { scanSql, type SqlToken } from './sql'
import type { ColumnInfo, TableRef } from '../../types'

export type CompletionTable = TableRef & {
  columns: string[]
  columnInfo?: ColumnInfo[]
  columnsLoaded?: boolean
  type?: 'table' | 'view'
}
export type SqlCompletion = {
  label: string
  insertText: string
  detail: string
  kind: 'column' | 'table' | 'schema' | 'alias' | 'function' | 'keyword'
  info?: string
  cursorOffset?: number
}
export type SqlCompletionResult = {
  from: number
  to: number
  prefix: string
  options: SqlCompletion[]
  neededTables: CompletionTable[]
  automatic: boolean
}

type Identifier = { name: string; quoted: boolean }
type Token = SqlToken & { raw: string; word: string; id: Identifier; close: number }
type Projection = { alias?: Identifier; path?: Identifier[]; star?: boolean }
type Relation = {
  path: Identifier[]
  alias?: Identifier
  query?: Scope
  columns?: Identifier[]
  cte?: Relation
  tableFunction?: boolean
  at: number
}
type Scope = {
  from: number
  to: number
  parent?: Scope
  parentBefore?: number
  ctes: Map<string, Relation>
  relations: Relation[]
  projections: Projection[]
  tokens: number[]
}
type Column = { name: string; type?: string; primaryKey?: boolean; nullable?: boolean }

const clauseWords = new Set(
  'select from where on using group having order limit offset returning set values window union except intersect'.split(
    ' ',
  ),
)
const relationWords = new Set(['from', 'join', 'update', 'into'])
const aliasStops = new Set(
  'as select from where join left right full inner outer cross natural on using group having order by limit offset union except intersect returning set values window lateral only tablesample fetch for end when then else asc desc nulls filter over'.split(
    ' ',
  ),
)
const expressionKeywords = 'CASE WHEN THEN ELSE END CAST DISTINCT NULL TRUE FALSE EXISTS NOT COALESCE'
const predicateKeywords = 'AND OR NOT IN IS NULL LIKE BETWEEN EXISTS CASE'
const functions: Record<string, string> = {
  COUNT: 'COUNT(expression) → number of input rows',
  SUM: 'SUM(expression) → sum of non-null values',
  AVG: 'AVG(expression) → average of non-null values',
  MIN: 'MIN(expression) → minimum value',
  MAX: 'MAX(expression) → maximum value',
  COALESCE: 'COALESCE(value, ...) → first non-null value',
  NULLIF: 'NULLIF(value, other) → NULL when values are equal',
  LOWER: 'LOWER(text) → lowercase text',
  UPPER: 'UPPER(text) → uppercase text',
  LENGTH: 'LENGTH(value) → length of text or data',
  ROUND: 'ROUND(number, precision) → rounded number',
  ABS: 'ABS(number) → absolute value',
  TRIM: 'TRIM(text) → text without surrounding spaces',
  REPLACE: 'REPLACE(text, from, to) → replace matching text',
  SUBSTR: 'SUBSTR(text, start, length) → substring',
  ROW_NUMBER: 'ROW_NUMBER() OVER (...) → row number within a partition',
  RANK: 'RANK() OVER (...) → rank with gaps',
  DENSE_RANK: 'DENSE_RANK() OVER (...) → rank without gaps',
  LAG: 'LAG(value, offset, default) OVER (...) → preceding value',
  LEAD: 'LEAD(value, offset, default) OVER (...) → following value',
}
const postgresFunctions: Record<string, string> = {
  STRING_AGG: 'STRING_AGG(value, delimiter) → concatenate values',
  ARRAY_AGG: 'ARRAY_AGG(value) → collect values into an array',
  JSON_AGG: 'JSON_AGG(value) → collect values into JSON',
  JSONB_AGG: 'JSONB_AGG(value) → collect values into JSONB',
  DATE_TRUNC: 'DATE_TRUNC(precision, timestamp) → truncate timestamp',
  NOW: 'NOW() → current transaction timestamp',
  TO_CHAR: 'TO_CHAR(value, format) → formatted text',
  UNNEST: 'UNNEST(array) → expand array elements',
}
const sqliteFunctions: Record<string, string> = {
  GROUP_CONCAT: 'GROUP_CONCAT(value, separator) → concatenate values',
  IFNULL: 'IFNULL(value, fallback) → replace NULL',
  IIF: 'IIF(condition, true_value, false_value) → conditional value',
  STRFTIME: 'STRFTIME(format, time, ...) → formatted date/time',
  DATETIME: 'DATETIME(time, ...) → date and time',
  JULIANDAY: 'JULIANDAY(time, ...) → Julian day number',
  JSON_EXTRACT: 'JSON_EXTRACT(json, path, ...) → extract JSON values',
}
const wordCharacter = /[\p{L}\p{N}\p{M}_$]/u

function identifier(raw: string): Identifier {
  const first = raw[0]
  const closer = first === '[' ? ']' : first
  const quoted = first === '"' || first === '[' || first === String.fromCharCode(96)
  let name = quoted ? raw.slice(1, raw.endsWith(closer) && raw.length > 1 ? -1 : undefined) : raw
  if (quoted) name = name.split(closer + closer).join(closer)
  return { name, quoted }
}

function isName(token: Token | undefined): token is Token & { type: 'plain' | 'quoted' | 'keyword' } {
  return (
    !!token &&
    (token.type === 'plain' ||
      token.type === 'quoted' ||
      (token.type === 'keyword' && !aliasStops.has(token.word) && !clauseWords.has(token.word)))
  )
}

/** Tolerant, statement-local scope analysis. No SQL is executed to infer results. */
class ScopeAnalysis {
  tokens: Token[]
  scopes: Scope[] = []
  root: Scope
  private pg: boolean

  constructor(
    readonly text: string,
    raw: SqlToken[],
    readonly driver: string,
  ) {
    this.pg = driver === 'PostgreSQL'
    this.tokens = raw
      .filter((t) => t.type !== 'comment')
      .map((t) => ({
        ...t,
        raw: text.slice(t.start, t.end),
        word: t.type === 'quoted' ? '' : text.slice(t.start, t.end).toLowerCase(),
        id: identifier(text.slice(t.start, t.end)),
        close: -1,
      }))
    const stack: number[] = []
    this.tokens.forEach((t, i) => {
      if (t.raw === '(') stack.push(i)
      if (t.raw === ')') {
        const open = stack.pop()
        if (open !== undefined) this.tokens[open].close = i
      }
    })
    for (const open of stack) this.tokens[open].close = this.tokens.length
    this.root = this.parse(0, this.tokens.length, new Map())
  }

  key(id: Identifier): string {
    return this.pg && id.quoted ? id.name : id.name.toLowerCase()
  }
  matches(name: string, id: Identifier): boolean {
    return this.pg ? name === this.key(id) : name.toLowerCase() === id.name.toLowerCase()
  }

  private level(from: number, to: number): number[] {
    const indices: number[] = []
    for (let i = from; i < to; i++) {
      indices.push(i)
      if (this.tokens[i].raw === '(') i = Math.min(this.tokens[i].close, to)
    }
    return indices
  }

  private names(from: number, to: number): Identifier[] {
    return this.level(from, to)
      .filter((i) => isName(this.tokens[i]))
      .map((i) => this.tokens[i].id)
  }

  private parse(
    from: number,
    to: number,
    inherited: Map<string, Relation>,
    parent?: Scope,
    parentBefore?: number,
    depth = 0,
  ): Scope {
    const ctes = new Map(inherited)
    let begin = from
    // Bound recursion on incomplete or adversarially nested buffers.
    if (depth < 80 && this.tokens[begin]?.word === 'with') {
      begin++
      const recursive = this.tokens[begin]?.word === 'recursive'
      if (recursive) begin++
      while (begin < to && isName(this.tokens[begin])) {
        const cte: Relation = { path: [this.tokens[begin++].id], at: begin }
        if (this.tokens[begin]?.raw === '(') {
          cte.columns = this.names(begin + 1, this.tokens[begin].close)
          begin = this.tokens[begin].close + 1
        }
        if (this.tokens[begin]?.word !== 'as') break
        begin++
        if (this.tokens[begin]?.word === 'not') begin++
        if (this.tokens[begin]?.word === 'materialized') begin++
        if (this.tokens[begin]?.raw !== '(') break
        const close = Math.min(this.tokens[begin].close, to)
        if (recursive) ctes.set(this.key(cte.path[0]), cte)
        cte.query = this.parse(begin + 1, close, ctes, undefined, undefined, depth + 1)
        ctes.set(this.key(cte.path[0]), cte)
        begin = close + 1
        if (this.tokens[begin]?.raw !== ',') break
        begin++
      }
    }

    // Each UNION/INTERSECT/EXCEPT operand owns its relation namespace.
    const separators = this.level(begin, to).filter((i) =>
      ['union', 'intersect', 'except'].includes(this.tokens[i].word),
    )
    const bounds = [
      begin,
      ...separators.map((i) => i + (['all', 'distinct'].includes(this.tokens[i + 1]?.word) ? 2 : 1)),
      to,
    ]
    let first: Scope | undefined
    for (let part = 0; part < bounds.length - 1; part++) {
      const start = bounds[part],
        end = separators[part] ?? to
      const scope: Scope = {
        from: this.tokens[start]?.start ?? this.text.length,
        to: this.tokens[end]?.start ?? this.text.length,
        parent,
        parentBefore,
        ctes: new Map(ctes),
        relations: [],
        projections: [],
        tokens: this.level(start, end),
      }
      first ??= scope
      this.scopes.push(scope)
      if (depth >= 80) continue
      const children = new Set<number>()
      let inFrom = false
      for (let p = 0; p < scope.tokens.length; p++) {
        const at = scope.tokens[p],
          t = this.tokens[at]
        const relationStart = relationWords.has(t.word) || (inFrom && t.raw === ',')
        if (clauseWords.has(t.word) && t.word !== 'from') inFrom = false
        if (t.word === 'from' || t.word === 'join') inFrom = true
        if (!relationStart) continue
        let i = at + 1
        const lateral = this.tokens[i]?.word === 'lateral'
        if (lateral) i++
        if (this.tokens[i]?.word === 'only') i++
        const relation: Relation = { path: [], at }
        if (this.tokens[i]?.raw === '(') {
          const close = Math.min(this.tokens[i].close, end)
          if (!['select', 'with', 'values'].includes(this.tokens[i + 1]?.word)) continue
          children.add(i)
          relation.query = this.parse(
            i + 1,
            close,
            ctes,
            lateral ? scope : undefined,
            lateral ? at : undefined,
            depth + 1,
          )
          i = close + 1
        } else if (isName(this.tokens[i])) {
          relation.path.push(this.tokens[i++].id)
          while (this.tokens[i]?.raw === '.' && isName(this.tokens[i + 1])) {
            relation.path.push(this.tokens[i + 1].id)
            i += 2
          }
          if (relation.path.length === 1) relation.cte = ctes.get(this.key(relation.path[0]))
          // A table-valued function is not a physical table.
          if (this.tokens[i]?.raw === '(') {
            i = this.tokens[i].close + 1
            relation.tableFunction = true
          }
        } else continue
        if (this.tokens[i]?.word === 'as') i++
        if (isName(this.tokens[i]) && !aliasStops.has(this.tokens[i].word)) relation.alias = this.tokens[i++].id
        if (relation.alias && this.tokens[i]?.raw === '(') {
          relation.columns = this.names(i + 1, this.tokens[i].close)
          i = this.tokens[i].close + 1
        }
        scope.relations.push(relation)
        while (p + 1 < scope.tokens.length && scope.tokens[p + 1] < i) p++
      }
      this.projections(scope)
      // Scalar/EXISTS subqueries may correlate with their containing query.
      const visit = (lo: number, hi: number, nesting: number) => {
        if (nesting >= 80) return
        for (const i of this.level(lo, hi)) {
          if (this.tokens[i].raw !== '(' || children.has(i)) continue
          const close = Math.min(this.tokens[i].close, hi)
          if (['select', 'with', 'values'].includes(this.tokens[i + 1]?.word))
            this.parse(i + 1, close, ctes, scope, undefined, depth + 1)
          else visit(i + 1, close, nesting + 1)
        }
      }
      visit(start, end, depth)
    }
    return first!
  }

  private projections(scope: Scope) {
    const top = scope.tokens
    const select = top.findIndex((i) => this.tokens[i].word === 'select')
    if (select < 0) return
    let end = select + 1
    while (
      end < top.length &&
      !['from', 'where', 'group', 'having', 'order', 'limit', 'window'].includes(this.tokens[top[end]].word)
    )
      end++
    let start = select + 1
    if (['distinct', 'all'].includes(this.tokens[top[start]]?.word)) start++
    if (this.tokens[top[start]]?.word === 'on' && this.tokens[top[start + 1]]?.raw === '(') start += 2
    const add = (indices: number[]) => {
      if (!indices.length) return
      let items = indices.map((i) => this.tokens[i])
      const projection: Projection = {}
      const as = items.findIndex((t) => t.word === 'as')
      if (as >= 0 && isName(items[as + 1])) {
        projection.alias = items[as + 1].id
        items = items.slice(0, as)
      } else if (
        items.length > 1 &&
        isName(items.at(-1)) &&
        items.at(-2)?.raw !== '.' &&
        (isName(items.at(-2)) || items.at(-2)?.raw === '(' || ['number', 'string'].includes(items.at(-2)?.type ?? ''))
      ) {
        projection.alias = items.pop()!.id
      }
      if (items.length === 1 && items[0].raw === '*') projection.star = true
      else {
        const path: Identifier[] = []
        let valid = true
        items.forEach((t, n) => {
          if (n % 2) {
            if (t.raw !== '.') valid = false
          } else if (isName(t)) path.push(t.id)
          else if (t.raw === '*' && n === items.length - 1) projection.star = true
          else valid = false
        })
        if (valid && items.length % 2) projection.path = path
      }
      if (projection.alias || projection.path || projection.star) scope.projections.push(projection)
    }
    let chunk: number[] = []
    for (const i of top.slice(start, end)) {
      if (this.tokens[i].raw === ',') {
        add(chunk)
        chunk = []
      } else chunk.push(i)
    }
    add(chunk)
  }

  active(caret: number): Scope {
    return (
      this.scopes.filter((s) => caret >= s.from && caret <= s.to).sort((a, b) => a.to - a.from - (b.to - b.from))[0] ??
      this.root
    )
  }

  visible(scope: Scope): Relation[] {
    const result: Relation[] = [],
      seen = new Set<string>()
    let before = Infinity
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      for (const r of s.relations) {
        if (r.at >= before) continue
        const id = r.alias ?? r.path.at(-1)
        const key = id ? this.key(id) : ''
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        result.push(r)
      }
      before = s.parentBefore ?? Infinity
    }
    return result
  }

  relationMatches(r: Relation, path: Identifier[]): boolean {
    const target = r.alias ? [r.alias] : r.path
    if (path.length > target.length) return false
    return path.every((id, i) => this.key(id) === this.key(target[target.length - path.length + i]))
  }

  tablesFor(r: Relation, tables: CompletionTable[]): CompletionTable[] {
    if (r.cte || r.query || r.tableFunction || !r.path.length) return []
    const name = r.path.at(-1)!,
      schema = r.path.at(-2)
    const matches = tables.filter((t) => this.matches(t.name, name) && (!schema || this.matches(t.schema, schema)))
    // Without server search_path metadata, never guess between duplicate names.
    return matches.length === 1 ? matches : []
  }

  columnsFor(r: Relation, tables: CompletionTable[], visiting = new Set<Relation>()): Column[] {
    if (visiting.has(r)) return (r.columns ?? []).map((id) => ({ name: id.name }))
    const next = new Set(visiting).add(r)
    let columns: Column[]
    if (r.cte) columns = this.columnsFor(r.cte, tables, next)
    else if (r.query) columns = this.outputs(r.query, tables, next)
    else
      columns = this.tablesFor(r, tables).flatMap((t) =>
        t.columns.map((name) => t.columnInfo?.find((c) => c.name === name) ?? { name }),
      )
    if (r.columns)
      columns = r.columns
        .map((id, i) => ({ ...columns[i], name: this.key(id) }))
        .concat(columns.slice(r.columns.length))
    return columns
  }

  outputs(scope: Scope, tables: CompletionTable[], visiting = new Set<Relation>()): Column[] {
    return scope.projections.flatMap((p) => {
      if (p.alias) return [{ name: this.key(p.alias) }]
      if (p.star)
        return scope.relations
          .filter((r) => !p.path?.length || this.relationMatches(r, p.path))
          .flatMap((r) => this.columnsFor(r, tables, visiting))
      const name = p.path?.at(-1)
      return name ? [{ name: this.key(name) }] : []
    })
  }

  needed(scope: Scope, tables: CompletionTable[], relations = this.visible(scope)): CompletionTable[] {
    const wanted = new Set<CompletionTable>(),
      seen = new Set<Relation>()
    const visit = (r: Relation) => {
      if (seen.has(r)) return
      seen.add(r)
      if (r.cte) visit(r.cte)
      if (r.query) r.query.relations.forEach(visit)
      for (const t of this.tablesFor(r, tables)) if (!t.columnsLoaded && !t.columns.length) wanted.add(t)
    }
    relations.forEach(visit)
    return [...wanted]
  }
}

function score(label: string, prefix: string): number {
  const name = label.toLowerCase(),
    needle = prefix.toLowerCase()
  if (!needle) return 0
  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  const initials = label
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split(/[_\s.-]+/)
    .map((s) => s[0] ?? '')
    .join('')
    .toLowerCase()
  if (initials.startsWith(needle)) return 2
  if (name.includes(needle)) return 3
  if (needle.length < 2) return -1
  let at = -1,
    gaps = 0
  for (const char of needle) {
    const next = name.indexOf(char, at + 1)
    if (next < 0) return -1
    gaps += next - at - 1
    at = next
  }
  return 4 + gaps / Math.max(1, name.length)
}

const reserved = new Map<string, Set<string>>()
function quote(name: string, driver: string, force = false): string {
  let words = reserved.get(driver)
  if (!words) {
    words = new Set((driver === 'PostgreSQL' ? PostgreSQL : SQLite).spec.keywords?.toLowerCase().split(/\s+/))
    reserved.set(driver, words)
  }
  return !force && /^[a-z_][a-z0-9_$]*$/.test(name) && !words.has(name.toLowerCase())
    ? name
    : '"' + name.replace(/"/g, '""') + '"'
}

/** One ranked result for CodeMirror and headless regression tests. */
export function completeSql(
  text: string,
  caret: number,
  tables: CompletionTable[],
  driver = 'SQLite',
  limit = 100,
): SqlCompletionResult | null {
  caret = Math.max(0, Math.min(caret, text.length))
  const scanned = scanSql(text, driver)
  const enclosing = scanned.tokens.find((t) => caret > t.start && caret <= t.end)
  if (enclosing?.type === 'string' || enclosing?.type === 'comment') {
    if (caret < enclosing.end || !enclosing.closed) return null
  }
  let from = caret,
    to = caret,
    prefix = '',
    quoted = false
  if (enclosing?.type === 'quoted') {
    from = enclosing.start
    to = enclosing.end
    quoted = true
    prefix = identifier(text.slice(from, caret)).name
  } else {
    // The scanner tracks full Unicode code points, including surrogate pairs.
    if (enclosing && (enclosing.type === 'plain' || enclosing.type === 'keyword')) {
      from = enclosing.start
      to = enclosing.end
    }
    while (from > 0 && wordCharacter.test(text[from - 1])) from--
    while (to < text.length && wordCharacter.test(text[to])) to++
    prefix = text.slice(from, caret)
    if ([':', '@', '$'].includes(text[from - 1]) && text[from - 2] !== ':') return null
    if (/^[0-9$]/.test(prefix)) return null
  }
  // Unlike execution selection, completion never borrows a neighbouring statement.
  const previous = scanned.statements.filter((s) => s.end <= from && text[s.end - 1] === ';').at(-1)
  const statementStart = previous?.end ?? 0
  const statementEnd = scanned.statements.find((s) => s.start >= statementStart && s.end >= caret)?.end ?? text.length
  const raw = scanned.tokens.filter((t) => t.start >= statementStart && t.start < statementEnd)
  const analysis = new ScopeAnalysis(text, raw, driver)
  const scope = analysis.active(caret)
  const before = analysis.tokens.filter((t) => t.end <= from)
  const qualifier: Identifier[] = []
  for (let i = before.length - 1; i >= 1 && before[i].raw === '.' && isName(before[i - 1]); i -= 2)
    qualifier.unshift(before[i - 1].id)
  const topBefore = scope.tokens.filter((i) => analysis.tokens[i].end <= from)
  let clause = ''
  for (const i of topBefore) if (clauseWords.has(analysis.tokens[i].word)) clause = analysis.tokens[i].word
  const last = before.at(-1)
  const lastTop = analysis.tokens[topBefore.at(-1) ?? -1]
  const wantsTable =
    relationWords.has(lastTop?.word ?? '') ||
    (clause === 'from' && lastTop?.raw === ',') ||
    (['lateral', 'only'].includes(lastTop?.word ?? '') && clause === 'from') ||
    (!!qualifier.length && clause === 'from' && !['on', 'using'].includes(lastTop?.word ?? ''))
  const declaring =
    last?.word === 'as' ||
    (!qualifier.length &&
      clause === 'from' &&
      !wantsTable &&
      !!last &&
      isName(last) &&
      !['asc', 'desc'].includes(last.word))
  const visible = analysis
    .visible(scope)
    .filter((r) => clause !== 'on' || !scope.relations.includes(r) || analysis.tokens[r.at].start < from)
  const options: SqlCompletion[] = []
  const q = (name: string) => quote(name, driver)
  const add = (item: SqlCompletion) => options.push(item)
  const column = (name: string, insertText: string, detail: string, meta?: Column) =>
    add({
      label: name,
      insertText,
      detail: [meta?.type, detail].filter(Boolean).join(' · '),
      kind: 'column',
      info: meta
        ? [meta.type, meta.primaryKey ? 'Primary key' : '', meta.nullable === false ? 'Not null' : '']
            .filter(Boolean)
            .join(' · ')
        : undefined,
    })
  const neededTables =
    wantsTable || declaring
      ? []
      : analysis.needed(
          scope,
          tables,
          qualifier.length ? visible.filter((r) => analysis.relationMatches(r, qualifier)) : visible,
        )

  if (clause === 'using') {
    const open = [...topBefore].reverse().find((i) => analysis.tokens[i].raw === '(')
    const joining = scope.relations.filter((r) => open !== undefined && r.at < open)
    const right = joining.at(-1)
    const leftNames = new Set(joining.slice(0, -1).flatMap((r) => analysis.columnsFor(r, tables).map((c) => c.name)))
    const used = new Set(
      before
        .filter((t) => open !== undefined && t.start > analysis.tokens[open].start && isName(t))
        .map((t) => analysis.key(t.id)),
    )
    if (!qualifier.length && right)
      for (const c of analysis.columnsFor(right, tables))
        if (leftNames.has(c.name) && !used.has(c.name)) column(c.name, quote(c.name, driver, quoted), 'join column', c)
  } else if (qualifier.length && !wantsTable) {
    const relation = visible.find((r) => analysis.relationMatches(r, qualifier))
    if (relation)
      for (const c of analysis.columnsFor(relation, tables))
        column(c.name, quote(c.name, driver, quoted), qualifier.map((id) => id.name).join('.'), c)
    // No fallback to globally known tables: an alias outside this scope is invalid.
  } else if (wantsTable) {
    if (!qualifier.length)
      for (const [name] of scope.ctes)
        add({ label: name, insertText: quote(name, driver, quoted), detail: 'CTE', kind: 'table' })
    const tableNameCounts = new Map<string, number>()
    for (const t of tables) {
      const key = t.name.toLowerCase()
      tableNameCounts.set(key, (tableNameCounts.get(key) ?? 0) + 1)
    }
    for (const t of tables) {
      if (qualifier.length && (qualifier.length !== 1 || !analysis.matches(t.schema, qualifier[0]))) continue
      const duplicates = (tableNameCounts.get(t.name.toLowerCase()) ?? 0) > 1
      const shadowed = scope.ctes.has(driver === 'PostgreSQL' ? t.name : t.name.toLowerCase())
      const qualified = !qualifier.length && (duplicates || shadowed) && !!t.schema
      add({
        label: qualified ? t.schema + '.' + t.name : t.name,
        insertText: qualified ? q(t.schema) + '.' + q(t.name) : quote(t.name, driver, quoted),
        detail: [t.schema, t.type ?? 'table'].filter(Boolean).join(' · '),
        kind: 'table',
      })
    }
    if (!qualifier.length)
      for (const schema of new Set(tables.map((t) => t.schema).filter(Boolean)))
        add({ label: schema, insertText: quote(schema, driver, quoted) + '.', detail: 'schema', kind: 'schema' })
  } else if (!declaring || last?.word !== 'as') {
    const expression = ['select', 'where', 'on', 'having', 'group', 'order', 'set', 'returning', 'values'].includes(
      clause,
    )
    const relationColumns = (declaring || !expression ? [] : visible).map((r) => ({
      r,
      columns: analysis.columnsFor(r, tables),
    }))
    const counts = new Map<string, number>()
    for (const { columns } of relationColumns)
      for (const c of columns) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
    for (const { r, columns } of relationColumns) {
      const ref = r.alias ? [r.alias] : r.path
      const relationName = ref.map((id) => id.name).join('.')
      for (const c of columns) {
        const ambiguous = (counts.get(c.name) ?? 0) > 1
        if (ambiguous && !ref.length) continue
        column(
          ambiguous ? relationName + '.' + c.name : c.name,
          (ambiguous ? ref.map((id) => q(analysis.key(id))).join('.') + '.' : '') + quote(c.name, driver, quoted),
          relationName,
          c,
        )
      }
      if (ref.length)
        add({
          label: relationName,
          insertText: ref.map((id) => q(analysis.key(id))).join('.') + '.',
          detail: r.query || r.cte ? 'query alias' : 'table alias',
          kind: 'alias',
        })
    }
    if (['order', 'group'].includes(clause) || (driver !== 'PostgreSQL' && clause === 'having'))
      for (const p of scope.projections)
        if (p.alias) column(analysis.key(p.alias), quote(analysis.key(p.alias), driver, quoted), 'select alias')

    if (expression && !quoted) {
      const catalog = { ...functions, ...(driver === 'PostgreSQL' ? postgresFunctions : sqliteFunctions) }
      const lowerCase = /^[a-z]+$/.test(prefix)
      const hasParen = /^\s*\(/.test(text.slice(to))
      for (const [name, signature] of Object.entries(catalog)) {
        const label = lowerCase ? name.toLowerCase() : name
        add({
          label,
          insertText: label + (hasParen ? '' : '()'),
          detail: 'function',
          kind: 'function',
          info: signature,
          cursorOffset: hasParen ? undefined : label.length + 1,
        })
      }
    }
    let keywords = ''
    if (!clause) keywords = 'SELECT WITH EXPLAIN'
    else if (clause === 'from') keywords = 'AS JOIN LEFT JOIN INNER JOIN CROSS JOIN WHERE GROUP BY ORDER BY LIMIT'
    else if (clause === 'select') keywords = expressionKeywords + ' FROM'
    else if (['where', 'on', 'having'].includes(clause)) keywords = predicateKeywords
    else if (['order', 'group'].includes(clause)) keywords = last?.word === clause ? 'BY' : 'ASC DESC NULLS FIRST LAST'
    else if (clause === 'limit' || clause === 'offset') keywords = ''
    else keywords = expressionKeywords
    if (driver === 'PostgreSQL' && ['where', 'on', 'having'].includes(clause)) keywords += ' ILIKE'
    // Expressions also need the clauses that can follow them. Restricting
    // WHERE to predicate operators, or ORDER BY to sort modifiers, hid paging.
    if (['select', 'from', 'where', 'on', 'group', 'having', 'window', 'order', 'limit', 'offset'].includes(clause))
      keywords += ' LIMIT OFFSET'
    // Check this query scope only, and omit the word currently being replaced
    // so existing LIMIT/OFFSET tokens can still be completed in their middle.
    const paginationInScope = new Set<string>(
      scope.tokens
        .map((i) => analysis.tokens[i])
        .filter((token) => token.end <= from || token.start >= to)
        .map((token) => token.word)
        .filter((word) => word === 'limit' || word === 'offset'),
    )
    if (!quoted)
      for (const word of new Set(keywords.split(' ').filter(Boolean))) {
        if (paginationInScope.has(word.toLowerCase())) continue
        const label = /^[a-z]+$/.test(prefix) ? word.toLowerCase() : word
        add({ label, insertText: label, detail: 'keyword', kind: 'keyword' })
      }
  }
  const order = { column: 0, alias: 1, table: 2, schema: 3, function: 4, keyword: 5 }
  const seen = new Set<string>()
  const ranked = options
    .map((item) => ({ item, score: score(item.label, prefix) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        a.score - b.score || order[a.item.kind] - order[b.item.kind] || a.item.label.localeCompare(b.item.label),
    )
    .filter(({ item }) => {
      const key = item.kind + ':' + item.insertText
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
    .map((entry) => entry.item)
  return {
    from,
    to,
    prefix,
    options: ranked,
    neededTables,
    automatic:
      !!prefix ||
      !!qualifier.length ||
      wantsTable ||
      (!!last &&
        (['select', 'where', 'on', 'having', 'by'].includes(last.word) ||
          (['select', 'where', 'on', 'having', 'using', 'order', 'group'].includes(clause) &&
            [',', '('].includes(last.raw)))),
  }
}
