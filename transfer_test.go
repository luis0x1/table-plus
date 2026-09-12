package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSQLRestoreScannerKeepsBodiesAndQuotedSemicolonsTogether(t *testing.T) {
	path := filepath.Join(t.TempDir(), "boundaries.sql")
	content := "\ufeff" + `-- leading comment with ;
CREATE TABLE notes (value TEXT);
INSERT INTO notes VALUES ('one;two');
CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN
  INSERT INTO notes VALUES (CASE WHEN NEW.value = 'x' THEN 'a;b' ELSE 'c' END);
END;
CREATE FUNCTION touch_note() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM 1;
  RETURN NEW;
END
$body$;`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	scanner, err := openRestoreSQLScanner(path)
	if err != nil {
		t.Fatal(err)
	}
	defer scanner.Close()
	statements := make([]string, 0)
	for {
		statement, err := scanner.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		statements = append(statements, statement)
	}
	if len(statements) != 4 {
		t.Fatalf("split SQL dump into %d statements: %#v", len(statements), statements)
	}
	if !strings.Contains(statements[2], "CASE WHEN") || !strings.Contains(statements[3], "PERFORM 1;") {
		t.Fatalf("trigger or dollar-quoted body was split: %#v", statements)
	}
}

func TestRestoreSQLDumpIsAtomic(t *testing.T) {
	app := openTestApp(t)
	path := filepath.Join(t.TempDir(), "restore.sql")
	content := `PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;
CREATE TABLE restored_notes (id INTEGER PRIMARY KEY, value TEXT);
CREATE TABLE restored_audit (value TEXT);
CREATE TRIGGER restored_notes_audit AFTER INSERT ON restored_notes BEGIN
  INSERT INTO restored_audit VALUES ('created;' || NEW.value);
END;
INSERT INTO restored_notes VALUES (1, 'from SQL');
COMMIT;`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	preview, err := previewSQLRestore(path, driverSQLite, "test")
	if err != nil || preview.Format != "sql" || preview.Statements != 5 {
		t.Fatalf("unexpected SQL preview: %#v, %v", preview, err)
	}
	result, err := app.RestoreDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	if result.Statements != preview.Statements {
		t.Fatalf("preview counted %d statements but restore ran %d", preview.Statements, result.Statements)
	}
	var value string
	if err := app.db.QueryRow(`SELECT value FROM restored_audit`).Scan(&value); err != nil || value != "created;from SQL" {
		t.Fatalf("SQL restore did not preserve trigger body: %q, %v", value, err)
	}

	broken := filepath.Join(t.TempDir(), "broken.sql")
	if err := os.WriteFile(broken, []byte(`CREATE TABLE rolled_back (id INTEGER); INSERT INTO missing_table VALUES (1);`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := app.RestoreDatabase(broken); err == nil {
		t.Fatal("invalid SQL restore unexpectedly succeeded")
	}
	var count int
	if err := app.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed SQL restore was not rolled back: count=%d, %v", count, err)
	}
}

func TestPostgresDumpMetadataIsPortable(t *testing.T) {
	skipped := []string{
		"-- Name: public; Type: SCHEMA; Owner: postgres\nALTER SCHEMA public OWNER TO postgres;",
		"GRANT ALL ON SCHEMA public TO postgres;",
		"REVOKE ALL ON TABLE public.notes FROM PUBLIC;",
		"SET SESSION AUTHORIZATION postgres;",
		"SET ROLE postgres;",
		"ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT SELECT ON TABLES TO reader;",
		"CREATE DATABASE source WITH OWNER = postgres;",
	}
	for _, statement := range skipped {
		if !skipPortablePGDumpStatement(statement, driverPostgres) {
			t.Errorf("portable restore did not skip %q", statement)
		}
	}
	if skipPortablePGDumpStatement("SET search_path = public, pg_catalog;", driverPostgres) {
		t.Fatal("portable restore skipped a non-role PostgreSQL setting")
	}
	if skipPortablePGDumpStatement("ALTER TABLE notes ADD COLUMN value text;", driverPostgres) {
		t.Fatal("portable restore skipped a schema change")
	}
	query, columns, matched, err := parsePGDumpCopyStatement(`COPY "Sales"."Order items" ("Order ID", sku) FROM stdin;`, driverPostgres)
	if err != nil || !matched || len(columns) != 2 {
		t.Fatalf("could not parse quoted pg_dump COPY statement: query=%q columns=%v matched=%t err=%v", query, columns, matched, err)
	}
	expected := `INSERT INTO "Sales"."Order items" ("Order ID", "sku") OVERRIDING SYSTEM VALUE VALUES ($1, $2)`
	if query != expected {
		t.Fatalf("unexpected PostgreSQL COPY insert: %q", query)
	}
}

func TestRestorePostgresCopyTextDump(t *testing.T) {
	app := openTestApp(t)
	path := filepath.Join(t.TempDir(), "pg_dump.sql")
	content := `\restrict QueryNestDump
CREATE TABLE copied_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL, note TEXT);
COPY copied_items (id, value, note) FROM stdin;
1	one\ttwo	\N
2	line\nfeed	back\\slash
\.
\unrestrict QueryNestDump
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	preview, err := previewSQLRestore(path, driverSQLite, "test")
	if err != nil || preview.Statements != 2 {
		t.Fatalf("unexpected COPY preview: %#v, %v", preview, err)
	}
	result, err := app.RestoreDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	if result.Statements != 2 || result.Rows != 2 || result.Skipped != 2 {
		t.Fatalf("unexpected COPY restore result: %#v", result)
	}
	var value string
	var note *string
	if err := app.db.QueryRow(`SELECT value, note FROM copied_items WHERE id = 1`).Scan(&value, &note); err != nil {
		t.Fatal(err)
	}
	if value != "one\ttwo" || note != nil {
		t.Fatalf("COPY escapes or NULL were not restored: value=%q note=%v", value, note)
	}
	if err := app.db.QueryRow(`SELECT value, note FROM copied_items WHERE id = 2`).Scan(&value, &note); err != nil {
		t.Fatal(err)
	}
	if value != "line\nfeed" || note == nil || *note != `back\slash` {
		t.Fatalf("COPY escaped row was not restored: value=%q note=%v", value, note)
	}
}

func TestStreamingBackupRestoreAndPendingRename(t *testing.T) {
	app := openTestApp(t)
	if _, err := app.db.Exec(`CREATE TABLE archive_test (id INTEGER PRIMARY KEY, payload BLOB NOT NULL); CREATE INDEX archive_test_payload_idx ON archive_test(payload); INSERT INTO archive_test VALUES (1, x'00FF10')`); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "demo.qnb")
	result, err := app.writeDatabaseBackup(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows == 0 || result.Tables == 0 || result.Path != path {
		t.Fatalf("unexpected backup result: %#v", result)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "demo.pqnb")); !os.IsNotExist(err) {
		t.Fatalf("completed backup retained pending file: %v", err)
	}
	_, reader, err := readBackupManifest(path)
	if err != nil {
		t.Fatal(err)
	}
	foundCheckpoint, foundComplete := false, false
	decoder := backupDecoder(reader)
	for {
		var record backupRecord
		if err := decoder.Decode(&record); err != nil {
			break
		}
		foundCheckpoint = foundCheckpoint || record.Kind == "checkpoint"
		foundComplete = foundComplete || record.Kind == "complete"
	}
	_ = reader.Close()
	if !foundCheckpoint || !foundComplete {
		t.Fatalf("backup did not contain durable progress records: checkpoint=%v complete=%v", foundCheckpoint, foundComplete)
	}
	if _, err := app.db.Exec(`DELETE FROM customers`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`DROP TABLE archive_test`); err != nil {
		t.Fatal(err)
	}
	restored, err := app.RestoreDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	count, err := app.CountTableRows("main", "customers")
	if err != nil || count != 8 || restored.Rows != result.Rows {
		t.Fatalf("restore result=%#v customers=%d error=%v", restored, count, err)
	}
	var payload []byte
	if err := app.db.QueryRow(`SELECT payload FROM archive_test WHERE id = 1`).Scan(&payload); err != nil || len(payload) != 3 || payload[1] != 0xff {
		t.Fatalf("binary table was not recreated: %x, %v", payload, err)
	}
}

func TestStreamingJSONExportCanBeImported(t *testing.T) {
	app := openTestApp(t)
	path := filepath.Join(t.TempDir(), "customers.json")
	result, err := app.exportJSON(path, []TableRef{{Schema: "main", Name: "customers"}})
	if err != nil || result.Rows != 8 {
		t.Fatalf("export result: %#v, %v", result, err)
	}
	parsed, format, err := parseImportFile(path, TableRef{Schema: "main", Name: "customers"})
	if err != nil || format != "json" || len(parsed.Columns) != 6 || len(parsed.Rows) != 8 {
		t.Fatalf("parse export: %#v, %s, %v", parsed, format, err)
	}
}

func TestCSVImportConflictOptions(t *testing.T) {
	app := openTestApp(t)
	path := filepath.Join(t.TempDir(), "customers.csv")
	if _, err := app.exportCSV(path, TableRef{Schema: "main", Name: "customers"}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.ImportTable(TableRef{Schema: "main", Name: "customers"}, path, "abort"); err == nil {
		t.Fatal("abort conflict option accepted duplicate primary keys")
	}
	result, err := app.ImportTable(TableRef{Schema: "main", Name: "customers"}, path, "skip")
	if err != nil || result.Rows != 0 || result.Skipped != 8 {
		t.Fatalf("unexpected skip result: %#v, %v", result, err)
	}
}
