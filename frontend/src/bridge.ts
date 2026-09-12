import type { AppConfig, AppearancePreferences, EditingPreferences, ScriptFile, SidebarPreferences, ColumnInfo, ConnectionStatus, IndexInfo, PostgresConfig, QueryResult, RowOperation, SavedConnection, SavedConnectionUpdate, TableData, TableRef, TableSummary, TransferPreferences, TransferPreview, TransferResult } from './types'

type Backend = {
  LoadAppConfig(legacy: SidebarPreferences): Promise<AppConfig>
  SaveSidebarPreferences(preferences: SidebarPreferences): Promise<void>
  SaveAppearancePreferences(preferences: AppearancePreferences): Promise<void>
  SaveTransferPreferences(preferences: TransferPreferences): Promise<void>
  SaveEditingPreferences(preferences: EditingPreferences): Promise<void>
  ListSystemFonts(): Promise<string[]>
  ListDatabaseSessions(): Promise<ConnectionStatus[]>
  OpenPostgresSession(config: PostgresConfig): Promise<ConnectionStatus>
  OpenSavedSession(id: string, password: string): Promise<ConnectionStatus>
  ChooseSQLiteSession(): Promise<ConnectionStatus>
  OpenDemoSession(): Promise<ConnectionStatus>
  CloseDatabaseSession(id: string): Promise<void>
  ListDatabases(id: string): Promise<string[]>
  CreateDatabase(id: string, name: string): Promise<void>
  OpenDatabase(id: string, database: string): Promise<ConnectionStatus>
  SessionListTables(id: string): Promise<TableSummary[]>
  SessionCountTableRows(id: string, schema: string, table: string): Promise<number>
  SessionGetTableSchema(id: string, schema: string, table: string): Promise<ColumnInfo[]>
  SessionGetTableIndexes(id: string, schema: string, table: string): Promise<IndexInfo[]>
  SessionGetTableData(id: string, schema: string, table: string, limit: number, offset: number, filter: string, sortColumn: string, sortDirection: string): Promise<TableData>
  SessionExecuteQuery(id: string, query: string): Promise<QueryResult>
  SessionExecuteQueryTracked(id: string, operationID: string, query: string): Promise<QueryResult>
  SessionExecuteScriptStatement(id: string, query: string): Promise<QueryResult>
  SessionExecuteScriptStatementTracked(id: string, operationID: string, query: string): Promise<QueryResult>
  SessionCancelOperation(id: string, operationID: string): Promise<boolean>
  SessionApplyChanges(id: string, schema: string, table: string, operations: RowOperation[]): Promise<number>
  SessionApplyChangesTracked(id: string, operationID: string, schema: string, table: string, operations: RowOperation[]): Promise<number>
  SessionPreviewDatabaseBackup(id: string): Promise<TransferPreview>
  SessionBackupDatabase(id: string, batchSizeMB: number): Promise<TransferResult>
  SessionChooseRestoreBackup(id: string): Promise<TransferPreview>
  SessionRestoreDatabase(id: string, path: string): Promise<TransferResult>
  SessionPreviewTableExport(id: string, tables: TableRef[]): Promise<TransferPreview>
  SessionExportTables(id: string, tables: TableRef[], format: string): Promise<TransferResult>
  SessionChooseTableImport(id: string, table: TableRef): Promise<TransferPreview>
  SessionImportTable(id: string, table: TableRef, path: string, conflict: string): Promise<TransferResult>
  SessionTruncateTables(id: string, tables: TableRef[]): Promise<number>
  SessionTruncateTablesTracked(id: string, operationID: string, tables: TableRef[]): Promise<number>
  SessionScriptWorkspacePath(id: string): Promise<string>
  SessionListScripts(id: string): Promise<ScriptFile[]>
  SessionReadScript(id: string, name: string): Promise<string>
  SessionCreateScript(id: string, name: string): Promise<ScriptFile>
  SessionSaveScript(id: string, name: string, content: string): Promise<ScriptFile>
  SessionRenameScript(id: string, from: string, to: string): Promise<ScriptFile>
  SessionDeleteScript(id: string, name: string): Promise<void>
  GetStatus(): Promise<ConnectionStatus>
  ChooseSQLiteFile(): Promise<ConnectionStatus>
  ConnectSQLite(path: string): Promise<ConnectionStatus>
  ConnectPostgres(config: PostgresConfig): Promise<ConnectionStatus>
  TestPostgresConnection(config: PostgresConfig): Promise<void>
  ConnectDemo(): Promise<ConnectionStatus>
  ListSavedConnections(): Promise<SavedConnection[]>
  ConnectSavedConnection(id: string, password: string): Promise<ConnectionStatus>
  UpdateSavedConnection(profile: SavedConnectionUpdate): Promise<void>
  DeleteSavedConnection(id: string): Promise<void>
  Disconnect(): Promise<void>
  ListTables(): Promise<TableSummary[]>
  CountTableRows(schema: string, table: string): Promise<number>
  GetTableSchema(schema: string, table: string): Promise<ColumnInfo[]>
  GetTableIndexes(schema: string, table: string): Promise<IndexInfo[]>
  GetTableData(schema: string, table: string, limit: number, offset: number, filter: string, sortColumn: string, sortDirection: string): Promise<TableData>
  ExecuteQuery(query: string): Promise<QueryResult>
  ExecuteScriptStatement(query: string): Promise<QueryResult>
  UpdateCell(schema: string, table: string, column: string, value: unknown, primaryKey: Record<string, unknown>): Promise<void>
  ApplyChanges(schema: string, table: string, operations: RowOperation[]): Promise<number>
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<Array<{ family: string; fullName: string; postscriptName: string; style: string }>>
    go?: { main?: { App?: Backend } }
    runtime?: {
      WindowMinimise(): void
      WindowToggleMaximise(): void
      Quit(): void
    }
  }
}

