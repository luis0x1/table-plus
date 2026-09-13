# Security audit and remediation plan

Date: 2026-09-13

Scope: QueryNest Go/Wails backend, SQLite and PostgreSQL query paths, mutations,
backup/restore/import/export, scripts and local files, secrets, frontend rendering,
Wails bridge, dependencies, release workflow, concurrency and resource exhaustion.

The audit was read-only. No application code was changed while producing it.

## Summary

- Critical: 0
- High: 4
- Medium: 5
- Low: 2

The highest-priority risks are the SQLite read-only query boundary, PostgreSQL
schema qualification, loss of 64-bit primary-key precision across the Go/JS
boundary, and insufficient validation of SQL stored in `.qnb` backups.

## P0 — High severity

### [ ] Enforce a real read-only boundary for the SQLite query console

Locations:

- `app.go:714` — `readOnlyStatementAllowed`
- `app.go:731` — leading-keyword validation
- `app.go:738` — `sql.TxOptions{ReadOnly: true}`
- `app.go:743` — query execution
- `app.go:755` — transaction commit
- `go.mod:10` — `modernc.org/sqlite v1.58.0`

The backend accepts every statement beginning with `WITH` and every SQLite
`PRAGMA`. The SQLite driver does not enforce `TxOptions.ReadOnly`, and the
transaction is committed. A statement such as the following can therefore
write through the read-only console:

```sql
WITH candidate AS (SELECT 1)
DELETE FROM customers;
```

Direct Wails bridge calls can also bypass the frontend statement splitter.

Required remediation:

- Run console queries through a dedicated SQLite connection opened in read-only
  mode and/or with `PRAGMA query_only=ON`; do not share it with mutation paths.
- Parse exactly one statement and classify the effective operation after CTEs.
- Reject `PRAGMA` by default or maintain a strict read-only allowlist.
- Add adversarial tests for `WITH ... INSERT/UPDATE/DELETE`, write-capable
  pragmas, transaction-control statements and stacked statements.

Acceptance criteria:

- No console input can persist a schema or data change.
- The protection is enforced in Go and does not depend on the frontend scanner.
- SQLite and PostgreSQL read-only tests cover direct backend/bridge calls.

### [ ] Make identifier qualification driver-safe

Locations:

- `app.go:593` — table reads
- `app.go:761` — table validation
- `app.go:775` — `qualifiedIdentifier`
- `data_edit.go:87` — mutations
- `transfer.go:1450` — truncate

`qualifiedIdentifier` omits the schema when it equals `main`, even for
PostgreSQL. PostgreSQL permits a real schema named `main`. Validation may check
`main.orders`, while the generated SQL uses only `"orders"` and resolves a
different table through `search_path`.

Required remediation:

- Always qualify a non-empty schema, or make qualification explicitly
  driver-aware.
- Add a PostgreSQL integration test containing both `main.orders` and
  `public.orders`, with a hostile `search_path`.
- Cover reads, updates, deletes, inserts, truncate, export and backup.

Acceptance criteria:

- Every operation targets the exact schema/table pair that was validated.

### [ ] Preserve 64-bit primary keys across the Go/JavaScript boundary

Locations:

- `app.go:106` — row wire representation
- `app.go:969` — scanned values
- `frontend/src/types.ts:31` — frontend row type
- `frontend/src/DataGrid.tsx:56` — primary-key and row identity construction
- `frontend/src/App.tsx:1502` — staged mutations
- `data_edit.go:156` — primary-key predicate construction

Go `int64` values are serialized as JSON numbers. JavaScript loses integer
precision above `2^53 - 1`, allowing adjacent `BIGINT` keys to collide. An edit
or delete can therefore target a different row and still pass the exactly-one-
row check.

Required remediation:

- Introduce a lossless typed wire representation, for example
  `{ "type": "int64", "value": "9007199254740993" }`.
- Preserve the original primary-key token separately from display/edit values.
- Decode values according to the introspected column type in the backend.
- Add tests around `2^53`, maximum signed `int64`, composite keys and decimal
  identifiers.

Acceptance criteria:

- Every supported primary-key value round-trips without precision loss.

### [ ] Validate `.qnb` SQL against its manifest

Locations:

- `backup_schema.go:34` — allowed DDL prefixes
- `backup_schema.go:45` — function/trigger body exception
- `backup_schema.go:47` — object validator
- `transfer.go:633` — manifest-driven object drops
- `transfer.go:749` — archived SQL execution
- `frontend/src/App.tsx:2059` — restore warning

The validator checks only a regular-expression prefix. Function and trigger
entries may contain multiple semicolons, and no parser proves that SQL creates
the object named by the manifest. A crafted backup can append SQL or use
manifest metadata to drop one object while creating another.

Required remediation:

- Parse complete DDL statements for each supported driver.
- Verify kind, schema, name and parent table against the manifest entry.
- Reject trailing statements outside a parsed routine/trigger body.
- Allow routines and triggers to be excluded from restore.
- Clearly warn that an untrusted backup can execute database code; consider
  hashes, signatures or provenance for QueryNest-created backups.

