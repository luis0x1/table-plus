package main

import (
	"net"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgproto3"
)

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
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			t.Setenv("APPDATA", t.TempDir())
			app := openTestApp(t)
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
			path, err := connectionProfilesPath()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("test must not save a connection profile; stat error: %v", err)
			}
		})
	}
}
