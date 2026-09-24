import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Bundle the actual production modules in memory; no DOM, mocks of the SQL engine,
// generated source files, or extra runtime test framework.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export * from './src/features/sql-editor/completion.ts'",
      "export * from './src/features/sql-editor/completionSource.ts'",
      "export * from './src/features/sql-editor/completionMetadata.ts'",
      "export * from './src/features/sql-editor/sql.ts'",
      "export { EditorState } from '@codemirror/state'",
      "export { CompletionContext } from '@codemirror/autocomplete'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const {
  completeSql,
  completionInsertion,
  createSqlCompletionSource,
  createCompletionMetadataCache,
  scanSql,
  planPagination,
  pageQuery,
  EditorState,
  CompletionContext,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'))

const tables = [
  { schema: 'public', name: 'users', columns: ['id', 'name', 'email', 'created_at'], columnsLoaded: true },
  { schema: 'public', name: 'orders', columns: ['id', 'user_id', 'total'], columnsLoaded: true },
  { schema: 'audit', name: 'events', columns: ['event_id', 'payload'], columnsLoaded: true },
]
function complete(query, catalog = tables, driver = 'PostgreSQL') {
  assert.ok(query.includes('|'), 'query needs a caret marker')
  return completeSql(query.replace('|', ''), query.indexOf('|'), catalog, driver)
}
function columns(query, catalog = tables, driver) {
  return (
    complete(query, catalog, driver)
      ?.options.filter((o) => o.kind === 'column')
      .map((o) => o.label) ?? []
  )
}
function names(query, kind, catalog = tables, driver) {
  return (
    complete(query, catalog, driver)
      ?.options.filter((o) => !kind || o.kind === kind)
      .map((o) => o.label) ?? []
  )
}
function apply(query, label, catalog = tables, driver) {
  const r = complete(query, catalog, driver)
  const item = r.options.find((o) => o.label === label)
  assert.ok(item, label + ' missing from ' + JSON.stringify(r.options))
  const text = query.replace('|', '')
  const edit = completionInsertion(item, text.slice(r.to))
  return { text: text.slice(0, r.from) + edit.insert + text.slice(r.to), caret: r.from + edit.cursor }
}

for (const query of [
  'SELECT u.| FROM users u',
  'SELECT u.| FROM users AS u',
  'SELECT u.| FROM public . users AS u',
  'SELECT u.| FROM users u, orders o',
  'SELECT u.| FROM users u CROSS JOIN orders o',
  'SELECT u.| FROM users u /* alias */ WHERE true',
])
  test('relation alias: ' + query, () => assert.deepEqual(columns(query), ['created_at', 'email', 'id', 'name']))

test('ambiguous columns are qualified without losing either origin', () => {
  const items = columns('SELECT | FROM users u JOIN orders o ON u.id = o.user_id')
  assert.ok(items.includes('u.id'))
  assert.ok(items.includes('o.id'))
  assert.ok(!items.includes('id'))
})
test('an alias hides the original table name', () => assert.deepEqual(columns('SELECT users.| FROM users u'), []))
test('unknown qualifiers do not leak global schema', () => assert.deepEqual(columns('SELECT events.| FROM users'), []))
test('correlated subqueries see outer aliases', () =>
  assert.ok(columns('SELECT * FROM users u WHERE EXISTS (SELECT u.| FROM orders o)').includes('email')))
test('local aliases shadow outer aliases', () =>
  assert.deepEqual(columns('SELECT * FROM users u WHERE EXISTS (SELECT u.| FROM orders u)'), [
    'id',
    'total',
    'user_id',
  ]))
test('inner aliases do not escape their subquery', () =>
  assert.deepEqual(columns('SELECT o.| FROM users u WHERE EXISTS (SELECT 1 FROM orders o)'), []))
test('siblings do not share aliases', () =>
  assert.deepEqual(columns('SELECT (SELECT o.|), (SELECT 1 FROM orders o) FROM users'), []))
