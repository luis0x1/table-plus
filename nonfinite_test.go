package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"math"
	"testing"
)

// Exercise the database/sql scan boundary with values PostgreSQL can return.
// SQLite normalizes NaN to NULL, so it cannot cover this case by itself.
type nonFiniteConnector struct{}
type nonFiniteDriver struct{}
type nonFiniteConn struct{}
type nonFiniteRows struct{ done bool }

func (nonFiniteConnector) Connect(context.Context) (driver.Conn, error) { return nonFiniteConn{}, nil }
func (nonFiniteConnector) Driver() driver.Driver                        { return nonFiniteDriver{} }
func (nonFiniteDriver) Open(string) (driver.Conn, error)                { return nonFiniteConn{}, nil }
func (nonFiniteConn) Prepare(string) (driver.Stmt, error)               { return nil, errors.New("not used") }
func (nonFiniteConn) Close() error                                      { return nil }
func (nonFiniteConn) Begin() (driver.Tx, error)                         { return nil, errors.New("not used") }
func (nonFiniteConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return &nonFiniteRows{}, nil
}
func (*nonFiniteRows) Columns() []string {
	return []string{"positive", "negative", "nan", "finite", "null_value", "text"}
}
func (*nonFiniteRows) Close() error { return nil }
func (r *nonFiniteRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	copy(dest, []driver.Value{math.Inf(1), math.Inf(-1), math.NaN(), 1.25, nil, "+Inf"})
	return nil
}

func TestNonFiniteResultsRemainJSONSafe(t *testing.T) {
	db := sql.OpenDB(nonFiniteConnector{})
	defer db.Close()
	for _, scan := range []struct {
		name string
		read func(*sql.Rows) (TableData, error)
	}{
		{"table", scanRows},
		{"query", func(rows *sql.Rows) (TableData, error) { return scanRowsLimited(rows, 1000) }},
	} {
		t.Run(scan.name, func(t *testing.T) {
			rows, err := db.QueryContext(context.Background(), "SELECT special_values")
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			data, err := scan.read(rows)
			if err != nil {
				t.Fatal(err)
			}
			if len(data.Rows) != 1 {
				t.Fatalf("rows: %v", data.Rows)
			}
			for i, want := range []string{"+Inf", "-Inf", "NaN"} {
				if got := data.Rows[0][i]; got != (WireValue{Type: "float64", Value: want}) {
					t.Fatalf("column %d: got %#v, want %s", i, got, want)
				}
			}
			if data.Rows[0][3] != 1.25 || data.Rows[0][4] != nil || data.Rows[0][5] != "+Inf" {
				t.Fatalf("ordinary values changed: %#v", data.Rows[0])
			}
			for _, payload := range []any{data, QueryResult{Columns: data.Columns, Rows: data.Rows}} {
				if _, err := json.Marshal(payload); err != nil {
					t.Fatalf("Wails response cannot serialize: %v", err)
				}
			}
			wire, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			var decoded TableData
			if err := json.Unmarshal(wire, &decoded); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 3; i++ {
				value, err := decodeWireValue(decoded.Rows[0][i])
				if err != nil {
					t.Fatal(err)
				}
				got, ok := value.(float64)
				if !ok || (i == 0 && !math.IsInf(got, 1)) || (i == 1 && !math.IsInf(got, -1)) || (i == 2 && !math.IsNaN(got)) {
					t.Fatalf("special value lost after JSON round trip: %#v", value)
				}
			}
		})
	}
}

func TestNonFiniteViewAndConsoleResponses(t *testing.T) {
	app := openTestApp(t)
	if _, err := app.db.Exec("CREATE VIEW special_values AS SELECT 1e999 AS positive, -1e999 AS negative"); err != nil {
		t.Fatal(err)
	}
	data, err := app.GetTableData("main", "special_values", 50, 0, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	result, err := app.ExecuteQuery("SELECT * FROM special_values")
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range []any{data, result} {
		if _, err := json.Marshal(payload); err != nil {
			t.Fatalf("response cannot serialize: %v", err)
		}
	}
	if data.Rows[0][0] != (WireValue{Type: "float64", Value: "+Inf"}) ||
		result.Rows[0][1] != (WireValue{Type: "float64", Value: "-Inf"}) {
		t.Fatalf("non-finite values were lost: %#v / %#v", data.Rows, result.Rows)
	}
}

func TestDecodeWireFloatRejectsInvalidPayload(t *testing.T) {
	for _, value := range []any{
		WireValue{Type: "float64", Value: "1.5"},
		WireValue{Type: "float64", Value: "Infinity"},
		map[string]any{"type": "float64", "value": 42},
		map[string]any{"type": "float64", "value": "garbage"},
	} {
		if _, err := decodeWireValue(value); err == nil {
			t.Fatalf("accepted invalid wire value: %#v", value)
		}
	}
}
