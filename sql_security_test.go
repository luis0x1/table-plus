package main

import "testing"

func TestConsoleStatementOperation(t *testing.T) {
	tests := []struct {
		query string
		want  string
	}{
		{`SELECT ';'`, "select"},
		{"-- comment\nWITH RECURSIVE n(v) AS (SELECT 1) SELECT v FROM n;", "select"},
		{`WITH source AS (SELECT $$delete;update$$) DELETE FROM target`, "delete"},
		{`/* outer /* inner */ comment */ SELECT 1`, "select"},
	}
	for _, test := range tests {
		got, err := consoleStatementOperation(test.query)
		if err != nil || got != test.want {
			t.Errorf("consoleStatementOperation(%q) = %q, %v; want %q", test.query, got, err, test.want)
		}
	}
	if _, err := consoleStatementOperation(`SELECT 1; SELECT 2`); err == nil {
		t.Fatal("stacked statements were accepted")
	}
}