test('UNION branches own separate aliases', () =>
  assert.deepEqual(columns('SELECT * FROM orders o UNION ALL SELECT o.| FROM users u'), []))
test('UNION second branch resolves its own aliases', () =>
  assert.ok(columns('SELECT * FROM orders u UNION SELECT u.| FROM users u').includes('email')))
test('derived tables expose their projection', () =>
  assert.deepEqual(columns('SELECT d.| FROM (SELECT id, total AS amount FROM orders) d'), ['amount', 'id']))
test('derived wildcards expand through physical metadata', () =>
  assert.deepEqual(columns('SELECT d.| FROM (SELECT o.* FROM orders o) d'), ['id', 'total', 'user_id']))
test('derived expression aliases survive nested functions', () =>
  assert.deepEqual(columns('SELECT d.| FROM (SELECT COALESCE(SUM(total), 0) revenue FROM orders) d'), ['revenue']))
test('derived table column aliases rename output', () =>
  assert.deepEqual(columns('SELECT d.| FROM (SELECT id, total FROM orders) d(order_id, amount)'), [
    'amount',
    'order_id',
  ]))
test('non-lateral derived tables cannot correlate', () =>
  assert.deepEqual(columns('SELECT * FROM users u, (SELECT u.|) d'), []))
test('LATERAL sees preceding FROM items', () =>
  assert.ok(columns('SELECT * FROM users u, LATERAL (SELECT u.|) d').includes('email')))
test('LATERAL cannot see following FROM items', () =>
  assert.deepEqual(columns('SELECT * FROM LATERAL (SELECT u.|) d, users u'), []))

test('CTE projection aliases', () =>
  assert.deepEqual(columns('WITH c AS (SELECT id AS uid, name FROM users) SELECT c.| FROM c'), ['name', 'uid']))
test('CTE explicit column list', () =>
  assert.deepEqual(columns('WITH c(uid, nick) AS (SELECT id, name FROM users) SELECT c.| FROM c'), ['nick', 'uid']))
test('chained CTE wildcard projections', () =>
  assert.deepEqual(columns('WITH a AS (SELECT id, name FROM users), b AS (SELECT * FROM a) SELECT b.| FROM b'), [
    'id',
    'name',
  ]))
test('recursive CTEs resolve without cycling', () =>
  assert.deepEqual(columns('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT c.| FROM c'), ['n']))
test('recursive CTE is visible inside its body', () =>
  assert.deepEqual(columns('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT c.| FROM c) SELECT * FROM c'), ['n']))
test('future CTEs are not visible to earlier CTEs', () =>
  assert.ok(!names('WITH a AS (SELECT * FROM |), b AS (SELECT 1) SELECT * FROM a', 'table').includes('b')))
test('CTEs are suggested in FROM', () =>
  assert.ok(names('WITH c AS (SELECT name FROM users) SELECT * FROM |', 'table').includes('c')))
test('PostgreSQL materialized CTEs', () =>
  assert.deepEqual(columns('WITH c AS NOT MATERIALIZED (SELECT name FROM users) SELECT c.| FROM c'), ['name']))
test('CTE shadows a physical relation with the same name', () =>
  assert.deepEqual(columns('WITH users AS (SELECT total FROM orders) SELECT users.| FROM users'), ['total']))
test('nested WITH names stay local', () =>
  assert.ok(!names('SELECT * FROM (WITH c AS (SELECT 1) SELECT * FROM c) d JOIN |', 'table').includes('c')))

const duplicates = [...tables, { schema: 'archive', name: 'users', columns: ['archived_at'] }]
test('same-name tables remain distinct suggestions', () => {
  const items = names('SELECT * FROM us|', 'table', duplicates)
  assert.ok(items.includes('public.users') && items.includes('archive.users'))
})
test('schema-qualified references fetch the correct columns', () =>
  assert.deepEqual(columns('SELECT u.| FROM archive.users u', duplicates), ['archived_at']))
