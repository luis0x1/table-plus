package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Each workspace owns an App with a fixed connection. All workspace operations
// carry its ID so an in-flight read or write can never follow a UI tab switch.
func (a *App) openSession(connect func(*App) (ConnectionStatus, error)) (ConnectionStatus, error) {
	child := NewApp()
	child.ctx, child.profilesMu, child.dataDirOverride = a.ctx, a.profilesMu, a.dataDirOverride
	status, err := connect(child)
	if err != nil || !status.Connected {
		_ = child.closeDB()
		return ConnectionStatus{}, err
	}
	a.sessionsMu.Lock()
	defer a.sessionsMu.Unlock()
	for _, id := range a.sessionOrder {
		current := a.sessions[id]
		if sameDatabaseSession(current, child) {
			_ = child.closeDB()
			return current.GetStatus(), nil
		}
	}
	child.sessionID = newConnectionID()
	a.sessions[child.sessionID] = child
	a.sessionOrder = append(a.sessionOrder, child.sessionID)
	return child.GetStatus(), nil
}

func sameDatabaseSession(left, right *App) bool {
	l, r := left.GetStatus(), right.GetStatus()
	if l.Driver != r.Driver || l.Path != r.Path || l.ReadOnly != r.ReadOnly {
		return false
	}
	if l.Driver == driverSQLite {
		return true
	}
	return left.postgresConfig.User == right.postgresConfig.User && left.postgresConfig.SSLMode == right.postgresConfig.SSLMode
}

func (a *App) OpenSQLiteSession(path string) (ConnectionStatus, error) {
	return a.openSession(func(child *App) (ConnectionStatus, error) { return child.ConnectSQLite(path) })
}

func (a *App) ChooseSQLiteSession() (ConnectionStatus, error) {
	return a.openSession(func(child *App) (ConnectionStatus, error) { return child.ChooseSQLiteFile() })
}

func (a *App) OpenDemoSession() (ConnectionStatus, error) {
	return a.openSession(func(child *App) (ConnectionStatus, error) { return child.ConnectDemo() })
}

func (a *App) OpenPostgresSession(config PostgresConfig) (ConnectionStatus, error) {
	var err error
	config, err = a.restoreSavedPassword(config)
	if err != nil {
		return ConnectionStatus{}, err
	}
	return a.openSession(func(child *App) (ConnectionStatus, error) { return child.ConnectPostgres(config) })
}

func (a *App) OpenSavedSession(id, password string) (ConnectionStatus, error) {
	return a.openSession(func(child *App) (ConnectionStatus, error) { return child.ConnectSavedConnection(id, password) })
}

func (a *App) ListDatabaseSessions() []ConnectionStatus {
	a.sessionsMu.RLock()
	defer a.sessionsMu.RUnlock()
	result := make([]ConnectionStatus, 0, len(a.sessionOrder))
	for _, id := range a.sessionOrder {
		result = append(result, a.sessions[id].GetStatus())
	}
	return result
}

func (a *App) databaseSession(id string) (*App, error) {
	a.sessionsMu.RLock()
	defer a.sessionsMu.RUnlock()
	child, ok := a.sessions[id]
	if !ok {
		return nil, errors.New("database session is closed or does not exist")
	}
	return child, nil
}

func (a *App) CloseDatabaseSession(id string) error {
	a.sessionsMu.Lock()
	child, ok := a.sessions[id]
	if !ok {
		a.sessionsMu.Unlock()
		return errors.New("database session is closed or does not exist")
	}
	delete(a.sessions, id)
	a.sessionOrder = slices.DeleteFunc(a.sessionOrder, func(current string) bool { return current == id })
	a.sessionsMu.Unlock()
	return child.closeDB()
}

func (a *App) closeAllSessions() {
	a.sessionsMu.Lock()
	children := a.sessions
	a.sessions = make(map[string]*App)
	a.sessionOrder = nil
	a.sessionsMu.Unlock()
	for _, child := range children {
		_ = child.closeDB()
	}
}

func (a *App) ListDatabases(id string) ([]string, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return nil, err
	}
	db, driver, err := child.connection()
	if err != nil {
		return nil, err
	}
	if driver == driverSQLite {
		return []string{child.GetStatus().Database}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, `SELECT datname FROM pg_catalog.pg_database
		WHERE datallowconn AND (NOT datistemplate OR datname = current_database())
		AND has_database_privilege(datname, 'CONNECT') ORDER BY datname`)
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("read database name: %w", err)
		}
		result = append(result, name)
	}
	return result, rows.Err()
}

func normalizeDatabaseName(value string) (string, error) {
	name := strings.TrimSpace(value)
	if name == "" {
		return "", errors.New("database name is required")
	}
	if len([]byte(name)) > 63 {
		return "", errors.New("database name must be at most 63 bytes")
	}
	if strings.ContainsAny(name, "\x00\r\n") {
		return "", errors.New("database name cannot contain control characters")
	}
	return name, nil
}

// CreateDatabase creates a PostgreSQL database from the currently selected
// server connection. SQLite databases are files and continue to use the normal
// open-file flow instead of pretending they live in this server picker.
func (a *App) CreateDatabase(id, value string) error {
	child, err := a.databaseSession(id)
	if err != nil {
		return err
	}
	status := child.GetStatus()
	if status.Driver != driverPostgres {
		return errors.New("create another SQLite database by opening or creating a database file")
	}
	if status.ReadOnly {
		return errors.New("this connection is read-only; reconnect with editing enabled")
	}
	name, err := normalizeDatabaseName(value)
	if err != nil {
		return err
	}
	db, _, err := child.connection()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `CREATE DATABASE `+quoteIdentifier(name)); err != nil {
		return fmt.Errorf("create database %s: %w", name, err)
	}
	return nil
}