const demoRows = [
  [1, 'Olivia Martin', 'olivia@northstar.io', 'Northstar Labs', 'active', '2026-08-29 09:42:11'],
  [2, 'Jackson Lee', 'jackson@sisyphus.co', 'Sisyphus', 'active', '2026-08-28 16:18:03'],
  [3, 'Sophia Brown', 'sophia@catalog.com', 'Catalog', 'invited', '2026-08-26 11:03:45'],
  [4, 'Noah Williams', 'noah@circooles.com', 'Circooles', 'active', '2026-08-24 14:25:37'],
  [5, 'Emma Davis', 'emma@quotient.com', 'Quotient', 'suspended', '2026-08-21 08:56:22'],
  [6, 'Liam Wilson', 'liam@layers.to', 'Layers', 'active', '2026-08-19 18:32:09'],
  [7, 'Ava Taylor', 'ava@commandr.com', 'Command R', 'invited', '2026-08-17 10:12:56'],
  [8, 'Ethan Moore', 'ethan@hourglass.io', 'Hourglass', 'active', '2026-08-14 13:47:28'],
]

let mockConnected = false
let mockSessions: ConnectionStatus[] = []
const mockCreatedDatabases = new Set<string>()
const mockOperations = new Map<string, AbortController>()
const defaultAppearance: AppearancePreferences = { fontSize: 17, fontFamily: 'system' }
const defaultTransfer: TransferPreferences = { backupBatchSizeMB: 500 }
const defaultEditing: EditingPreferences = { undoHistoryLimit: 100, caretWidth: 2, editorFontSize: 12, editorFontFamily: 'mono' }
function mockAppConfig(legacy: SidebarPreferences): AppConfig {
  const stored = localStorage.getItem('querynest:preview-config')
  if (!stored) return { version: 1, sidebars: legacy, appearance: defaultAppearance, transfer: defaultTransfer, editing: defaultEditing }
  const parsed = JSON.parse(stored) as Partial<AppConfig>
  return { version: 1, sidebars: parsed.sidebars ?? legacy, appearance: { ...defaultAppearance, ...parsed.appearance }, transfer: { ...defaultTransfer, ...parsed.transfer }, editing: { ...defaultEditing, ...parsed.editing } }
}
function saveMockConfig(config: AppConfig) {
  localStorage.setItem('querynest:preview-config', JSON.stringify(config))
}
function addMockSession(status: ConnectionStatus) {
  const existing = mockSessions.find(item => item.driver === status.driver && item.path === status.path && item.readOnly === status.readOnly)
  if (existing) return existing
  const next = { ...status, id: crypto.randomUUID() }
  mockSessions = [...mockSessions, next]
  return next
}
function mockSession(id: string) {
  const session = mockSessions.find(item => item.id === id)
  if (!session) throw new Error('Database session is closed.')
  return session
}
async function mockTracked<T>(operationID: string, run: () => Promise<T>): Promise<T> {
  const controller = new AbortController()
  mockOperations.set(operationID, controller)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 350)
      controller.signal.addEventListener('abort', () => {
        window.clearTimeout(timer)
        reject(new Error('operation cancelled'))
      }, { once: true })
    })
    return await run()
  } finally {
    mockOperations.delete(operationID)
  }
}
// The browser preview keeps scripts in localStorage so the pane can be built
// and reviewed without the desktop file system.
const previewScriptsKey = 'querynest:preview-scripts'
function previewScripts(): Record<string, { content: string; modified: string }> {
  try { return JSON.parse(localStorage.getItem(previewScriptsKey) ?? '{}') } catch { return {} }
}
function savePreviewScripts(scripts: Record<string, { content: string; modified: string }>) {
  localStorage.setItem(previewScriptsKey, JSON.stringify(scripts))
}
function previewScriptName(name: string) {
  const base = name.trim().replace(/\.sql$/i, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(base)) throw new Error(`"${name}" is not a valid script name`)
  return `${base}.sql`
}
function previewScriptFile(name: string, entry: { content: string; modified: string }): ScriptFile {
  return { name, size: new TextEncoder().encode(entry.content).length, modified: entry.modified }
}

