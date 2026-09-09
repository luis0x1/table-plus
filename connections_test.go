package main

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgproto3"
)

func TestUpdateSavedConnection(t *testing.T) {
	app := NewApp()
	app.dataDirOverride = t.TempDir()
	sqlitePath := filepath.Join(t.TempDir(), "original.db")
	updatedSQLitePath := filepath.Join(t.TempDir(), "updated.db")
	if err := seedDemo(sqlitePath); err != nil {
		t.Fatal(err)
	}
	if err := seedDemo(updatedSQLitePath); err != nil {
		t.Fatal(err)
	}
	if err := app.writeConnectionProfiles([]SavedConnection{
		{ID: "sqlite", Name: "Original", Driver: driverSQLite, Path: sqlitePath},
		{ID: "postgres", Name: "Original PG", Driver: driverPostgres, Host: "localhost", Port: 5432, User: "postgres", Database: "app", SSLMode: "prefer", HasPassword: true},
	}); err != nil {
		t.Fatal(err)
	}
	if err := app.UpdateSavedConnection(SavedConnectionUpdate{ID: "sqlite", Name: "Renamed", Driver: driverSQLite, Path: updatedSQLitePath}); err != nil {
		t.Fatal(err)
	}
	if err := app.UpdateSavedConnection(SavedConnectionUpdate{ID: "postgres", Name: "Production", Driver: driverPostgres, Host: " db.example.com ", User: " app_user ", Database: " main ", ReadOnly: true, SavePassword: true}); err != nil {
		t.Fatal(err)
	}
	profiles, err := app.ListSavedConnections()
	if err != nil {
		t.Fatal(err)
	}
	if profiles[0].Name != "Renamed" || profiles[0].Path != updatedSQLitePath {
		t.Fatalf("SQLite profile was not updated: %#v", profiles[0])
	}
	postgres := profiles[1]
	if postgres.Name != "Production" || postgres.Host != "db.example.com" || postgres.Port != 5432 || postgres.User != "app_user" || postgres.Database != "main" || postgres.SSLMode != "prefer" || !postgres.ReadOnly || !postgres.HasPassword {
		t.Fatalf("PostgreSQL profile was not updated safely: %#v", postgres)
	}
	data, err := os.ReadFile(filepath.Join(app.dataDirOverride, "connections.json"))
	if err != nil || strings.Contains(string(data), `"password"`) {
		t.Fatalf("connection JSON must not contain a password: %s, %v", data, err)
	}
	if err := app.UpdateSavedConnection(SavedConnectionUpdate{ID: "sqlite", Driver: driverPostgres}); err == nil {
		t.Fatal("saved connection driver change must be rejected")
	}
}

func TestPostgresConnectionValidation(t *testing.T) {
	app := openTestApp(t)
	before := app.GetStatus()
	for _, input := range []PostgresConfig{
		{},
		{Host: "localhost", User: "postgres", Database: "postgres", Port: 70000},
		{Host: "localhost", User: "postgres", Database: "postgres", SSLMode: "sometimes"},
	} {
		if err := app.TestPostgresConnection(input); err == nil {
			t.Fatalf("expected invalid configuration to fail: %#v", input)
		}
	}
	if got := app.GetStatus(); got != before {
		t.Fatalf("testing changed active connection: %#v", got)
	}
}

func TestPostgresConnectionDoesNotReplaceOrSave(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("isolating the profile directory requires XDG_CONFIG_HOME or APPDATA")
	}
	for _, reject := range []bool{false, true} {
		name := "success"
		if reject {
			name = "authentication failure"
		}
		t.Run(name, func(t *testing.T) {
			app := openTestApp(t)
			app.dataDirOverride = t.TempDir()
			before := app.GetStatus()
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = listener.Close() })
			done := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					done <- err
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				backend := pgproto3.NewBackend(conn, conn)
				if _, err := backend.ReceiveStartupMessage(); err != nil {
					done <- err
					return
				}
				if reject {
					backend.Send(&pgproto3.ErrorResponse{Severity: "FATAL", Code: "28P01", Message: "password authentication failed"})
					done <- backend.Flush()
					return
				}
				backend.Send(&pgproto3.AuthenticationOk{})
				backend.Send(&pgproto3.ParameterStatus{Name: "server_version", Value: "16.0"})
				backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
				if err := backend.Flush(); err != nil {
					done <- err
					return
				}
				for {
					message, err := backend.Receive()
					if err != nil {
						done <- err
						return
					}
					switch message.(type) {
					case *pgproto3.Query:
						backend.Send(&pgproto3.EmptyQueryResponse{})
						backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
						if err := backend.Flush(); err != nil {
							done <- err
							return
						}
					case *pgproto3.Terminate:
						done <- nil
						return
					}
				}
			}()
			err = app.TestPostgresConnection(PostgresConfig{
				Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port,
				User: "test", Database: "test", SSLMode: "disable", SaveConnection: true,
			})
			if reject {
				if err == nil || !strings.Contains(err.Error(), "password authentication failed") {
					t.Fatalf("expected authentication error, got %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatalf("test PostgreSQL server: %v", err)
			}
			if got := app.GetStatus(); got != before {
				t.Fatalf("testing replaced active connection: %#v", got)
			}
			if _, err := app.ListTables(); err != nil {
				t.Fatalf("active database is no longer usable: %v", err)
			}
			path, err := app.connectionProfilesPath()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("test must not save a connection profile; stat error: %v", err)
			}
		})
	}
}
