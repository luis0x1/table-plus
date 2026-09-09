export interface ConnectionStatus {
  id: string
  database: string
  connected: boolean
  name: string
  path: string
  driver: string
  readOnly: boolean
}

export interface TableSummary {
  schema: string
  name: string
  type: 'table' | 'view'
  rows: number
}

export interface TableRef {
  schema: string
  name: string
}

export interface TransferTablePreview {
  schema: string
  name: string
  columns: string[]
  targetColumns: string[]
  missingColumns: string[]
  extraColumns: string[]
  requiredMissing: string[]
  sampleRows: unknown[][]
  rows: number
}

export interface TransferSkippedTable {
  schema: string
  name: string
  reason: string
}

export interface TransferPreview {
  kind: 'backup' | 'restore' | 'export' | 'import'
  path: string
  format: string
  driver: string
  database: string
  tables: TransferTablePreview[]
  skipped?: TransferSkippedTable[]
}

export interface TransferResult {
  path: string
  tables: number
  rows: number
  skipped: number
}

export interface PostgresConfig {
  id: string
  name: string
  host: string
  port: number
  user: string
  password: string
  database: string
  sslMode: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'
  readOnly: boolean
  saveConnection: boolean
  savePassword: boolean
}

export interface SavedConnection {
  id: string
  name: string
  driver: string
  path?: string
  host?: string
  port?: number
  user?: string
  database?: string
  sslMode?: string
  readOnly: boolean
  hasPassword: boolean
}

export interface SavedConnectionUpdate {
  id: string
  name: string
  driver: string
  path?: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  sslMode?: string
  readOnly: boolean
  savePassword: boolean
}

export interface RowOperation {
  type: 'insert' | 'update' | 'delete' | 'truncate'
  values: Record<string, unknown>
  primaryKey: Record<string, unknown>
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  default: unknown
}

export interface IndexInfo {
  name: string
  type: string
  columns: string[]
  unique: boolean
  primary: boolean
  partial: boolean
}

export interface TableData {
  columns: string[]
  rows: unknown[][]
  total: number
  durationMs: number
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowsAffected: number
  durationMs: number
  message: string
}

export interface SidebarPreferences {
  databases: number
  tables: number
}

export type FontFamily = 'system' | 'humanist' | 'serif' | 'mono'

export interface AppearancePreferences {
  fontSize: number
  fontFamily: FontFamily
}

export interface TransferPreferences {
  backupBatchSizeMB: number
}

export interface EditingPreferences {
  undoHistoryLimit: number
}

export interface AppConfig {
  version: number
  sidebars: SidebarPreferences
  appearance: AppearancePreferences
  transfer: TransferPreferences
  editing: EditingPreferences
}
