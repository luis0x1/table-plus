import type { AppConfig, AppearancePreferences, SidebarPreferences, ColumnInfo, ConnectionStatus, IndexInfo, PostgresConfig, QueryResult, RowOperation, SavedConnection, SavedConnectionUpdate, TableData, TableSummary } from './types'

type Backend = {
  LoadAppConfig(legacy: SidebarPreferences): Promise<AppConfig>
  SaveSidebarPreferences(preferences: SidebarPreferences): Promise<void>
  SaveAppearancePreferences(preferences: AppearancePreferences): Promise<void>
  ListDatabaseSessions(): Promise<ConnectionStatus[]>
  OpenPostgresSession(config: PostgresConfig): Promise<ConnectionStatus>
  OpenSavedSession(id: string, password: string): Promise<ConnectionStatus>
  ChooseSQLiteSession(): Promise<ConnectionStatus>
  OpenDemoSession(): Promise<ConnectionStatus>
  CloseDatabaseSession(id: string): Promise<void>
  ListDatabases(id: string): Promise<string[]>
  OpenDatabase(id: string, database: string): Promise<ConnectionStatus>
  SessionListTables(id: string): Promise<TableSummary[]>
  SessionCountTableRows(id: string, schema: string, table: string): Promise<number>
  SessionGetTableSchema(id: string, schema: string, table: string): Promise<ColumnInfo[]>
  SessionGetTableIndexes(id: string, schema: string, table: string): Promise<IndexInfo[]>
  SessionGetTableData(id: string, schema: string, table: string, limit: number, offset: number, filter: string, sortColumn: string, sortDirection: string): Promise<TableData>
  SessionExecuteQuery(id: string, query: string): Promise<QueryResult>
  SessionApplyChanges(id: string, schema: string, table: string, operations: RowOperation[]): Promise<number>
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
  UpdateCell(schema: string, table: string, column: string, value: unknown, primaryKey: Record<string, unknown>): Promise<void>
  ApplyChanges(schema: string, table: string, operations: RowOperation[]): Promise<number>
}

declare global {
  interface Window {
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
const defaultAppearance: AppearancePreferences = { fontSize: 17, fontFamily: 'system' }
function mockAppConfig(legacy: SidebarPreferences): AppConfig {
  const stored = localStorage.getItem('querynest:preview-config')
  if (!stored) return { version: 1, sidebars: legacy, appearance: defaultAppearance }
  const parsed = JSON.parse(stored) as Partial<AppConfig>
  return { version: 1, sidebars: parsed.sidebars ?? legacy, appearance: { ...defaultAppearance, ...parsed.appearance } }
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
  async ListDatabaseSessions() { return [...mockSessions] },
  async OpenPostgresSession(config) { return addMockSession(await this.ConnectPostgres(config)) },
  async OpenSavedSession(id, password) { return addMockSession(await this.ConnectSavedConnection(id, password)) },
  async ChooseSQLiteSession() { return addMockSession(await this.ChooseSQLiteFile()) },
  async OpenDemoSession() { return addMockSession(await this.ConnectDemo()) },
  async CloseDatabaseSession(id) { mockSession(id); mockSessions = mockSessions.filter(item => item.id !== id) },
  async ListDatabases(id) { const session = mockSession(id); return session.driver === 'PostgreSQL' ? [...new Set([session.database, 'analytics', 'inventory', 'postgres'])] : [session.database] },
  async OpenDatabase(id, database) { const session = mockSession(id); return addMockSession({ ...session, database, path: session.path.slice(0, session.path.lastIndexOf('/') + 1) + database }) },
  async SessionListTables(id) { mockSession(id); return this.ListTables() },
  async SessionCountTableRows(id, schema, table) { mockSession(id); return this.CountTableRows(schema, table) },
  async SessionGetTableSchema(id, schema, table) { mockSession(id); return this.GetTableSchema(schema, table) },
  async SessionGetTableIndexes(id, schema, table) { mockSession(id); return this.GetTableIndexes(schema, table) },
  async SessionGetTableData(id, ...args) { mockSession(id); return this.GetTableData(...args) },
  async SessionExecuteQuery(id, query) { mockSession(id); return this.ExecuteQuery(query) },
  async SessionApplyChanges(id, schema, table, operations) { mockSession(id); return this.ApplyChanges(schema, table, operations) },
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
  async ExecuteQuery() { return { columns: ['status', 'count'], rows: [['active', 5], ['invited', 2], ['suspended', 1]], rowsAffected: 3, durationMs: 7, message: 'Returned 3 row(s)' } },
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
    ExecuteQuery: (query: string) => backend.SessionExecuteQuery(id, query),
    ApplyChanges: (schema: string, table: string, operations: RowOperation[]) => backend.SessionApplyChanges(id, schema, table, operations),
  }
}

export const isDesktop = () => Boolean(window.go?.main?.App)

export function windowAction(action: 'minimise' | 'maximise' | 'close') {
  if (!window.runtime) return
  if (action === 'minimise') window.runtime.WindowMinimise()
  if (action === 'maximise') window.runtime.WindowToggleMaximise()
  if (action === 'close') window.runtime.Quit()
}
