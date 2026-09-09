# QueryNest contributor guide

## Project overview

QueryNest is a TablePlus-inspired desktop database client built with Go, Wails v2, SolidJS, and TypeScript. It currently supports SQLite and PostgreSQL.

## Repository map

- `main.go`: Wails bootstrap and desktop window configuration.
- `app.go`: connection state, table/schema browsing, paginated reads, and the read-only SQL console.
- `database_sessions.go`: independent open-database sessions and session-scoped backend forwarding.
- `connections.go`: saved connection profiles and OS credential-manager integration.
- `config.go`: persisted application, sidebar, appearance, data-operation, and editing preferences.
- `data_edit.go`: validated insert, update, delete, and truncate operations applied in one transaction.
- `transfer.go`: backup, restore, table export and import, plus truncate.
- `backup_schema.go`: captures the source database's own DDL for a backup and builds the statements that replace it on restore.
- `app_test.go`: backend and SQL-generation tests.
- `frontend/src/App.tsx`: main UI, database workspaces, cached table panels, local drafts, unsaved-change guards, and undo/redo history.
- `frontend/src/DataGrid.tsx`: the data grid, windowed row rendering, draft grid construction, column order/resize, cell editing, and the JSON viewer.
- `frontend/src/bridge.ts`: typed Wails API surface plus browser-preview mocks.
- `frontend/src/types.ts`: shared frontend data contracts.
- `frontend/src/icons.tsx` and `frontend/vite.config.ts`: the Solid Material Symbols component and build-time icon-weight path extraction.
- `frontend/src/solid-jsx.d.ts`: JSX attribute typings Solid does not ship (currently SVG `focusable`).
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
- Keep open table panels mounted. Every open tab renders inside the `<For each={tabs()}>` list and inactive panels are hidden with the `hidden` attribute (`.table-activity[hidden]` sets `display: none`); never unmount a panel to hide it. Returning to an already-loaded tab must not query again unless its request inputs were changed or the user explicitly refreshed/invalidated it.
- Closing a table tab releases that tab's cached UI state and drafts. Closing a database releases the whole database workspace.
- A failed table query must clear that table's rows and show its own inline error. It must never leave rows from the previously active tab visible.
- Listing database objects after a connection must not automatically open the first table. Show the empty “Select a table” state until the user chooses one.
- Preserve the connection skeleton while a database session is connecting, plus sidebar/workspace and row-count skeletons while metadata is loading. Loading must not flash stale content.
- SQLite virtual tables such as `VirtualKNN`, `VirtualSpatialIndex` and `VirtualElementary` can require modules unavailable in the current build. Surface a clear per-table unavailable-module error. A backup must not fail because of one: virtual tables are detected from their `CREATE VIRTUAL TABLE` statement, left out of the archive, and listed in the preview with the module that provides them, so the omission is visible before the user runs it. Their shadow tables are ordinary tables and are still archived; do not exclude tables by guessing at shadow-table names, because that would silently drop real data. If support is added, bundle/register the supported extension in QueryNest; do not silently depend on a user-installed system extension.
- Structure view includes both columns and indexes. Keep SQLite and PostgreSQL index introspection synchronized through Go methods, session forwarding, bridge types, browser mocks, and frontend rendering.
- Grid mutations remain local drafts until the user saves them. `Ctrl+S` applies the active table's draft atomically.
- Undo history depth comes from the `editing.undoHistoryLimit` preference (10-1000, default 100), not a literal. Read it through `props.editingPreferences` so lowering it releases memory immediately.
- Preserve draft colors: updates yellow, inserts green, deletes and truncates red.
- Preserve unsaved-change guards before an action can hide or replace edited rows.
- Undo and redo operate on local drafts only; they must not issue compensating database writes.
- Existing-row updates and deletes require primary-key predicates and must affect exactly one row.
- Validate table and column names against introspected schema before constructing write statements.
- Keep SQLite and PostgreSQL identifier quoting, placeholders, schemas, and transaction behavior driver-aware.
- Windows SQLite paths must remain valid file URIs; do not reintroduce `file://C:/...` authority parsing.
- A backup must archive the source database's own DDL, never DDL rebuilt from introspected column metadata. Rebuilding silently drops foreign keys, CHECK and UNIQUE constraints, collations, generated columns, partial and expression indexes, views and triggers. SQLite stores `sqlite_master.sql` verbatim; PostgreSQL composes from `format_type`, `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_viewdef`, `pg_get_triggerdef` and `pg_get_functiondef`.
- Restoring replays SQL from a file, so every archived object is checked against `backupObjectPrefixes` first and only triggers and routines may contain more than one statement. Treat a `.qnb` file as trusted input, the same as any SQL dump.
- Restore order is fixed: schemas, enum types, tables, clear, rows, foreign keys, routines, indexes, views, triggers. Foreign keys are added after the rows so load order cannot violate them. Objects are dropped in reverse order first, which is what lets a restore run twice and what keeps a view built on another view from blocking the drop.
- Generated columns are never read or written by a backup; the restored definition recomputes them. A PostgreSQL table with a `GENERATED ALWAYS AS IDENTITY` column needs `OVERRIDING SYSTEM VALUE` on the restore insert.
- Backup format version 2 carries archived DDL. Version 1 files must keep restoring through the legacy rebuilt-DDL path. The backup version is separate from the table-export format version; do not merge the two constants.
- Never store database passwords in profile JSON or source files. Use the operating-system credential manager.
- JSON previews must not determine column width; long values are clipped with an ellipsis and open in the JSON viewer.
- Preserve Appearance settings for global font size and font family, persisted sidebar widths, the application motion system, and `prefers-reduced-motion` behavior.
- Material Symbols use the Rounded family. `VITE_ICON_WEIGHT` is a build-time setting and must accept only 100, 200, 300, 400, 500, 600, or 700; changing it must visibly change the emitted icon path data.

