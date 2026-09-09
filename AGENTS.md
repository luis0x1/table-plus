# QueryNest contributor guide

## Project overview

QueryNest is a TablePlus-inspired desktop database client built with Go, Wails v2, React, and TypeScript. It currently supports SQLite and PostgreSQL.

## Repository map

- `main.go`: Wails bootstrap and desktop window configuration.
- `app.go`: connection state, table/schema browsing, paginated reads, and the read-only SQL console.
- `database_sessions.go`: independent open-database sessions and session-scoped backend forwarding.
- `connections.go`: saved connection profiles and OS credential-manager integration.
- `config.go`: persisted application, sidebar, and appearance preferences.
- `data_edit.go`: validated insert, update, delete, and truncate operations applied in one transaction.
- `app_test.go`: backend and SQL-generation tests.
- `frontend/src/App.tsx`: main UI, database workspaces, cached table activities, data grid, local drafts, unsaved-change guards, and undo/redo history.
- `frontend/src/bridge.ts`: typed Wails API surface plus browser-preview mocks.
- `frontend/src/types.ts`: shared frontend data contracts.
- `frontend/src/icons.tsx` and `frontend/vite.config.ts`: Material Symbols Rounded bindings and build-time icon-weight selection.
- `frontend/src/useSidebarPreferences.ts`: persisted sidebar sizing and appearance state.
- `frontend/src/styles.css`: application and grid styling.

## Code navigation

When `.codegraph/` exists, use CodeGraph before text search or broad file reads:

```bash
codegraph explore "symbol names or question"
```

Use `rg` for exact text searches after CodeGraph has identified the relevant area. The CodeGraph database is a machine-local generated index and must not be committed.

## Behavioral invariants

- Keep the SQL console read-only. It must reject unsupported statements and execute inside a read-only transaction.
- Multiple databases can remain open as independent workspaces. Switching databases or table tabs must preserve each open workspace's UI state.
- An open table tab owns its own rows, schema, indexes, view, filter, page, sorting, selection, loading, and error state. Never reuse another tab's state as a placeholder.
- Keep open table panels mounted with React 19 `<Activity>` using `visible` and `hidden` modes. Returning to an already-loaded tab must not query again unless its request inputs were changed or the user explicitly refreshed/invalidated it.
- Closing a table tab releases that tab's cached UI state and drafts. Closing a database releases the whole database workspace.
- A failed table query must clear that table's rows and show its own inline error. It must never leave rows from the previously active tab visible.
- Listing database objects after a connection must not automatically open the first table. Show the empty “Select a table” state until the user chooses one.
- Preserve the connection skeleton while a database session is connecting, plus sidebar/workspace and row-count skeletons while metadata is loading. Loading must not flash stale content.
- SQLite virtual tables such as `VirtualKNN` and `VirtualSpatialIndex` can require modules unavailable in the current build. Surface a clear per-table unavailable-module error. If support is added, bundle/register the supported extension in QueryNest; do not silently depend on a user-installed system extension.
- Structure view includes both columns and indexes. Keep SQLite and PostgreSQL index introspection synchronized through Go methods, session forwarding, bridge types, browser mocks, and frontend rendering.
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
- Preserve Appearance settings for global font size and font family, persisted sidebar widths, the application motion system, and `prefers-reduced-motion` behavior.
- Material Symbols use the Rounded family. `VITE_ICON_WEIGHT` is a build-time setting and must accept only 100, 200, 300, 400, 500, 600, or 700; changing it must visibly change imported icon variants.

## Grid interaction invariants

- The `#` column is the row index. It shows continuous page-aware row numbers, never an ellipsized value such as `1…`, and derives its width from the largest row number in the result set.
- Preserve per-table data-column order and manually resized widths in local storage.
- A divider between adjacent data headers uses two separate resize handles: 8 px inside the right edge of the left header and 8 px inside the left edge of the right header. Both handles resize the left-hand column, giving a centered 16 px hit area without overflowing across sticky-header stacking layers.
- The first data header has no left resize handle because the `#` column is automatic. The final data header retains its right-side handle.
- Resize handles must stop click, double-click, pointer, and native drag propagation so resizing never sorts or reorders a column. Header drag/reorder and header click/sort must continue to work outside the resize hit area.
- Keep the resize guide visually centered on the actual divider even though its pointer area spans both adjacent headers.

## Editing guidelines

- Keep Go backend methods small and return errors with useful operation context.
- Run `gofmt` on changed Go files.
- Keep frontend API types synchronized between Go bindings, `frontend/src/bridge.ts`, and `frontend/src/types.ts`.
- Treat the current settings, animation, skeleton, workspace, and tab-cache behavior as product functionality, not optional polish; do not replace `App.tsx` or `styles.css` from an older branch without reconciling these features.
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
go run ./scripts/build.go
```

For a Windows x64 build from Linux:

```bash
go run ./scripts/build.go -platform windows/amd64 -o QueryNest-windows-amd64.exe
```

The release workflow is `.github/workflows/release.yml`. It intentionally triggers only on pushes to `main`; do not add `pull_request`, branch-wide `push`, or `workflow_dispatch` triggers unless the release policy changes. A GitHub Release is published only after both the Windows and macOS matrix builds succeed.

Before handing off grid or draft changes, manually consider edit-on-blur, Escape cancellation, both halves of every resize divider, resize without sorting/reordering, header drag outside resize handles, page-aware row numbering, JSON overflow, undo/redo, discard, save, and every unsaved-change modal path.

Before handing off workspace or loading changes, manually consider initial connection skeletons, failed connections, no automatic first-table selection, switching databases, switching repeatedly between already-open table tabs without new queries, explicit refresh invalidation, per-tab filter/page/sort state, virtual-table failures without stale rows, tab close cleanup, Appearance persistence, and reduced-motion mode.
