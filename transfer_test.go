package main

import (
	"os"
	"path/filepath"
	"testing"
)

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
