# QueryNest

QueryNest is a focused desktop database browser inspired by the workflow of TablePlus. It is built with Go, Wails, React, and TypeScript.

The current MVP supports SQLite and PostgreSQL in read-only mode:

- Open a local `.db`, `.sqlite`, or `.sqlite3` file
- Browse tables and views with row counts
- Inspect columns, data types, nullability, defaults, and primary keys
- Search all visible columns, sort, and paginate records
- Keep multiple tables open in tabs
- Run read-only `SELECT`, `WITH`, `PRAGMA`, and `EXPLAIN` queries
- Launch a seeded demo database without any setup
- Connect to PostgreSQL with host, port, database, credentials, and SSL mode
- Browse PostgreSQL schemas, tables, views, columns, and primary keys
- Save SQLite and PostgreSQL connection profiles between launches
- Store PostgreSQL passwords in the operating system credential manager
- Resize and drag columns; layouts are remembered per database table
- Double-click cells to edit data safely through primary keys
- Preview and edit JSON values with validation and formatting
- Stage row edits in yellow, new rows in green, and deletes/truncates in red
- Save all staged changes atomically with `Ctrl+S`
- Warn before closing, refreshing, filtering, sorting, or paging away from unsaved rows

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
wails build
```

The packaged binary is written to `build/bin/`.

On current Ubuntu/Debian releases, install the desktop build dependencies and use WebKitGTK 4.1:

```bash
sudo apt install pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
wails build -tags webkit2_41
```

### Cross-build Windows from Linux

The Windows target and the included SQLite driver are pure Go, so this build does not require MinGW:

```bash
wails build -platform windows/amd64 -o QueryNest-windows-amd64.exe
```

Use `windows/arm64` instead for Windows on ARM. Add `-nsis` when NSIS is installed if you want a Windows installer rather than a standalone executable.

## Automated release builds

GitHub Actions builds production artifacts only when a commit reaches `main`, including commits created by merging another branch. Pull requests and pushes to other branches do not trigger the workflow.

Each run produces:

- `QueryNest-windows-amd64.exe` for Windows x64
- `QueryNest-macos-universal.zip` for Intel and Apple Silicon Macs
- A SHA-256 checksum beside each package

The workflow first uploads per-platform Actions artifacts, then waits for both native builds to succeed before publishing one GitHub Release tagged `build-<run-number>-<short-sha>`. Workflow artifacts remain available for 30 days; GitHub Release assets remain attached to the release. The macOS bundle is ad-hoc signed, so public distribution without Gatekeeper warnings still requires an Apple Developer ID certificate and notarization credentials.

## Frontend-only preview

The frontend includes a local mock database for browser development:

```bash
cd frontend
npm run dev
```

## Safety model

Connections can be marked read-only. The SQL console always runs inside a read-only transaction and also rejects statements whose leading keyword is not a supported read operation. Edits, inserts, deletes, and truncates remain local drafts until saved; the whole change set is committed in one transaction. Updates and deletes use primary-key predicates and are rolled back unless exactly one record is affected. Results are capped at 1,000 rows, and table pages at 500 rows per request.

## Next milestones

MySQL support, export to CSV/JSON, query history, and SSH tunnelling are intentionally left for the next phase.
