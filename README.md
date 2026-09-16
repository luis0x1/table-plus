# QueryNest

QueryNest is a focused desktop database client inspired by the workflow of TablePlus. It is built with Go, Wails v2, SolidJS, and TypeScript and currently supports SQLite and PostgreSQL.

## Features

### Connections and workspaces

- Open local `.db`, `.sqlite`, and `.sqlite3` databases or launch the seeded demo database.
- Connect to PostgreSQL with host, port, database, SSL options, TLS certificates, and optional read-only mode.
- Save SQLite and PostgreSQL connection profiles between launches.
- Keep PostgreSQL passwords out of profile JSON by using the operating system's secure secret storage.
- Keep multiple databases open as independent workspaces and switch between them without losing table, script, or UI state.
- Browse PostgreSQL databases from an existing server connection and open them as separate sessions.
- Cancel running database operations from the application activity UI.

### Browsing and editing data

- Browse schemas, tables, and views with row counts.
- Inspect columns, types, nullability, defaults, primary keys, and indexes.
- Search visible columns, sort results, and paginate table data.
- Keep multiple tables open in tabs while preserving each tab's rows, filter, page, sorting, selection, schema, indexes, and drafts.
- Resize and reorder data columns; layouts are remembered per database table.
- Window large query result sets to keep rendering responsive.
- Double-click cells to edit rows through validated primary-key predicates.
- Insert and delete rows, truncate tables, and stage mutations locally before touching the database.
- Preview and edit JSON values with formatting and validation.
- Highlight staged updates in yellow, inserts in green, and deletes/truncates in red.
- Undo and redo local grid edits with a configurable history limit.
- Save the active table's complete draft atomically with `Ctrl+S`.
- Warn before an action can hide or discard unsaved table changes.

### SQL scripts and query editor

- Run a single `SELECT` from the scratch SQL console; QueryNest enforces the read-only boundary even when the underlying connection is editable.
- Use saved script tabs for statement-aware SQL execution. Editable connections can run write and DDL statements, while read-only connections restrict script execution to the same single-`SELECT` path as the scratch console.
- Use SQL syntax highlighting, statement-aware scope highlighting, CodeMirror completion, and search.
- Resolve statement boundaries across strings, comments, dollar-quoted PostgreSQL bodies, and trigger blocks.
- Run the statement under the caret or the statements covered by the current selection.
- Page eligible query results without rewriting nested `LIMIT` or `OFFSET` clauses.
- Create per-database `.sql` script files that persist under QueryNest application data.
- Open multiple scripts as tabs, preserving each script's text, saved copy, query results, caret, and undo history.
- Guard unsaved scripts when closing or deleting them.

### Backup, restore, import, and export

- Back up SQLite and PostgreSQL databases to QueryNest `.qnb` archives using streamed batches and checkpointed pending `.pqnb` files.
- Archive the source database's own DDL so constraints, indexes, views, triggers, generated columns, enums, routines, and other supported objects can be restored faithfully.
- Preview backups and surface unsupported SQLite virtual tables before creating the archive.
- Restore completed `.qnb` backups and SQL dumps.
- Export one table as CSV or raw CSV, or export one or more tables as JSON.
- Import CSV and JSON data with a schema/column preview before applying it.
- Choose whether an import aborts or skips rows when conflicts occur.
- Select multiple tables for group operations such as export and truncate.

### Desktop experience

- Frameless desktop window with persistent resizable database and table sidebars.
- Configurable application font, SQL editor font, editor font size, caret width, backup batch size, and undo-history depth.
- Respect `prefers-reduced-motion` while retaining the application's animation system.
- Use a browser-only mock backend for frontend development without Wails.

## Application data

QueryNest has two build variants. A normal desktop build stores both `config.json` and `connections.json` in the operating system's QueryNest configuration directory:

- Windows: `%AppData%\QueryNest`
- macOS: `~/Library/Application Support/QueryNest`
- Linux: `$XDG_CONFIG_HOME/QueryNest` (normally `~/.config/QueryNest`)

A portable build stores both files in a `data` directory beside the executable. On macOS, `data` is placed beside `QueryNest.app` so the signed application bundle is not modified. PostgreSQL passwords remain in the operating system credential manager and are never written to either JSON file.

The old `~/.querynet/config.json` location is no longer used. A normal desktop build copies valid settings from that file into the new application data directory once when the new `config.json` does not exist.

`config.json` remembers sidebar widths, appearance, transfer, and editing preferences. Existing browser-stored sidebar widths migrate on the first launch without a config file. Subsequent launches use the file.

```json
{
  "version": 1,
  "sidebars": {
    "databases": 1,
    "tables": 1
  },
  "appearance": {
    "fontSize": 17,
    "fontFamily": "system"
  },
  "transfer": {
    "backupBatchSizeMB": 500
  },
  "editing": {
    "undoHistoryLimit": 100,
    "caretWidth": 2,
    "editorFontSize": 12,
    "editorFontFamily": "mono"
  }
}
```

