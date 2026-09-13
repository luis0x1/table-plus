package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func openTestSession(t *testing.T, app *App, name string) ConnectionStatus {
	t.Helper()
	path := filepath.Join(t.TempDir(), name+".db")
	if err := seedDemo(path); err != nil {
		t.Fatal(err)
	}
	status, err := app.OpenSQLiteSession(path)
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func TestCreateDatabaseValidationAndSQLiteBoundary(t *testing.T) {
	for _, value := range []string{"", "   ", "bad\nname", strings.Repeat("a", 64)} {
		if _, err := normalizeDatabaseName(value); err == nil {
			t.Fatalf("accepted invalid database name %q", value)
		}
	}
	if name, err := normalizeDatabaseName(" analytics_dev "); err != nil || name != "analytics_dev" {
		t.Fatalf("normalization returned %q, %v", name, err)
	}
	app := NewApp()
	t.Cleanup(func() { app.shutdown(context.Background()) })
	session := openTestSession(t, app, "sqlite-create-boundary")
	if err := app.CreateDatabase(session.ID, "another"); err == nil || !strings.Contains(err.Error(), "SQLite") {
		t.Fatalf("SQLite session accepted server database creation: %v", err)
	}
}

func TestDatabaseSessionsIsolateReadsAndWrites(t *testing.T) {
	app := NewApp()
	t.Cleanup(func() { app.shutdown(context.Background()) })
	first, second := openTestSession(t, app, "first"), openTestSession(t, app, "second")
	if first.ID == second.ID || first.ID == "" || first.Database != "first" {
		t.Fatalf("invalid session identities: %#v %#v", first, second)
	}
	duplicate, err := app.OpenSQLiteSession(first.Path)
	if err != nil || duplicate.ID != first.ID || len(app.ListDatabaseSessions()) != 2 {
		t.Fatalf("reopening a database should reuse its session: %#v, %v", duplicate, err)
	}
	var workers sync.WaitGroup
	for _, session := range []ConnectionStatus{first, second} {
		workers.Add(1)
		go func(session ConnectionStatus) {
			defer workers.Done()
			for i := 0; i < 10; i++ {
				_, err := app.SessionApplyChanges(session.ID, "main", "customers", []RowOperation{{
					Type: "update", Values: map[string]any{"company": session.Database}, PrimaryKey: map[string]any{"id": 1},
				}})
				if err != nil {
					t.Error(err)
					return
				}
				data, err := app.SessionGetTableData(session.ID, "main", "customers", 50, 0, session.Database, "id", "asc")
				if err != nil || data.Total != 1 || data.Rows[0][3] != session.Database {
					t.Errorf("session %s read another database: %#v, %v", session.Database, data, err)
					return
				}
			}
		}(session)
	}
	workers.Wait()
	if _, err := app.SessionExecuteQuery(first.ID, "DELETE FROM customers"); err == nil {
		t.Fatal("session SQL console must remain read-only")
	}
	result, err := app.SessionExecuteScriptStatement(first.ID, "UPDATE customers SET company = 'Saved script' WHERE id = 1")
	if err != nil || result.RowsAffected != 1 {
		t.Fatalf("saved script could not write through its session: %#v, %v", result, err)
	}
	if err := app.CloseDatabaseSession(first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := app.SessionListTables(first.ID); err == nil {
		t.Fatal("closed session accepted a read")
	}
	if _, err := app.SessionCountTableRows(first.ID, "main", "customers"); err == nil {
		t.Fatal("closed session accepted a row count")
	}
	if _, err := app.SessionApplyChanges(first.ID, "main", "customers", nil); err == nil {
		t.Fatal("closed session accepted a write")
	}
	if _, err := app.SessionListTables(second.ID); err != nil {
		t.Fatalf("closing first broke second: %v", err)
	}
	if len(app.ListDatabaseSessions()) != 1 {
		t.Fatal("closing first removed the wrong sessions")
	}
	child, _ := app.databaseSession(second.ID)
	db, _, _ := child.connection()
	app.shutdown(context.Background())
	if len(app.ListDatabaseSessions()) != 0 {
		t.Fatal("shutdown retained sessions")
	}
	if err := db.Ping(); err == nil {
		t.Fatal("shutdown did not close database")
	}
}

func TestFailedSessionOpenPreservesExistingDatabase(t *testing.T) {
	app := NewApp()
	t.Cleanup(func() { app.shutdown(context.Background()) })
	first := openTestSession(t, app, "existing")
	if _, err := app.OpenPostgresSession(PostgresConfig{Host: "localhost", Port: 70000, User: "test", Database: "test"}); err == nil {
		t.Fatal("expected invalid PostgreSQL configuration to fail")
	}
	if _, err := app.OpenSQLiteSession(filepath.Join(t.TempDir(), "missing.db")); err == nil {
		t.Fatal("expected missing file to fail")
	}
	if _, err := app.OpenDatabase(first.ID, "another"); err == nil {
		t.Fatal("SQLite session cannot open a PostgreSQL database")
	}
	databases, err := app.ListDatabases(first.ID)
	if err != nil || len(databases) != 1 || databases[0] != "existing" {
		t.Fatalf("unexpected SQLite list: %v, %v", databases, err)
	}
	if len(app.ListDatabaseSessions()) != 1 {
		t.Fatal("failed connection changed session list")
	}
	if _, err := app.SessionListTables(first.ID); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresDatabasePickerPreservesConnectionOptions(t *testing.T) {
	port := startSessionPostgres(t)
	app := NewApp()
	t.Cleanup(func() { app.shutdown(context.Background()) })
	config := PostgresConfig{Name: "Local PostgreSQL", Host: "127.0.0.1", Port: port, User: "reader", Password: "test-only-secret", Database: "appdb", SSLMode: "disable", ReadOnly: true}
	first, err := app.OpenPostgresSession(config)
	if err != nil {
		t.Fatal(err)
	}
	databases, err := app.ListDatabases(first.ID)
	if err != nil || len(databases) != 3 {
		t.Fatalf("catalog: %v, %v", databases, err)
	}
	second, err := app.OpenDatabase(first.ID, "analytics")
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == first.ID || second.Database != "analytics" || second.Name != config.Name || !second.ReadOnly {
		t.Fatalf("incorrect sibling database: %#v", second)
	}
	child, _ := app.databaseSession(second.ID)
	if child.postgresConfig.User != config.User || child.postgresConfig.Password != config.Password || child.postgresConfig.SSLMode != config.SSLMode || child.postgresConfig.SaveConnection {
		t.Fatal("opening a sibling changed credentials or saved the profile")
	}
	if _, err := app.SessionApplyChanges(second.ID, "public", "customers", []RowOperation{{Type: "truncate"}}); err == nil {
		t.Fatal("read-only option was not enforced")
	}
	back, err := app.OpenDatabase(second.ID, "appdb")
	if err != nil || back.ID != first.ID || len(app.ListDatabaseSessions()) != 2 {
		t.Fatalf("sibling session was duplicated: %#v %v", back, err)
	}
	if _, err := app.OpenDatabase(first.ID, "unavailable"); err == nil {
		t.Fatal("database outside catalog was accepted")
	}
	if _, err := app.OpenDatabase(first.ID, "broken"); err == nil {
		t.Fatal("failed database connection was accepted")
	}
	if len(app.ListDatabaseSessions()) != 2 {
		t.Fatal("failed sibling connection changed sessions")
	}
	encoded, err := json.Marshal(app.ListDatabaseSessions())
	if err != nil || strings.Contains(string(encoded), config.Password) {
		t.Fatal("session metadata exposed credentials")
	}
	if _, err := app.ListDatabases(first.ID); err != nil {
		t.Fatalf("original connection was lost: %v", err)
	}
}
