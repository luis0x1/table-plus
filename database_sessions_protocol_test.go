package main

import (
	"net"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgproto3"
)

// Minimal PostgreSQL protocol server for exercising real pgx connection setup
// and catalog queries without requiring a running database service.
func startSessionPostgres(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Add(1)
			go func() { defer workers.Done(); serveSessionPostgres(conn) }()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); workers.Wait() })
	return listener.Addr().(*net.TCPAddr).Port
}

func serveSessionPostgres(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	backend := pgproto3.NewBackend(conn, conn)
	message, err := backend.ReceiveStartupMessage()
	if err != nil {
		return
	}
	startup, ok := message.(*pgproto3.StartupMessage)
	if !ok {
		return
	}
	if startup.Parameters["database"] == "broken" {
		backend.Send(&pgproto3.ErrorResponse{Severity: "FATAL", Code: "3D000", Message: "database unavailable"})
		_ = backend.Flush()
		return
	}
	backend.Send(&pgproto3.AuthenticationOk{})
	backend.Send(&pgproto3.ParameterStatus{Name: "server_version", Value: "16.0"})
	backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
	if backend.Flush() != nil {
		return
	}
	columns := &pgproto3.RowDescription{Fields: []pgproto3.FieldDescription{{Name: []byte("datname"), DataTypeOID: 25, DataTypeSize: -1, TypeModifier: -1}}}
	rows := func() {
		for _, name := range []string{"analytics", "appdb", "broken"} {
			backend.Send(&pgproto3.DataRow{Values: [][]byte{[]byte(name)}})
		}
		backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("SELECT 3")})
	}
	for {
		message, err := backend.Receive()
		if err != nil {
			return
		}
		switch message := message.(type) {
		case *pgproto3.Query:
			if message.String == "-- ping" {
				backend.Send(&pgproto3.EmptyQueryResponse{})
			} else {
				backend.Send(columns)
				rows()
			}
			backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
		case *pgproto3.Parse:
			backend.Send(&pgproto3.ParseComplete{})
		case *pgproto3.Describe:
			if message.ObjectType == 'S' {
				backend.Send(&pgproto3.ParameterDescription{})
			}
			backend.Send(columns)
		case *pgproto3.Bind:
			backend.Send(&pgproto3.BindComplete{})
		case *pgproto3.Execute:
			rows()
		case *pgproto3.Sync:
			backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
		case *pgproto3.Close:
			backend.Send(&pgproto3.CloseComplete{})
		case *pgproto3.Terminate:
			return
		}
		if backend.Flush() != nil {
			return
		}
	}
}
