package main

import (
	"path/filepath"
	"testing"
)

func openTestApp(t *testing.T) *App {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	if err := seedDemo(path); err != nil {
		t.Fatalf("seed demo database: %v", err)
	}
	app := NewApp()
	if _, err := app.ConnectSQLite(path); err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(func() { _ = app.Disconnect() })
	return app
}

func TestListTablesAndSchema(t *testing.T) {
	app := openTestApp(t)
	tables, err := app.ListTables()
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 3 {
		t.Fatalf("got %d objects, want 3", len(tables))
	}

	columns, err := app.GetTableSchema("main", "customers")
	if err != nil {
		t.Fatal(err)
	}
	if len(columns) != 6 || columns[0].Name != "id" || !columns[0].PrimaryKey {
		t.Fatalf("unexpected customer schema: %#v", columns)
	}
}

func TestGetTableDataFilterAndSort(t *testing.T) {
	app := openTestApp(t)
	data, err := app.GetTableData("main", "customers", 50, 0, "northstar", "name", "desc")
	if err != nil {
		t.Fatal(err)
	}
	if data.Total != 1 || len(data.Rows) != 1 || data.Rows[0][1] != "Olivia Martin" {
		t.Fatalf("unexpected filtered data: %#v", data)
	}
	if _, err := app.GetTableData("main", "customers", 50, 0, "", `name"; DROP TABLE customers; --`, "asc"); err == nil {
		t.Fatal("expected invalid sort column to be rejected")
	}
}

func TestSQLiteWindowsPathURI(t *testing.T) {
	dsn := sqliteDSN(`C:\Users\Luis\My Data\app.db`, false)
	want := "file:///C:/Users/Luis/My%20Data/app.db?mode=rw"
	if dsn != want {
		t.Fatalf("got %q, want %q", dsn, want)
	}
}

func TestPostgresValidationAndSQLHelpers(t *testing.T) {
	app := NewApp()
	if _, err := app.ConnectPostgres(PostgresConfig{Host: "localhost", Port: 70000, User: "postgres", Database: "postgres"}); err == nil {
		t.Fatal("expected invalid port to be rejected")
	}
	if _, err := app.ConnectPostgres(PostgresConfig{Host: "localhost", Port: 5432, User: "postgres", Database: "postgres", SSLMode: "sometimes"}); err == nil {
		t.Fatal("expected invalid SSL mode to be rejected")
	}
	if got := placeholder(driverPostgres, 3); got != "$3" {
		t.Fatalf("got placeholder %q, want $3", got)
	}
	if got := qualifiedIdentifier("sales", `order items`); got != `"sales"."order items"` {
		t.Fatalf("unexpected qualified identifier: %q", got)
	}
}

func TestExecuteQueryIsReadOnly(t *testing.T) {
	app := openTestApp(t)
	result, err := app.ExecuteQuery(`SELECT status, count(*) AS count FROM customers GROUP BY status ORDER BY status`)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(result.Rows))
	}
	if _, err := app.ExecuteQuery(`DELETE FROM customers`); err == nil {
		t.Fatal("expected write query to be rejected")
	}
}

func TestUpdateCellByPrimaryKey(t *testing.T) {
	app := openTestApp(t)
	if err := app.UpdateCell("main", "customers", "company", "Acme Labs", map[string]any{"id": int64(1)}); err != nil {
		t.Fatal(err)
	}
	data, err := app.GetTableData("main", "customers", 10, 0, "Acme Labs", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if data.Total != 1 || data.Rows[0][3] != "Acme Labs" {
		t.Fatalf("updated value was not returned: %#v", data)
	}
}

func TestApplyStagedChanges(t *testing.T) {
	app := openTestApp(t)
	operations := []RowOperation{
		{Type: "update", Values: map[string]any{"company": "Yellow Draft"}, PrimaryKey: map[string]any{"id": int64(1)}},
		{Type: "insert", Values: map[string]any{"id": 99, "name": "New Record", "email": "new@example.com", "company": "Green Draft", "status": "active", "created_at": "2026-09-03 10:00:00"}},
		{Type: "delete", PrimaryKey: map[string]any{"id": int64(2)}},
	}
	affected, err := app.ApplyChanges("main", "customers", operations)
	if err != nil {
		t.Fatal(err)
	}
	if affected != 3 {
		t.Fatalf("got %d affected rows, want 3", affected)
	}
	data, err := app.GetTableData("main", "customers", 50, 0, "", "id", "asc")
	if err != nil {
		t.Fatal(err)
	}
	if data.Total != 8 {
		t.Fatalf("got total %d after insert and delete, want 8", data.Total)
	}
}

func TestApplyTruncate(t *testing.T) {
	app := openTestApp(t)
	if _, err := app.ApplyChanges("main", "orders", []RowOperation{{Type: "truncate"}}); err != nil {
		t.Fatal(err)
	}
	data, err := app.GetTableData("main", "orders", 10, 0, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if data.Total != 0 {
		t.Fatalf("got %d rows after truncate, want 0", data.Total)
	}
}

func TestSavedSQLiteProfile(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := NewApp()
	if err := app.saveSQLiteProfile("/tmp/example.db", "Example"); err != nil {
		t.Fatal(err)
	}
	profiles, err := app.ListSavedConnections()
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || profiles[0].Name != "Example" || profiles[0].Driver != driverSQLite {
		t.Fatalf("unexpected saved profiles: %#v", profiles)
	}
	if err := app.DeleteSavedConnection(profiles[0].ID); err != nil {
		t.Fatal(err)
	}
}
