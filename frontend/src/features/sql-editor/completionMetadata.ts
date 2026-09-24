import type { ColumnInfo, TableRef } from '../../types'

/** Per-workspace cache, including empty/failed results and in-flight requests. */
export function createCompletionMetadataCache(
  fetchColumns: (table: TableRef) => Promise<ColumnInfo[]>,
  changed: () => void,
) {
  type Entry = { columns?: ColumnInfo[]; pending?: Promise<void> }
  const entries = new Map<string, Entry>()
  const key = (table: TableRef) => JSON.stringify([table.schema, table.name])
  return {
    get(table: TableRef) {
      return entries.get(key(table))?.columns
    },
    load(table: TableRef): Promise<void> {
      const id = key(table)
      const cached = entries.get(id)
      if (cached) return cached.pending ?? Promise.resolve()
      const entry: Entry = {}
      entries.set(id, entry)
      entry.pending = Promise.resolve()
        .then(() => fetchColumns(table))
        .catch(() => [])
        .then((columns) => {
          // An explicit refresh may have replaced this request while it ran.
          if (entries.get(id) !== entry) return
          entry.columns = columns ?? []
          entry.pending = undefined
          changed()
        })
      return entry.pending
    },
    clear() {
      entries.clear()
      changed()
    },
  }
}