Widths are scales from `1` (default) to `2` (double width), so they adapt to compact windows. Manual file edits take effect after restarting the app. The frontend-only preview uses browser storage.

SQL scripts are stored per database under `<appDataDir>/projects/<hash>`, where the hash identifies the database from its driver and path. This keeps scripts attached to the database even if a saved connection profile is renamed or recreated.

## Requirements

- Go 1.25 or newer
- Node.js 20 or newer
- Wails v2 CLI
- The platform dependencies listed in the [Wails installation guide](https://wails.io/docs/gettingstarted/installation/)

## Run in development

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
cd frontend && npm install && cd ..
wails dev
```

If Go was just installed and your terminal does not find it yet, add `/usr/local/go/bin` to `PATH` or open a new terminal.

## Build the desktop app

```bash
go run ./scripts/build.go
```

The packaged binary is written to `build/bin/`. The build defaults to the normal desktop variant. Set `QUERYNEST_PORTABLE=true` at build time for the portable variant:

```bash
QUERYNEST_PORTABLE=true go run ./scripts/build.go -o QueryNest-portable
```

PowerShell equivalent:

```powershell
$env:QUERYNEST_PORTABLE = "true"
go run ./scripts/build.go -o QueryNest-portable.exe
```

On current Ubuntu/Debian releases, install the desktop build dependencies. The build helper detects WebKitGTK 4.1 automatically and supplies the Wails compatibility tag:

```bash
sudo apt install pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
go run ./scripts/build.go
```

### Cross-build Windows from Linux

The Windows target and the included SQLite driver are pure Go, so this build does not require MinGW:

```bash
go run ./scripts/build.go -platform windows/amd64 -o QueryNest-windows-amd64.exe

# Portable Windows build
QUERYNEST_PORTABLE=true go run ./scripts/build.go -platform windows/amd64 -o QueryNest-portable-windows-amd64.exe
```

Use `windows/arm64` instead for Windows on ARM. Add `-nsis` when NSIS is installed if you want a Windows installer rather than a standalone executable.

## Automated release builds

GitHub Actions builds production artifacts only when a commit reaches `main`, including commits created by merging another branch. Pull requests and pushes to other branches do not trigger the workflow.

Each run produces:

- `QueryNestInstaller.exe`, an NSIS installer for Windows x64
- `QueryNestPortal.exe`, the portable Windows x64 application
- `QueryNest-macos-universal.zip`, containing the universal `QueryNest.app` bundle and its `Contents/Info.plist`, for Intel and Apple Silicon Macs
- A SHA-256 checksum beside each package

The workflow first uploads all three build artifacts, then waits for every build to succeed before publishing one GitHub Release tagged `build-<run-number>-<short-sha>`. Workflow artifacts remain available for 30 days; GitHub Release assets remain attached to the release. The macOS bundle is ad-hoc signed, so public distribution without Gatekeeper warnings still requires an Apple Developer ID certificate and notarization credentials.

## Frontend-only preview

The frontend includes a local mock database for browser development:

```bash
cd frontend
npm run dev
```

## Safety model

Connections can be marked read-only. The scratch SQL console accepts only a single `SELECT`; SQLite executes it with `PRAGMA query_only = ON`, while PostgreSQL executes it inside a read-only transaction. Saved script statements on a read-only connection are routed through the same restriction.

Saved scripts on an editable connection intentionally run SQL directly, including write and DDL statements. When multiple statements are selected, QueryNest executes them one by one rather than wrapping the whole selection in an implicit transaction.

Edits, inserts, deletes, and truncates remain local drafts until explicitly saved. A table's complete change set is committed in one transaction, and undo/redo changes only those local drafts rather than issuing compensating writes. Existing-row updates and deletes use primary-key predicates and are rolled back unless exactly one record is affected. Table and column identifiers are validated against introspected schema before write SQL is constructed.

Backup and restore preserve database DDL instead of reconstructing it from column metadata. `.qnb` restores validate archived objects against the manifest before replaying SQL, and incomplete `.pqnb` files cannot be restored. A `.qnb` or SQL dump should still be treated as trusted input because restoring it intentionally executes database definition statements.

Query results are capped at 1,000 rows and normal table pages at 500 rows per request. Transfer and restore paths use bounded or streamed processing where practical, and file-preview tokens scope a preview to the file selected for that operation.

## Next milestones

The current roadmap still includes broader database support such as MySQL, richer table filtering and column selection, query history, and SSH tunnelling. See `todos.md` for working notes; completed items there may lag behind the implementation, so the code and this README are the source of truth for shipped behavior.
