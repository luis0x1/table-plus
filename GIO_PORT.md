# Gio UI port

This branch ports QueryNest from the Wails/React renderer to Gio incrementally.

Base branch: `draf/ux-performance`

## Build

The existing Wails entrypoint remains the default build:

```bash
go build .
```

Build the Gio renderer with:

```bash
go build -tags gio .
```

The first dependency download may update `go.sum`. Run `go mod tidy` with Go 1.25+ after pulling the branch.

## Slice 1 status

Implemented:

- Gio native application entrypoint
- Dark QueryNest shell
- Demo database connection through the existing Go backend
- Tables/views sidebar
- Virtualized two-dimensional data grid
- Horizontal and vertical grid scrolling
- Sort cycling from column headers
- Text filtering
- Pagination
- Refresh and async loading/error states
- Build-tag isolation so the existing Wails app still builds unchanged

Still to migrate:

- Native SQLite file picker (and removal of the core Wails runtime dependency)
- PostgreSQL connection/saved-connections dialog
- Database/session tabs
- Schema view
- SQL query editor and result pane
- Cell selection and inline editing
- JSON viewer/editor
- Staged inserts/updates/deletes, undo/redo, save/discard flow
- Column resizing/reordering and persisted layout
- Keyboard shortcuts and close-with-unsaved-changes guards
- Release/build workflow for Gio targets

## Architecture rule

Gio UI code stays behind the `gio` build tag while migration is incomplete. Database and session behavior should remain in the existing Go backend; renderer-specific concerns should not move into database code.
