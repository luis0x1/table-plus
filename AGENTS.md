# QueryNest contributor guide

## Project overview

QueryNest is a TablePlus-inspired desktop database client built with Go, Wails v2, React, and TypeScript. It currently supports SQLite and PostgreSQL.

## Repository map

- `main.go`: Wails bootstrap and desktop window configuration.
- `app.go`: connection state, table/schema browsing, paginated reads, and the read-only SQL console.
- `connections.go`: saved connection profiles and OS credential-manager integration.
- `data_edit.go`: validated insert, update, delete, and truncate operations applied in one transaction.
- `app_test.go`: backend and SQL-generation tests.
- `frontend/src/App.tsx`: main UI, data grid, local drafts, unsaved-change guards, and undo/redo history.
- `frontend/src/bridge.ts`: typed Wails API surface plus browser-preview mocks.
- `frontend/src/types.ts`: shared frontend data contracts.
- `frontend/src/styles.css`: application and grid styling.

## Code navigation

When `.codegraph/` exists, use CodeGraph before text search or broad file reads:

```bash
codegraph explore "symbol names or question"
```

Use `rg` for exact text searches after CodeGraph has identified the relevant area. The CodeGraph database is a machine-local generated index and must not be committed.

## Behavioral invariants

- Keep the SQL console read-only. It must reject unsupported statements and execute inside a read-only transaction.
- Grid mutations remain local drafts until the user saves them. `Ctrl+S` applies the active table's draft atomically.
- Preserve draft colors: updates yellow, inserts green, deletes and truncates red.
- Preserve unsaved-change guards before an action can hide or replace edited rows.
- Undo and redo operate on local drafts only; they must not issue compensating database writes.
- Existing-row updates and deletes require primary-key predicates and must affect exactly one row.
- Validate table and column names against introspected schema before constructing write statements.
- Keep SQLite and PostgreSQL identifier quoting, placeholders, schemas, and transaction behavior driver-aware.
- Windows SQLite paths must remain valid file URIs; do not reintroduce `file://C:/...` authority parsing.
- Never store database passwords in profile JSON or source files. Use the operating-system credential manager.
- JSON previews must not determine column width; long values are clipped with an ellipsis and open in the JSON viewer.

## Editing guidelines

- Keep Go backend methods small and return errors with useful operation context.
- Run `gofmt` on changed Go files.
- Keep frontend API types synchronized between Go bindings, `frontend/src/bridge.ts`, and `frontend/src/types.ts`.
- Preserve per-table column order and width persistence when changing the grid.
- Do not edit generated or local-only content in `frontend/dist/`, `frontend/wailsjs/`, `frontend/node_modules/`, `build/bin/`, or `.codegraph/codegraph.db`.
- Do not overwrite unrelated working-tree changes.

## Verification

Run the checks relevant to every change:

```bash
go test ./...
npm --prefix frontend run build
```

For backend changes, also run:

```bash
go vet ./...
```

For a normal desktop build:

```bash
wails build
```

For a Windows x64 build from Linux:

```bash
wails build -platform windows/amd64 -o QueryNest-windows-amd64.exe
```

The release workflow is `.github/workflows/release.yml`. It intentionally triggers only on pushes to `main`; do not add `pull_request`, branch-wide `push`, or `workflow_dispatch` triggers unless the release policy changes. A GitHub Release is published only after both the Windows and macOS matrix builds succeed.

Before handing off grid or draft changes, manually consider edit-on-blur, Escape cancellation, resize/drag without sorting, JSON overflow, undo/redo, discard, save, and every unsaved-change modal path.