Acceptance criteria:

- Restore cannot affect an object absent from the reviewed manifest.
- Malformed, mismatched and stacked DDL fixtures are rejected before any drop.

## P1 — Medium severity

### [ ] Use authenticated PostgreSQL TLS defaults

Locations: `app.go:242`, `app.go:261`, `frontend/src/App.tsx:230`,
`frontend/src/App.tsx:2117`.

The default `sslmode=prefer` permits plaintext fallback. Make `verify-full` the
default for non-local hosts, add visible warnings for weaker modes, and support
CA/client certificates and server-name verification.

### [ ] Add resource budgets and cancellation to untrusted inputs

Locations: `app.go:969`, `transfer.go:483`, `transfer.go:687`,
`transfer.go:1211`, `sql_restore.go:35`.

Row count limits do not bound individual BLOB/string sizes. Gzip, manifests,
records, JSON imports and SQL statements can grow without a byte or structure
limit. Add compressed/decompressed byte limits, result and cell budgets,
maximum object/table/column/row counts, JSON depth limits, streaming imports,
lazy BLOB handling, timeouts and cancellation.

### [ ] Bind preview and execution to the same file

Locations: `transfer.go:449`, `transfer.go:529`, `transfer.go:1124`,
`transfer.go:1256`, `frontend/src/bridge.ts:31`.

Restore/import reopen a raw path after preview, allowing file replacement or a
symlink swap. Return an opaque backend capability bound to an open handle or to
the canonical path, digest, device/inode, size and modification time. Execution
should accept the token, not an arbitrary renderer-provided path, and require a
new preview when the identity changes.

### [ ] Create backup temporary files safely

Locations: `transfer.go:295`, `transfer.go:296`, `transfer.go:400`.

The predictable `.pqnb` path is opened with `O_TRUNC` and follows symlinks. Use
an exclusive random temporary file in the destination directory, reject
symlinks, retain the handle, fsync the file and directory, then rename
atomically.

### [ ] Offer spreadsheet-safe CSV export

Locations: `transfer.go:954`, `transfer.go:991`, `transfer.go:995`.

Database values beginning with `=`, `+`, `-`, `@`, tab or carriage return may
be interpreted as formulas by spreadsheet applications. Default to a safe
export mode that neutralizes these prefixes, with an explicitly labeled raw
mode when exact CSV fidelity is required.

## P2 — Low severity

### [ ] Close the `.qnb` preview reader

Locations: `transfer.go:468`, `transfer.go:483`.

`readBackupManifest` returns a `ReadCloser`, but preview discards it. Close the
reader on every path and add a repeated-preview file-descriptor regression
test.

### [ ] Bound cancellation tombstones

Locations: `app.go:397`, `app.go:401`.

`CancelOperation` stores arbitrary unknown IDs indefinitely. Reject unknown
operations, or use a TTL cache with a strict capacity and ID length/format
limits.

## Defense in depth

- Bind a minimal Wails facade instead of the entire exported `App` API.
- Add an explicit CSP. No current XSS sink was found, but an eventual renderer
  compromise would otherwise inherit broad native database and file access.
- Pin GitHub Actions to full commit SHAs. The release job has `contents: write`.
- Sign Windows artifacts with Authenticode and macOS artifacts with Developer ID
  plus notarization; publish build provenance in addition to checksums.
- Apply regular-file/no-follow checks to portable script storage.
- Do not use the browser mock as a security oracle; keep its limits and error
  behavior synchronized with the backend where practical.

## Checks completed during the audit

- `go mod verify` — passed.
- Backend tests — passed except one test requiring a TCP listener, which the
  sandbox prohibited.
- Backend race tests — passed with the same sandbox-only exception.
- `go vet` — passed.
- `npm audit --prefix frontend --offline --json` — reported zero vulnerabilities
  in the local lockfile/cache; this is not equivalent to an online audit.
- Frontend build could not run because `node_modules`/`tsc` was absent. No
  dependency was installed during the audit.
- PostgreSQL restore integration tests were not run because no PostgreSQL test
  server or credentials were available.
- `govulncheck`, `gosec` and `staticcheck` were not installed and were not added.

## Confirmed protections and eliminated false positives

- Ordinary filter and mutation values use placeholders; identifiers are quoted
  and tables/columns are validated against introspected schema.
- Mutations use transactions, require primary-key predicates and verify exactly
  one affected existing row.
- No `innerHTML`, `eval`, `document.write`, unsafe URL navigation or JSON-to-HTML
  sink was found. JSON values render as Solid text nodes.
- Passwords are stored through the OS keyring and were not found in profile JSON
  or source files.
- Script-name validation blocks separators, `.`, `..` and path traversal;
  creation uses `O_EXCL` and saves use temporary replacement.
- `.qnb` does not extract archive pathnames, so traditional Zip Slip is not
  applicable.
- No runtime shell execution from user-controlled application data was found.