test('ambiguous unqualified tables are not guessed', () =>
  assert.deepEqual(columns('SELECT u.| FROM users u', duplicates), []))
test('schema dot completes only tables in that schema', () =>
  assert.deepEqual(names('SELECT * FROM audit.|', 'table'), ['events']))
test('quoted schema names work', () => assert.deepEqual(names('SELECT * FROM "audit".|', 'table'), ['events']))
test('schema qualification survives insertion', () =>
  assert.equal(apply('SELECT * FROM audit.ev|ents', 'events').text, 'SELECT * FROM audit.events'))
test('schema insertion reuses an existing dot', () =>
  assert.equal(apply('SELECT * FROM aud|it.events', 'audit').text, 'SELECT * FROM audit.events'))
test('schema suggestions are available after FROM', () =>
  assert.ok(names('SELECT * FROM |', 'schema').includes('public')))

const special = [{ schema: 'Sales Data', name: 'Order Items', columns: ['Order ID', 'a"b', 'select', 'normal'] }]
test('quoted identifiers preserve spaces and case', () =>
  assert.ok(columns('SELECT "o".| FROM "Sales Data"."Order Items" "o"', special).includes('Order ID')))
test('quoted word replacement consumes its closing quote', () =>
  assert.equal(
    apply('SELECT o."Ord|er ID" FROM "Sales Data"."Order Items" o', 'Order ID', special).text,
    'SELECT o."Order ID" FROM "Sales Data"."Order Items" o',
  ))
test('embedded identifier quotes are escaped', () =>
  assert.equal(
    apply('SELECT o.a| FROM "Sales Data"."Order Items" o', 'a"b', special).text,
    'SELECT o."a""b" FROM "Sales Data"."Order Items" o',
  ))
test('reserved words are quoted on insertion', () =>
  assert.ok(apply('SELECT o.sel| FROM "Sales Data"."Order Items" o', 'select', special).text.includes('o."select"')))
test('PostgreSQL quoted aliases are case-sensitive', () => assert.deepEqual(columns('SELECT o.| FROM users "O"'), []))
test('PostgreSQL matching quoted alias resolves', () =>
  assert.ok(columns('SELECT "O".| FROM users "O"').includes('email')))
test('SQLite aliases are case-insensitive', () =>
  assert.ok(columns('SELECT o.| FROM users "O"', tables, 'SQLite').includes('email')))
test('SQLite bracket identifiers', () =>
  assert.ok(columns('SELECT [u].| FROM [users] AS [u]', tables, 'SQLite').includes('email')))
test('Unicode identifiers', () =>
  assert.deepEqual(columns('SELECT к.| FROM клиенты к', [{ schema: '', name: 'клиенты', columns: ['имя'] }]), ['имя']))
test('dollar signs remain part of identifiers', () =>
  assert.deepEqual(columns('SELECT a$.| FROM users a$'), ['created_at', 'email', 'id', 'name']))
test('metadata named __proto__ is an ordinary identifier', () =>
  assert.deepEqual(columns('SELECT __proto__.| FROM users __proto__'), ['created_at', 'email', 'id', 'name']))

for (const query of [
  "SELECT 'hel|lo'",
  "SELECT 'unfinished|",
  "SELECT 'it''s |'",
  'SELECT $$hello|$$',
  'SELECT $body$hello|$body$',
  'SELECT $body$|',
  'SELECT 1 -- comment|',
  'SELECT /* comment| */ 1',
  'SELECT /* outer /* inner */ still | */ 1',
  "SELECT E'it\\'s |';",
  'SELECT :pa|',
  'SELECT @pa|',
  'SELECT $1|',
])
  test('suppresses literals/comments/parameters: ' + query, () => assert.equal(complete(query), null))
test('completion resumes after a closed comment', () => assert.ok(names('SELECT /* done */|').includes('COUNT')))
test('statement boundaries do not leak aliases', () =>
  assert.deepEqual(columns('SELECT * FROM users u; SELECT u.|'), []))
