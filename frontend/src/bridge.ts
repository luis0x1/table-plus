import type { ColumnInfo, ConnectionStatus, PostgresConfig, QueryResult, RowOperation, SavedConnection, TableData, TableSummary } from './types'

type Backend = {
  GetStatus(): Promise<ConnectionStatus>
  ChooseSQLiteFile(): Promise<ConnectionStatus>
  ConnectSQLite(path: string): Promise<ConnectionStatus>
  ConnectPostgres(config: PostgresConfig): Promise<ConnectionStatus>
  ConnectDemo(): Promise<ConnectionStatus>
  ListSavedConnections(): Promise<SavedConnection[]>
  ConnectSavedConnection(id: string, password: string): Promise<ConnectionStatus>
  DeleteSavedConnection(id: string): Promise<void>
  Disconnect(): Promise<void>
  ListTables(): Promise<TableSummary[]>
  GetTableSchema(schema: string, table: string): Promise<ColumnInfo[]>
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
const mock: Backend = {
  async GetStatus() { return { connected: mockConnected, name: mockConnected ? 'querynest-demo' : '', path: mockConnected ? '~/querynest-demo.db' : '', driver: 'SQLite', readOnly: false } },
  async ChooseSQLiteFile() { mockConnected = true; return this.GetStatus() },
  async ConnectSQLite() { mockConnected = true; return this.GetStatus() },
  async ConnectPostgres(config) { mockConnected = true; return { connected: true, name: config.name || config.database, path: `${config.host}:${config.port}/${config.database}`, driver: 'PostgreSQL', readOnly: config.readOnly } },
  async ConnectDemo() { mockConnected = true; return this.GetStatus() },
  async ListSavedConnections() { return [] },
  async ConnectSavedConnection() { mockConnected = true; return this.GetStatus() },
  async DeleteSavedConnection() {},
  async Disconnect() { mockConnected = false },
  async ListTables() { return [{ schema: 'public', name: 'customers', type: 'table', rows: 8 }, { schema: 'public', name: 'orders', type: 'table', rows: 5 }, { schema: 'public', name: 'active_customers', type: 'view', rows: 5 }] },
  async GetTableSchema(_schema, table) {
    const columns = table === 'orders'
      ? [['id', 'INTEGER'], ['customer_id', 'INTEGER'], ['total', 'REAL'], ['currency', 'TEXT'], ['status', 'TEXT'], ['ordered_at', 'TEXT']]
      : [['id', 'INTEGER'], ['name', 'TEXT'], ['email', 'TEXT'], ['company', 'TEXT'], ['status', 'TEXT'], ['created_at', 'TEXT']]
    return columns.map(([name, type], index) => ({ name, type, nullable: index > 0, primaryKey: index === 0, default: null }))
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

export const isDesktop = () => Boolean(window.go?.main?.App)

export function windowAction(action: 'minimise' | 'maximise' | 'close') {
  if (!window.runtime) return
  if (action === 'minimise') window.runtime.WindowMinimise()
  if (action === 'maximise') window.runtime.WindowToggleMaximise()
  if (action === 'close') window.runtime.Quit()
}