const mock: Backend = {
  async LoadAppConfig(legacy) {
    const config = mockAppConfig(legacy)
    saveMockConfig(config)
    return config
  },
  async SaveSidebarPreferences(preferences) {
    saveMockConfig({ ...mockAppConfig(preferences), sidebars: preferences })
  },
  async SaveAppearancePreferences(preferences) {
    saveMockConfig({ ...mockAppConfig({ databases: 1, tables: 1 }), appearance: preferences })
  },
  async SaveTransferPreferences(preferences) {
    saveMockConfig({ ...mockAppConfig({ databases: 1, tables: 1 }), transfer: preferences })
  },
  async SaveEditingPreferences(preferences) {
    saveMockConfig({ ...mockAppConfig({ databases: 1, tables: 1 }), editing: preferences })
  },
  async ListSystemFonts() { return ['Arial', 'Georgia', 'Inter', 'Times New Roman', 'Trebuchet MS', 'Verdana'] },
  async ListDatabaseSessions() { return [...mockSessions] },
  async OpenPostgresSession(config) { return addMockSession(await this.ConnectPostgres(config)) },
  async OpenSavedSession(id, password) { return addMockSession(await this.ConnectSavedConnection(id, password)) },
  async ChooseSQLiteSession() { return addMockSession(await this.ChooseSQLiteFile()) },
  async OpenDemoSession() { return addMockSession(await this.ConnectDemo()) },
  async CloseDatabaseSession(id) { mockSession(id); mockSessions = mockSessions.filter(item => item.id !== id) },
  async ListDatabases(id) { const session = mockSession(id); return session.driver === 'PostgreSQL' ? [...new Set([session.database, 'analytics', 'inventory', 'postgres', ...mockCreatedDatabases])].sort() : [session.database] },
  async CreateDatabase(id, name) {
    const session = mockSession(id)
    const normalized = name.trim()
    if (session.driver !== 'PostgreSQL') throw new Error('SQLite databases are files.')
    if (session.readOnly) throw new Error('This connection is read-only.')
    if (!normalized) throw new Error('Database name is required.')
    if (mockCreatedDatabases.has(normalized)) throw new Error(`Database ${normalized} already exists.`)
    mockCreatedDatabases.add(normalized)
  },
  async OpenDatabase(id, database) { const session = mockSession(id); return addMockSession({ ...session, database, path: session.path.slice(0, session.path.lastIndexOf('/') + 1) + database }) },
  async SessionListTables(id) { mockSession(id); return this.ListTables() },
  async SessionCountTableRows(id, schema, table) { mockSession(id); return this.CountTableRows(schema, table) },
  async SessionGetTableSchema(id, schema, table) { mockSession(id); return this.GetTableSchema(schema, table) },
  async SessionGetTableIndexes(id, schema, table) { mockSession(id); return this.GetTableIndexes(schema, table) },
  async SessionGetTableData(id, ...args) { mockSession(id); return this.GetTableData(...args) },
  async SessionExecuteQuery(id, query) { mockSession(id); return this.ExecuteQuery(query) },
  async SessionExecuteQueryTracked(id, operationID, query) { mockSession(id); return mockTracked(operationID, () => this.ExecuteQuery(query)) },
  async SessionExecuteScriptStatement(id, query) { mockSession(id); return this.ExecuteScriptStatement(query) },
  async SessionExecuteScriptStatementTracked(id, operationID, query) { mockSession(id); return mockTracked(operationID, () => this.ExecuteScriptStatement(query)) },
  async SessionCancelOperation(id, operationID) { mockSession(id); const operation = mockOperations.get(operationID); operation?.abort(); return Boolean(operation) },
  async SessionApplyChanges(id, schema, table, operations) { mockSession(id); return this.ApplyChanges(schema, table, operations) },
  async SessionApplyChangesTracked(id, operationID, schema, table, operations) { mockSession(id); return mockTracked(operationID, () => this.ApplyChanges(schema, table, operations)) },
  async SessionPreviewDatabaseBackup(id) { const session = mockSession(id); const tables = await this.ListTables(); return { kind: 'backup', path: '', format: '', driver: session.driver, database: session.database, tables: await Promise.all(tables.filter(table => table.type === 'table').map(async table => { const data = await this.GetTableData(table.schema, table.name, 5, 0, '', '', ''); return { schema: table.schema, name: table.name, columns: data.columns, targetColumns: [], missingColumns: [], extraColumns: [], requiredMissing: [], sampleRows: data.rows, rows: data.total } })) } },
  async SessionBackupDatabase() { return { path: 'preview.qnb', tables: 2, rows: 13, skipped: 0 } },
  async SessionChooseRestoreBackup() { throw new Error('File selection is available in the desktop app.') },
  async SessionRestoreDatabase(_id, path) { return path.toLowerCase().endsWith('.sql') ? { path, tables: 2, rows: 13, skipped: 0, statements: 8 } : { path: 'preview.qnb', tables: 2, rows: 13, skipped: 0 } },
  async SessionPreviewTableExport(id, tables) { const session = mockSession(id); return { kind: 'export', path: '', format: '', driver: session.driver, database: session.database, tables: await Promise.all(tables.map(async table => { const data = await this.GetTableData(table.schema, table.name, 5, 0, '', '', ''); return { schema: table.schema, name: table.name, columns: data.columns, targetColumns: [], missingColumns: [], extraColumns: [], requiredMissing: [], sampleRows: data.rows, rows: data.total } })) } },
  async SessionExportTables(_id, tables) { return { path: 'preview.json', tables: tables.length, rows: 0, skipped: 0 } },
  async SessionChooseTableImport() { throw new Error('File selection is available in the desktop app.') },
  async SessionImportTable() { return { path: 'preview.csv', tables: 1, rows: 0, skipped: 0 } },
  async SessionTruncateTables(_id, tables) { return tables.length },
  async SessionTruncateTablesTracked(id, operationID, tables) { mockSession(id); return mockTracked(operationID, () => this.SessionTruncateTables(id, tables)) },
  async SessionScriptWorkspacePath(id) { mockSession(id); return '~/Library/Application Support/QueryNest/projects/preview' },
  async SessionListScripts(id) {
    mockSession(id)
    const scripts = previewScripts()
    return Object.keys(scripts).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map(name => previewScriptFile(name, scripts[name]))
  },
  async SessionReadScript(id, name) {
    mockSession(id)
    const entry = previewScripts()[previewScriptName(name)]
    if (!entry) throw new Error(`open script ${name}: no such file`)
    return entry.content
  },
  async SessionCreateScript(id, name) {
    mockSession(id)
    const scripts = previewScripts()
    const key = previewScriptName(name)
    if (scripts[key]) throw new Error(`a script named ${key} already exists`)
    scripts[key] = { content: '', modified: new Date().toISOString() }
    savePreviewScripts(scripts)
    return previewScriptFile(key, scripts[key])
  },
  async SessionSaveScript(id, name, content) {
    mockSession(id)
    const scripts = previewScripts()
    const key = previewScriptName(name)
    scripts[key] = { content, modified: new Date().toISOString() }
    savePreviewScripts(scripts)
    return previewScriptFile(key, scripts[key])
  },
  async SessionRenameScript(id, from, to) {
    mockSession(id)
    const scripts = previewScripts()
    const source = previewScriptName(from)
    const target = previewScriptName(to)
    if (source !== target && scripts[target]) throw new Error(`a script named ${target} already exists`)
    if (source !== target) { scripts[target] = scripts[source]; delete scripts[source] }
    savePreviewScripts(scripts)
    return previewScriptFile(target, scripts[target])
  },
  async SessionDeleteScript(id, name) {
    mockSession(id)
    const scripts = previewScripts()
    delete scripts[previewScriptName(name)]
    savePreviewScripts(scripts)
  },
  async GetStatus() { return { id: '', database: mockConnected ? 'querynest-demo' : '', connected: mockConnected, name: mockConnected ? 'querynest-demo' : '', path: mockConnected ? '~/querynest-demo.db' : '', driver: 'SQLite', readOnly: false } },
  async ChooseSQLiteFile() { mockConnected = true; return this.GetStatus() },
  async ConnectSQLite() { mockConnected = true; return this.GetStatus() },
  async ConnectPostgres(config) { mockConnected = true; return { id: '', database: config.database, connected: true, name: config.name || config.database, path: `${config.host}:${config.port}/${config.database}`, driver: 'PostgreSQL', readOnly: config.readOnly } },
  async TestPostgresConnection() { throw new Error('Connection testing is available in the desktop app.') },
  async ConnectDemo() { mockConnected = true; return this.GetStatus() },
  async ListSavedConnections() { return [] },
  async ConnectSavedConnection() { mockConnected = true; return this.GetStatus() },
  async UpdateSavedConnection() {},
  async DeleteSavedConnection() {},
  async Disconnect() { mockConnected = false },
  async ListTables() { return [{ schema: 'public', name: 'customers', type: 'table', rows: -1 }, { schema: 'public', name: 'orders', type: 'table', rows: -1 }, { schema: 'public', name: 'active_customers', type: 'view', rows: -1 }] },
  async CountTableRows(_schema, table) { return table === 'customers' ? 8 : 5 },
  async GetTableSchema(_schema, table) {
    const columns = table === 'orders'
      ? [['id', 'INTEGER'], ['customer_id', 'INTEGER'], ['total', 'REAL'], ['currency', 'TEXT'], ['status', 'TEXT'], ['ordered_at', 'TEXT']]
      : [['id', 'INTEGER'], ['name', 'TEXT'], ['email', 'TEXT'], ['company', 'TEXT'], ['status', 'TEXT'], ['created_at', 'TEXT']]
    return columns.map(([name, type], index) => ({ name, type, nullable: index > 0, primaryKey: index === 0, default: null }))
  },
  async GetTableIndexes(_schema, table) {
    return table === 'orders'
      ? [{ name: 'orders_customer_id_idx', type: 'btree', columns: ['customer_id'], unique: false, primary: false, partial: false }, { name: 'orders_pkey', type: 'btree', columns: ['id'], unique: true, primary: true, partial: false }]
      : [{ name: 'customers_email_key', type: 'btree', columns: ['email'], unique: true, primary: false, partial: false }, { name: 'customers_pkey', type: 'btree', columns: ['id'], unique: true, primary: true, partial: false }]
  },
  async GetTableData(_schema, table, limit, offset, filter, sortColumn, sortDirection) {
    let rows = table === 'orders'
      ? [[1001, 1, 249, 'USD', 'paid', '2026-09-01 10:20:00'], [1002, 2, 89.5, 'USD', 'pending', '2026-09-01 12:05:00'], [1003, 1, 510, 'USD', 'paid', '2026-09-02 08:41:00'], [1004, 4, 120, 'EUR', 'refunded', '2026-09-02 14:12:00'], [1005, 6, 75.25, 'USD', 'paid', '2026-09-03 09:06:00']]
      : demoRows
    const columns = table === 'orders' ? ['id', 'customer_id', 'total', 'currency', 'status', 'ordered_at'] : ['id', 'name', 'email', 'company', 'status', 'created_at']
    if (filter) rows = rows.filter(row => row.some(value => String(value).toLowerCase().includes(filter.toLowerCase())))
    if (sortColumn) {
      const i = columns.indexOf(sortColumn)
      rows = [...rows].sort((a, b) => String(a[i]).localeCompare(String(b[i])))
      if (sortDirection === 'desc') rows.reverse()
    }
    return { columns, rows: rows.slice(offset, offset + limit), total: rows.length, durationMs: 4 }
  },
  async ExecuteQuery(query) {
    // The preview honours LIMIT and OFFSET over a synthetic result so paging
    // behaves the way it does against a real database.
    const total = 1234
    // The desktop backend caps one read at 1000 rows; the preview matches it.
    const limit = Math.min(1000, Number(/\blimit\s+(\d+)/i.exec(query)?.[1] ?? total))
    const offset = Number(/\boffset\s+(\d+)/i.exec(query)?.[1] ?? 0)
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => {
      const n = offset + index + 1
      return [`row-${n}`, n]
    })
    return { columns: ['label', 'n'], rows, rowsAffected: rows.length, durationMs: 7, message: `Returned ${rows.length} row(s)` }
  },
  async ExecuteScriptStatement(query) {
    if (/^\s*(?:select|with|explain|show|values|table|pragma)\b/i.test(query) || /\breturning\b/i.test(query)) return this.ExecuteQuery(query)
    const affected = /^\s*(?:insert|update|delete|merge|replace)\b/i.test(query) ? 1 : 0
    return { columns: [], rows: [], rowsAffected: affected, durationMs: 3, message: affected ? `Affected ${affected} row(s)` : 'Statement executed' }
  },
  async UpdateCell() {},
  async ApplyChanges(_schema, _table, operations) { return operations.length },
}