test('empty next statement does not reuse previous aliases', () =>
  assert.deepEqual(columns('SELECT * FROM users u; |'), []))
test('FROM only suggests relations and schemas', () =>
  assert.ok(complete('SELECT * FROM |').options.every((o) => ['table', 'schema'].includes(o.kind))))
test('comma in FROM expects a relation', () => assert.ok(names('SELECT * FROM users, |', 'table').includes('orders')))
test('comma in SELECT expects columns', () => assert.ok(columns('SELECT id, | FROM users').includes('email')))
test('inside functions does not become a relation context', () =>
  assert.ok(columns('SELECT COALESCE(|, 0) FROM orders').includes('total')))
test('WHERE does not suggest tables', () => assert.deepEqual(names('SELECT * FROM users WHERE us|', 'table'), []))
test('ORDER BY can see SELECT aliases', () =>
  assert.ok(columns('SELECT total AS revenue FROM orders ORDER BY rev|').includes('revenue')))
test('PostgreSQL WHERE cannot see SELECT aliases', () =>
  assert.ok(!columns('SELECT total AS revenue FROM orders WHERE rev|').includes('revenue')))
test('AS does not complete the alias being declared', () =>
  assert.deepEqual(names('SELECT total AS rev| FROM orders'), []))
test('keywords after a FROM relation remain reachable', () =>
  assert.ok(names('SELECT * FROM users wh|', 'keyword').includes('where')))
test('prefix matches outrank subsequence matches', () => assert.equal(columns('SELECT na| FROM users')[0], 'name'))
test('snake-case initials match columns', () => assert.ok(columns('SELECT ca| FROM users').includes('created_at')))
test('fuzzy subsequences match columns', () => assert.ok(columns('SELECT crt| FROM users').includes('created_at')))
test('mid-word replacement removes the old tail', () =>
  assert.ok(!apply('SELECT em|il FROM users', 'email').text.includes('emailil')))
test('functions are dialect-aware', () => {
  assert.ok(names('SELECT str|', 'function').includes('string_agg'))
  assert.ok(!names('SELECT str|', 'function', tables, 'SQLite').includes('string_agg'))
  assert.ok(names('SELECT str|', 'function', tables, 'SQLite').includes('strftime'))
})
test('function insertion puts the caret between parentheses', () => {
  const r = apply('SELECT cou|', 'count')
  assert.equal(r.text, 'SELECT count()')
  assert.equal(r.caret, 'SELECT count('.length)
})
test('existing function parentheses are preserved', () =>
  assert.equal(apply('SELECT co|unt(*)', 'count').text, 'SELECT count(*)'))
test('suggestion count is bounded', () =>
  assert.equal(completeSql('SELECT ', 7, tables, 'PostgreSQL', 3).options.length, 3))
test('incomplete subqueries remain usable', () =>
  assert.ok(columns('SELECT * FROM users u WHERE EXISTS (SELECT u.|').includes('email')))
test('incomplete CTEs remain usable', () => assert.ok(columns('WITH c AS (SELECT u.| FROM users u').includes('email')))
test('deeply nested incomplete SQL is bounded', () => {
  const query = 'SELECT '.repeat(1) + '(SELECT '.repeat(120) + '|'
  assert.doesNotThrow(() => complete(query))
})

test('metadata requests keep schema identity and only load relevant sources', () => {
  const catalog = duplicates.map((t) => ({ ...t, columns: [], columnsLoaded: false }))
  assert.deepEqual(
    complete('SELECT u.| FROM archive.users u', catalog).neededTables.map((t) => [t.schema, t.name]),
    [['archive', 'users']],
  )
})
test('metadata traverses CTE dependencies, not unrelated tables', () => {
  const catalog = tables.map((t) => ({ ...t, columns: [], columnsLoaded: false }))
  assert.deepEqual(
    complete('WITH c AS (SELECT * FROM orders) SELECT c.| FROM c', catalog).neededTables.map((t) => t.name),
    ['orders'],
  )
})
test('loaded empty metadata is not requested again', () =>
  assert.deepEqual(
    complete(
      'SELECT u.| FROM users u',
      tables.map((t) => ({ ...t, columns: [] })),
    ).neededTables,
    [],
  ))

