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

export interface AppConfig {
  version: number
  sidebars: SidebarPreferences
  appearance: AppearancePreferences
}