func (a *App) OpenDatabase(id, database string) (ConnectionStatus, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return ConnectionStatus{}, err
	}
	if child.GetStatus().Database == database {
		return child.GetStatus(), nil
	}
	child.mu.RLock()
	if child.postgresConfig == nil {
		child.mu.RUnlock()
		return ConnectionStatus{}, errors.New("open another SQLite file using the connection button")
	}
	config := *child.postgresConfig
	child.mu.RUnlock()
	databases, err := a.ListDatabases(id)
	if err != nil {
		return ConnectionStatus{}, err
	}
	if !slices.Contains(databases, database) {
		return ConnectionStatus{}, errors.New("database is not available to this connection")
	}
	config.Database = database
	config.ID, config.SaveConnection, config.SavePassword = "", false, false
	return a.OpenPostgresSession(config)
}

func (a *App) SessionListTables(id string) ([]TableSummary, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return nil, err
	}
	return child.ListTables()
}

func (a *App) SessionCountTableRows(id, schema, table string) (int64, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return 0, err
	}
	return child.CountTableRows(schema, table)
}

func (a *App) SessionGetTableSchema(id, schema, table string) ([]ColumnInfo, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return nil, err
	}
	return child.GetTableSchema(schema, table)
}

func (a *App) SessionGetTableIndexes(id, schema, table string) ([]IndexInfo, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return nil, err
	}
	return child.GetTableIndexes(schema, table)
}

func (a *App) SessionGetTableData(id, schema, table string, limit, offset int, filter, sortColumn, sortDirection string) (TableData, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TableData{}, err
	}
	return child.GetTableData(schema, table, limit, offset, filter, sortColumn, sortDirection)
}

func (a *App) SessionExecuteQuery(id, query string) (QueryResult, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return QueryResult{}, err
	}
	return child.ExecuteQuery(query)
}

func (a *App) SessionExecuteQueryTracked(id, operationID, query string) (QueryResult, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return QueryResult{}, err
	}
	return child.ExecuteQueryTracked(operationID, query)
}

func (a *App) SessionExecuteScriptStatement(id, query string) (QueryResult, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return QueryResult{}, err
	}
	return child.ExecuteScriptStatement(query)
}

func (a *App) SessionExecuteScriptStatementTracked(id, operationID, query string) (QueryResult, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return QueryResult{}, err
	}
	return child.ExecuteScriptStatementTracked(operationID, query)
}

func (a *App) SessionCancelOperation(id, operationID string) (bool, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return false, err
	}
	return child.CancelOperation(operationID), nil
}

func (a *App) SessionApplyChanges(id, schema, table string, operations []RowOperation) (int64, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return 0, err
	}
	return child.ApplyChanges(schema, table, operations)
}

func (a *App) SessionApplyChangesTracked(id, operationID, schema, table string, operations []RowOperation) (int64, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return 0, err
	}
	return child.ApplyChangesTracked(operationID, schema, table, operations)
}

func (a *App) SessionPreviewDatabaseBackup(id string) (TransferPreview, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TransferPreview{}, err
	}
	return child.PreviewDatabaseBackup()
}

func (a *App) SessionBackupDatabase(id string, batchSizeMB int64) (TransferResult, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TransferResult{}, err
	}
	return child.BackupDatabase(batchSizeMB)
}

func (a *App) SessionChooseRestoreBackup(id string) (TransferPreview, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TransferPreview{}, err
	}
	return child.ChooseRestoreBackup()
}

func (a *App) SessionRestoreDatabase(id, path string) (TransferResult, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TransferResult{}, err
	}
	return child.RestoreDatabase(path)
}

func (a *App) SessionPreviewTableExport(id string, tables []TableRef) (TransferPreview, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TransferPreview{}, err
	}
	return child.PreviewTableExport(tables)
}

func (a *App) SessionExportTables(id string, tables []TableRef, format string) (TransferResult, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TransferResult{}, err
	}
	return child.ExportTables(tables, format)
}

func (a *App) SessionChooseTableImport(id string, table TableRef) (TransferPreview, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TransferPreview{}, err
	}
	return child.ChooseTableImport(table)
}

func (a *App) SessionImportTable(id string, table TableRef, path, conflict string) (TransferResult, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return TransferResult{}, err
	}
	return child.ImportTable(table, path, conflict)
}

func (a *App) SessionTruncateTables(id string, tables []TableRef) (int64, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return 0, err
	}
	return child.TruncateTables(tables)
}

func (a *App) SessionTruncateTablesTracked(id, operationID string, tables []TableRef) (int64, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return 0, err
	}
	return child.TruncateTablesTracked(operationID, tables)
}

func (a *App) SessionScriptWorkspacePath(id string) (string, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return "", err
	}
	return child.ScriptWorkspacePath()
}

func (a *App) SessionListScripts(id string) ([]ScriptFile, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return nil, err
	}
	return child.ListScripts()
}

func (a *App) SessionReadScript(id, name string) (string, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return "", err
	}
	return child.ReadScript(name)
}

func (a *App) SessionCreateScript(id, name string) (ScriptFile, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return ScriptFile{}, err
	}
	return child.CreateScript(name)
}

func (a *App) SessionSaveScript(id, name, content string) (ScriptFile, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return ScriptFile{}, err
	}
	return child.SaveScript(name, content)
}

func (a *App) SessionRenameScript(id, from, to string) (ScriptFile, error) {
	child, err := a.databaseSession(id)
	if err != nil {
		return ScriptFile{}, err
	}
	return child.RenameScript(from, to)
}

func (a *App) SessionDeleteScript(id, name string) error {
	child, err := a.databaseSession(id)
	if err != nil {
		return err
	}
	return child.DeleteScript(name)
}