test('metadata cache coalesces pending requests and caches failures', async () => {
  let calls = 0,
    updates = 0
  const cache = createCompletionMetadataCache(
    async () => {
      calls++
      throw new Error('unavailable module')
    },
    () => updates++,
  )
  await Promise.all([cache.load(tables[0]), cache.load(tables[0])])
  await cache.load(tables[0])
  assert.equal(calls, 1)
  assert.equal(updates, 1)
  assert.deepEqual(cache.get(tables[0]), [])
})
test('metadata cache separates identical names in different schemas', async () => {
  const cache = createCompletionMetadataCache(
    async (table) => [{ name: table.schema }],
    () => {},
  )
  await Promise.all([cache.load({ schema: 'a.b', name: 'c' }), cache.load({ schema: 'a', name: 'b.c' })])
  assert.deepEqual(cache.get({ schema: 'a.b', name: 'c' }), [{ name: 'a.b' }])
  assert.deepEqual(cache.get({ schema: 'a', name: 'b.c' }), [{ name: 'a' }])
})
test('metadata refresh ignores stale responses and permits retry', async () => {
  const resolvers = []
  const cache = createCompletionMetadataCache(
    () => new Promise((resolve) => resolvers.push(resolve)),
    () => {},
  )
  const first = cache.load(tables[0])
  await Promise.resolve()
  cache.clear()
  const second = cache.load(tables[0])
  await Promise.resolve()
  resolvers[1]([{ name: 'new' }])
  await second
  resolvers[0]([{ name: 'old' }])
  await first
  assert.deepEqual(cache.get(tables[0]), [{ name: 'new' }])
})
test('first completion waits for lazy columns and returns fresh options', async () => {
  let catalog = [{ ...tables[0], columns: [], columnsLoaded: false }]
  const source = createSqlCompletionSource({
    driver: () => 'PostgreSQL',
    tables: () => catalog,
    loadColumns: async (table) => {
      assert.equal(table.schema, 'public')
      catalog = [tables[0]]
    },
  })
  const query = 'SELECT u. FROM users u'
  const result = await source(new CompletionContext(EditorState.create({ doc: query }), 9, false))
  assert.ok(result.options.some((o) => o.label === 'email'))
})
test('completion apply carries the real replacement range and caret', async () => {
  const source = createSqlCompletionSource({ driver: () => 'PostgreSQL', tables: () => tables })
  const state = EditorState.create({ doc: 'SELECT co' })
  const result = await source(new CompletionContext(state, 9, true))
  let transaction
  result.options
    .find((o) => o.label === 'count')
    .apply(
      {
        state,
        dispatch: (spec) => {
          transaction = state.update(spec)
        },
      },
      {},
      result.from,
      result.to,
    )
  assert.equal(transaction.newDoc.toString(), 'SELECT count()')
  assert.equal(transaction.newSelection.main.head, 13)
})

test('scanner preserves pagination and semicolons in nested comments/strings', () => {
  assert.equal(scanSql("SELECT 'a;b'; /* outer /* ; */ comment */ SELECT 2", 'PostgreSQL').statements.length, 2)
  assert.equal(scanSql("SELECT E'a\\';b'; SELECT 2", 'PostgreSQL').statements.length, 2)
  const plan = planPagination('WITH c AS (SELECT * FROM users LIMIT 3) SELECT * FROM c LIMIT 20 OFFSET 2')
  assert.equal(pageQuery(plan, 1, 10), 'WITH c AS (SELECT * FROM users LIMIT 3) SELECT * FROM c LIMIT 10 OFFSET 12')
})