## Grid interaction invariants

- Result sets larger than `VIRTUAL_ROW_THRESHOLD` render windowed: spacer rows above and below the visible slice carry the remaining height, so `scrollHeight` stays correct. Paged table data is far below the threshold and keeps rendering every row, so only the SQL console's up-to-1000-row result pays for it. Rows are addressed by their absolute index (`firstRow() + offset`) — drafts, selection, the cell editor and the row number all depend on it — and zebra striping uses the `even` class rather than `:nth-child`, which the spacer rows would shift.
- The `#` column is the row index. It shows continuous page-aware row numbers, never an ellipsized value such as `1…`, and derives its width from the largest row number in the result set.
- Preserve per-table data-column order and manually resized widths in local storage.
- A divider between adjacent data headers uses two separate resize handles: 8 px inside the right edge of the left header and 8 px inside the left edge of the right header. Both handles resize the left-hand column, giving a centered 16 px hit area without overflowing across sticky-header stacking layers.
- The first data header has no left resize handle because the `#` column is automatic. The final data header retains its right-side handle.
- Resize handles must stop click, double-click, pointer, and native drag propagation so resizing never sorts or reorders a column. Header drag/reorder and header click/sort must continue to work outside the resize hit area.
- Keep the resize guide visually centered on the actual divider even though its pointer area spans both adjacent headers.

## SolidJS conventions

Solid's reactivity is fine-grained: components run once and only the expressions that read a signal re-run. These rules are not style preferences; breaking them silently drops reactivity or loops.

- Never destructure props. Read `props.x` at the point of use, and pass `props` values down explicitly rather than spreading. Use `mergeProps` for defaults and `splitProps` when forwarding the rest.
- A prop that must stay reactive is passed as an accessor, not a value. `useSidebarWidth` takes `min` as `() => number` because the table sidebar's minimum depends on `useCompactSidebar`.
- Never early-`return` from a component to branch on state; the branch would be frozen at first run. Use `<Show>` / `<For>` / `<Index>`.
- `<For>` is keyed by item reference and `<Index>` by position. Grid rows and header cells use `<Index>` so a data change updates cells in place instead of rebuilding rows. Open tabs and sessions use `<For>` keyed by their stable string/object identity, which is what preserves a hidden tab's DOM and state.
- React's `onChange` on a text input is Solid's `onInput`. Keep `onChange` only for checkboxes and radios. `onDoubleClick` is `onDblClick`.
- `style` objects go through `setProperty`, so keys are kebab-case and every length needs an explicit unit: `style={{ width: `${n}px`, 'flex-basis': `${n}px` }}`. A bare number is ignored.
- `autofocus` does not fire for dynamically created elements. Focus with `onMount` when the element belongs to the component, or `ref={el => queueMicrotask(() => el.focus())}` for an element created inside JSX.
- `createEffect` tracks every signal it reads. When an effect both reads and writes the same state — the table-load effect in `App.tsx` does — list its dependencies explicitly with `on(...)`, whose callback body is untracked. Without that the effect retriggers itself.
- Solid delegates most events at the document root and honours `stopPropagation` through `cancelBubble`. The grid's resize handles still use native `on:click` / `on:dblclick` / `on:dragstart` / `on:pointerdown` so the event never reaches the header's sort and drag handlers at all.
- `tabStates` and `draftsByTable` are stores, not signals, so an edit in one tab only invalidates that tab. Read store values with `unwrap` before putting them into undo history or sending them to the backend, and use `produce` to delete keys.
- Each open tab builds its grid in its own `createMemo`, so a keystroke in one tab must never rebuild another tab's grid.

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

The PostgreSQL restore test needs a server and is skipped without one:

```bash
QUERYNEST_PG_HOST=localhost QUERYNEST_PG_USER=postgres QUERYNEST_PG_PASSWORD=... go test -run TestPostgresRestoreFidelity
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