export function api(): Backend {
  return window.go?.main?.App ?? mock
}

export function databaseApi(id: string) {
  const backend = api()
  return {
    ListTables: () => backend.SessionListTables(id),
    CountTableRows: (schema: string, table: string) => backend.SessionCountTableRows(id, schema, table),
    GetTableSchema: (schema: string, table: string) => backend.SessionGetTableSchema(id, schema, table),
    GetTableIndexes: (schema: string, table: string) => backend.SessionGetTableIndexes(id, schema, table),
    GetTableData: (schema: string, table: string, limit: number, offset: number, filter: string, sortColumn: string, sortDirection: string) => backend.SessionGetTableData(id, schema, table, limit, offset, filter, sortColumn, sortDirection),
    ExecuteQuery: (operationID: string, query: string) => backend.SessionExecuteQueryTracked(id, operationID, query),
    ExecuteScriptStatement: (operationID: string, query: string) => backend.SessionExecuteScriptStatementTracked(id, operationID, query),
    CancelOperation: (operationID: string) => backend.SessionCancelOperation(id, operationID),
    ApplyChanges: (operationID: string, schema: string, table: string, operations: RowOperation[]) => backend.SessionApplyChangesTracked(id, operationID, schema, table, operations),
    PreviewDatabaseBackup: () => backend.SessionPreviewDatabaseBackup(id),
    BackupDatabase: (batchSizeMB: number) => backend.SessionBackupDatabase(id, batchSizeMB),
    ChooseRestoreBackup: () => backend.SessionChooseRestoreBackup(id),
    RestoreDatabase: (path: string) => backend.SessionRestoreDatabase(id, path),
    PreviewTableExport: (tables: TableRef[]) => backend.SessionPreviewTableExport(id, tables),
    ExportTables: (tables: TableRef[], format: string) => backend.SessionExportTables(id, tables, format),
    ChooseTableImport: (table: TableRef) => backend.SessionChooseTableImport(id, table),
    ImportTable: (table: TableRef, path: string, conflict: string) => backend.SessionImportTable(id, table, path, conflict),
    TruncateTables: (operationID: string, tables: TableRef[]) => backend.SessionTruncateTablesTracked(id, operationID, tables),
    ScriptWorkspacePath: () => backend.SessionScriptWorkspacePath(id),
    ListScripts: () => backend.SessionListScripts(id),
    ReadScript: (name: string) => backend.SessionReadScript(id, name),
    CreateScript: (name: string) => backend.SessionCreateScript(id, name),
    SaveScript: (name: string, content: string) => backend.SessionSaveScript(id, name, content),
    RenameScript: (from: string, to: string) => backend.SessionRenameScript(id, from, to),
    DeleteScript: (name: string) => backend.SessionDeleteScript(id, name),
  }
}

export const isDesktop = () => Boolean(window.go?.main?.App)

export function windowAction(action: 'minimise' | 'maximise' | 'close') {
  if (!window.runtime) return
  if (action === 'minimise') window.runtime.WindowMinimise()
  if (action === 'maximise') window.runtime.WindowToggleMaximise()
  if (action === 'close') window.runtime.Quit()
}