test('USING suggests only shared unqualified columns', () =>
  assert.deepEqual(columns('SELECT * FROM users u JOIN orders o USING (|)'), ['id']))
test('USING omits names already entered', () =>
  assert.deepEqual(columns('SELECT * FROM users u JOIN orders o USING (id, |)'), []))
test('automatic completion after an expression comma', () =>
  assert.equal(complete('SELECT id, | FROM users').automatic, true))
test('automatic completion inside a function', () =>
  assert.equal(complete('SELECT COUNT(|) FROM users').automatic, true))
test('empty statement offers starter keywords', () =>
  assert.deepEqual(names('|', 'keyword'), ['EXPLAIN', 'SELECT', 'WITH']))
test('large catalogs retain both same-name schema choices', () => {
  const catalog = Array.from({ length: 10000 }, (_, i) => ({ schema: 'public', name: 'table_' + i, columns: [] }))
  catalog.push({ schema: 'archive', name: 'table_9999', columns: [] })
  assert.deepEqual(names('SELECT * FROM table_9999|', 'table', catalog), ['archive.table_9999', 'public.table_9999'])
})

test('JOIN ON cannot see a later join alias', () =>
  assert.deepEqual(columns('SELECT * FROM users u JOIN orders o ON e.| JOIN audit.events e ON true'), []))
test('qualified completion fetches only the requested relation', () => {
  const catalog = tables.map((t) => ({ ...t, columns: [], columnsLoaded: false }))
  assert.deepEqual(
    complete('SELECT u.| FROM users u JOIN orders o ON true', catalog).neededTables.map((t) => t.name),
    ['users'],
  )
})
test('SQLite comments stop at the first closing marker', () => {
  assert.ok(names('SELECT /* not /* nested */ cou|', 'function', tables, 'SQLite').includes('count'))
})
test('PostgreSQL array brackets do not swallow column completion', () => {
  assert.ok(columns('SELECT ARRAY[u.|] FROM users u').includes('email'))
})
test('default statement scanning retains its existing comment boundaries', () => {
  assert.equal(scanSql('/* a /* b */ SELECT 1; -- */\nSELECT 2').statements.length, 2)
})

test('physical table column aliases retain the remaining columns', () => {
  assert.deepEqual(columns('SELECT u.| FROM users u(user_id)'), ['created_at', 'email', 'name', 'user_id'])
})
test('column aliases on a physical table still request its metadata', () => {
  const catalog = tables.map((t) => ({ ...t, columns: [], columnsLoaded: false }))
  assert.deepEqual(
    complete('SELECT u.| FROM users u(user_id)', catalog).neededTables.map((t) => t.name),
    ['users'],
  )
})
test('table-valued functions do not request unrelated physical metadata', () => {
  const catalog = tables.map((t) => ({ ...t, columns: [], columnsLoaded: false }))
  const result = complete('SELECT u.| FROM users(1) AS u(value)', catalog)
  assert.deepEqual(result.neededTables, [])
  assert.deepEqual(
    result.options.filter((o) => o.kind === 'column').map((o) => o.label),
    ['value'],
  )
})
test('non-BMP identifier replacement keeps the entire word', () => {
  const catalog = [{ schema: '', name: 'users', columns: ['𐐀name'] }]
  const r = apply('SELECT 𐐀|wrong FROM users', '𐐀name', catalog)
  assert.equal(r.text, 'SELECT "𐐀name" FROM users')
})

const paginationCases = [
  ['SELECT 1', 'LIMIT'],
  ['SELECT * FROM "Fires"', 'LIMIT'],
  ['SELECT * FROM "Fires"', 'OFFSET'],
  ['SELECT * FROM "Fires"\nWHERE "CONT_DOY" > 80', 'LIMIT'],
  ['SELECT * FROM "Fires"\nWHERE "CONT_DOY" > 80', 'OFFSET'],
  ['SELECT * FROM users u JOIN orders o ON u.id = o.user_id', 'LIMIT'],
  ['SELECT name FROM users GROUP BY name', 'LIMIT'],
  ['SELECT name FROM users GROUP BY name HAVING COUNT(*) > 1', 'OFFSET'],
  ['SELECT * FROM users ORDER BY name DESC', 'LIMIT'],
  ['SELECT * FROM users ORDER BY name DESC', 'OFFSET'],
  ['SELECT * FROM "Fires"\nWHERE "CONT_DOY" > 80\nLIMIT 10', 'OFFSET'],
  ['SELECT * FROM "Fires"\nWHERE "CONT_DOY" > 80\nOFFSET 2', 'LIMIT'],
]
for (const driver of ['PostgreSQL', 'SQLite']) {
  for (const [query, keyword] of paginationCases) {
    test(driver + ' completes ' + keyword + ' after ' + query, () => {
      const prefix = keyword.slice(0, 2)
      assert.ok(names(query + '\n' + prefix + '|', 'keyword', tables, driver).includes(keyword))
      assert.ok(names(query + '\n|', 'keyword', tables, driver).includes(keyword))
    })
  }
}
test('pagination keywords preserve typed case and replace the entire word', () => {
  assert.equal(
    apply('SELECT * FROM "Fires"\nWHERE "CONT_DOY" > 80\nli|mt 10', 'limit').text,
    'SELECT * FROM "Fires"\nWHERE "CONT_DOY" > 80\nlimit 10',
  )
  assert.equal(
    apply('SELECT * FROM "Fires"\nLIMIT 10\nOF|FST 2', 'OFFSET').text,
    'SELECT * FROM "Fires"\nLIMIT 10\nOFFSET 2',
  )
})
test('both pagination clauses remain editable without suggesting duplicates elsewhere', () => {
  assert.ok(names('SELECT * FROM users OFFSET 2 LI|MIT 10', 'keyword').includes('LIMIT'))
  assert.ok(names('SELECT * FROM users LIMIT 10 OF|FSET 2', 'keyword').includes('OFFSET'))
  const keywords = names('SELECT * FROM users LIMIT 10 OFFSET 2 |', 'keyword')
  assert.ok(!keywords.includes('LIMIT') && !keywords.includes('OFFSET'))
})
test('inner pagination does not suppress outer pagination keywords', () => {
  assert.ok(names('SELECT * FROM (SELECT * FROM users LIMIT 1 OFFSET 2) u WHERE true LI|', 'keyword').includes('LIMIT'))
  assert.ok(
    names('WITH c AS (SELECT * FROM users LIMIT 1) SELECT * FROM c WHERE true OF|', 'keyword').includes('OFFSET'),
  )
})
test('outer pagination does not suppress an inner LIMIT', () => {
  assert.ok(names('SELECT * FROM (SELECT * FROM users WHERE true LI|) u LIMIT 10', 'keyword').includes('LIMIT'))
})
test('pagination keywords do not appear as qualified columns or inside literals', () => {
  assert.deepEqual(names('SELECT u.LI| FROM users u WHERE true', 'keyword'), [])
  assert.equal(complete("SELECT * FROM users WHERE name = 'LI|'"), null)
  assert.equal(complete('SELECT * FROM users -- OF|'), null)
})
test('CodeMirror automatic completion returns LIMIT and OFFSET for the reported query', async () => {
  const source = createSqlCompletionSource({ driver: () => 'PostgreSQL', tables: () => tables })
  for (const [suffix, label] of [
    ['LI', 'LIMIT'],
    ['OF', 'OFFSET'],
    ['OFFSET 2\nLI', 'LIMIT'],
    ['LIMIT 10\nOF', 'OFFSET'],
  ]) {
    const text = 'SELECT * FROM "Fires"\nWHERE "CONT_DOY" > 80\n' + suffix
    const result = await source(new CompletionContext(EditorState.create({ doc: text }), text.length, false))
    assert.ok(
      result?.options.some((option) => option.label === label),
      label + ' missing for ' + suffix,
    )
  }
})
