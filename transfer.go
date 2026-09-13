package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	queryNestBackupFormat = "querynest-backup"
	queryNestExportFormat = "querynest-table-export"
	// Version 2 archives the source database's own DDL. Version 1 backups only
	// carried introspected column metadata and are still readable.
	queryNestBackupVersion = 2
	queryNestFormatVersion = 1
	previewRowLimit        = 5
)

type TableRef struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
}

type TransferTablePreview struct {
	Schema          string   `json:"schema"`
	Name            string   `json:"name"`
	Columns         []string `json:"columns"`
	TargetColumns   []string `json:"targetColumns"`
	MissingColumns  []string `json:"missingColumns"`
	ExtraColumns    []string `json:"extraColumns"`
	RequiredMissing []string `json:"requiredMissing"`
	SampleRows      [][]any  `json:"sampleRows"`
	Rows            int64    `json:"rows"`
}

// TransferSkippedTable names an object a backup cannot archive, so the preview
// can say so before the user commits to the operation.
type TransferSkippedTable struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type TransferPreview struct {
	Kind       string                 `json:"kind"`
	Path       string                 `json:"path"`
	Format     string                 `json:"format"`
	Driver     string                 `json:"driver"`
	Database   string                 `json:"database"`
	Tables     []TransferTablePreview `json:"tables"`
	Skipped    []TransferSkippedTable `json:"skipped,omitempty"`
	Statements int                    `json:"statements,omitempty"`
}

type TransferResult struct {
	Path       string `json:"path"`
	Tables     int    `json:"tables"`
	Rows       int64  `json:"rows"`
	Skipped    int64  `json:"skipped"`
	Statements int    `json:"statements,omitempty"`
}

type backupValue struct {
	Kind string `json:"kind"`
	Data string `json:"data,omitempty"`
}

type backupColumn struct {
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Nullable   bool    `json:"nullable"`
	PrimaryKey bool    `json:"primaryKey"`
	Default    *string `json:"default,omitempty"`
}

type backupTable struct {
	Schema           string         `json:"schema"`
	Name             string         `json:"name"`
	Columns          []backupColumn `json:"columns"`
	Indexes          []IndexInfo    `json:"indexes"`
	Rows             int64          `json:"rows"`
	IdentityOverride bool           `json:"identityOverride,omitempty"`
}

type backupEnum struct {
	Schema string   `json:"schema"`
	Name   string   `json:"name"`
	Values []string `json:"values"`
}

type backupManifest struct {
	Kind      string         `json:"kind"`
	Format    string         `json:"format"`
	Version   int            `json:"version"`
	Driver    string         `json:"driver"`
	Database  string         `json:"database"`
	CreatedAt string         `json:"createdAt"`
	Tables    []backupTable  `json:"tables"`
	Enums     []backupEnum   `json:"enums,omitempty"`
	Objects   []backupObject `json:"objects,omitempty"`
}

type backupRecord struct {
	Kind  string        `json:"kind"`
	Table int           `json:"table,omitempty"`
	Rows  int64         `json:"rows,omitempty"`
	Bytes int64         `json:"bytes,omitempty"`
	Value []backupValue `json:"value,omitempty"`
}

type tableExport struct {
	Schema  string   `json:"schema"`
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
}

type tableExportFile struct {
	Format  string        `json:"format"`
	Version int           `json:"version"`
	Tables  []tableExport `json:"tables"`
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (w *countingWriter) Write(data []byte) (int, error) {
	n, err := w.w.Write(data)
	w.n += int64(n)
	return n, err
}

func previewColumns(columns []ColumnInfo) []string {
	result := make([]string, len(columns))
	for i, column := range columns {
		result[i] = column.Name
	}
	return result
}

func (a *App) PreviewDatabaseBackup() (TransferPreview, error) {
	db, driver, err := a.connection()
	if err != nil {
		return TransferPreview{}, err
	}
	tables, err := a.ListTables()
	if err != nil {
		return TransferPreview{}, fmt.Errorf("preview backup: %w", err)
	}
	virtual, available := map[string]string{}, map[string]bool{}
	if driver != driverPostgres {
		if virtual, err = sqliteVirtualTables(db); err != nil {
			return TransferPreview{}, fmt.Errorf("preview backup: %w", err)
		}
		if available, err = sqliteAvailableModules(db); err != nil {
			return TransferPreview{}, fmt.Errorf("preview backup: %w", err)
		}
	}
	preview := TransferPreview{Kind: "backup", Driver: a.GetStatus().Driver, Database: a.GetStatus().Database, Tables: make([]TransferTablePreview, 0), Skipped: make([]TransferSkippedTable, 0)}
	for _, table := range tables {
		if table.Type != "table" {
			continue
		}
		// A virtual table's rows come from its module, and without that module
		// loaded it cannot even be introspected. Skipping it keeps one such table
		// from failing the whole backup, and the preview reports every skip.
		if module, ok := virtual[table.Name]; ok {
			reason := fmt.Sprintf("virtual table provided by the SQLite module %s; its rows are derived rather than stored, so recreate it after restoring", module)
			if !available[strings.ToLower(module)] {
				reason = fmt.Sprintf("virtual table needs the SQLite module %s, which this build does not provide; it cannot be read at all", module)
			}
			preview.Skipped = append(preview.Skipped, TransferSkippedTable{Schema: table.Schema, Name: table.Name, Reason: reason})
			continue
		}
		columns, err := a.GetTableSchema(table.Schema, table.Name)
		if err != nil {
			return TransferPreview{}, fmt.Errorf("preview %s.%s: %w", table.Schema, table.Name, err)
		}
		rows, err := a.CountTableRows(table.Schema, table.Name)
		if err != nil {
			return TransferPreview{}, fmt.Errorf("count %s.%s: %w", table.Schema, table.Name, err)
		}
		preview.Tables = append(preview.Tables, TransferTablePreview{Schema: table.Schema, Name: table.Name, Columns: previewColumns(columns), SampleRows: make([][]any, 0), Rows: rows})
	}
	return preview, nil
}

func (a *App) BackupDatabase(batchSizeMB int64) (TransferResult, error) {
	if batchSizeMB < 1 || batchSizeMB > 10240 {
		return TransferResult{}, errors.New("backup batch size must be between 1 MB and 10 GB")
	}
	status := a.GetStatus()
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Back up database",
		DefaultFilename: status.Database + ".qnb",
		Filters:         []runtime.FileFilter{{DisplayName: "QueryNest backup (*.qnb)", Pattern: "*.qnb"}},
	})
	if err != nil || path == "" {
		return TransferResult{}, err
	}
	if !strings.EqualFold(filepath.Ext(path), ".qnb") {
		path += ".qnb"
	}
	return a.writeDatabaseBackup(path, batchSizeMB*1024*1024)
}

func (a *App) writeDatabaseBackup(finalPath string, batchBytes int64) (result TransferResult, returnedErr error) {
	if batchBytes <= 0 {
		return result, errors.New("backup batch size must be positive")
	}
	db, driver, err := a.connection()
	if err != nil {
		return result, err
	}
	preview, err := a.PreviewDatabaseBackup()
	if err != nil {
		return result, err
	}
	manifest := backupManifest{Kind: "manifest", Format: queryNestBackupFormat, Version: queryNestBackupVersion, Driver: driver, Database: preview.Database, CreatedAt: time.Now().UTC().Format(time.RFC3339), Tables: make([]backupTable, 0, len(preview.Tables))}
	if driver == driverPostgres {
		manifest.Enums, err = postgresBackupEnums(db)
		if err != nil {
			return result, fmt.Errorf("inspect PostgreSQL enum types: %w", err)
		}
	}
	for _, item := range preview.Tables {
		columns, err := a.GetTableSchema(item.Schema, item.Name)
		if err != nil {
			return result, fmt.Errorf("inspect %s.%s: %w", item.Schema, item.Name, err)
		}
		indexes, err := a.GetTableIndexes(item.Schema, item.Name)
		if err != nil {
			return result, fmt.Errorf("inspect indexes for %s.%s: %w", item.Schema, item.Name, err)
		}
		generated := map[string]bool{}
		identityOverride := false
		if driver == driverPostgres {
			generated, identityOverride, err = postgresColumnTraits(db, item.Schema, item.Name)
			if err != nil {
				return result, err
			}
		}
		archived := make([]backupColumn, 0, len(columns))
		for _, column := range columns {
			// A generated column is derived from the others, so it is neither read
			// nor written; the restored table definition recomputes it.
			if generated[column.Name] {
				continue
			}
			entry := backupColumn{Name: column.Name, Type: column.Type, Nullable: column.Nullable, PrimaryKey: column.PrimaryKey}
			if column.Default != nil {
				value := fmt.Sprint(column.Default)
				entry.Default = &value
			}
			archived = append(archived, entry)
		}
		manifest.Tables = append(manifest.Tables, backupTable{Schema: item.Schema, Name: item.Name, Columns: archived, Indexes: indexes, Rows: item.Rows, IdentityOverride: identityOverride})
	}
	manifest.Objects, err = backupSchemaObjects(db, driver, manifest.Tables)
	if err != nil {
		return result, err
	}
	backupContext := a.ctx
	if backupContext == nil {
		backupContext = context.Background()
	}
	tx, err := db.BeginTx(backupContext, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelSerializable})
	if err != nil {
		return result, fmt.Errorf("begin consistent backup snapshot: %w", err)
	}
	defer tx.Rollback()
	for i := range manifest.Tables {
		table := &manifest.Tables[i]
		if err := tx.QueryRow(`SELECT count(*) FROM ` + qualifiedIdentifier(table.Schema, table.Name)).Scan(&table.Rows); err != nil {
			return result, fmt.Errorf("count %s.%s for backup: %w", table.Schema, table.Name, err)
		}
	}
	pendingPath := strings.TrimSuffix(finalPath, filepath.Ext(finalPath)) + ".pqnb"
	file, err := os.OpenFile(pendingPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return result, fmt.Errorf("create pending backup: %w", err)
	}
	completed := false
	fileClosed := false
	defer func() {
		if !fileClosed {
			closeErr := file.Close()
			if returnedErr == nil && closeErr != nil {
				returnedErr = fmt.Errorf("close pending backup: %w", closeErr)
			}
		}
		if !completed {
			result.Path = pendingPath
			if returnedErr != nil {
				returnedErr = fmt.Errorf("%w; processed backup data remains in %s", returnedErr, pendingPath)
			}
		}
	}()
	buffered := bufio.NewWriterSize(file, 256*1024)
	compressed := gzip.NewWriter(buffered)
	counted := &countingWriter{w: compressed}
	encoder := json.NewEncoder(counted)
	if err := encoder.Encode(manifest); err != nil {
		return result, fmt.Errorf("write backup manifest: %w", err)
	}
	lastCheckpoint := counted.n
	var processed int64
	for tableIndex, table := range manifest.Tables {
		names := make([]string, len(table.Columns))
		for i, column := range table.Columns {
			names[i] = quoteIdentifier(column.Name)
		}
		rows, err := tx.Query(`SELECT ` + strings.Join(names, ", ") + ` FROM ` + qualifiedIdentifier(table.Schema, table.Name))
		if err != nil {
			return result, fmt.Errorf("read %s.%s: %w", table.Schema, table.Name, err)
		}
		for rows.Next() {
			values := make([]any, len(table.Columns))
			pointers := make([]any, len(values))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err := rows.Scan(pointers...); err != nil {
				_ = rows.Close()
				return result, fmt.Errorf("read row from %s.%s: %w", table.Schema, table.Name, err)
			}
			record := backupRecord{Kind: "row", Table: tableIndex, Value: make([]backupValue, len(values))}
			for i, value := range values {
				record.Value[i] = encodeBackupValue(value)
			}
			if err := encoder.Encode(record); err != nil {
				_ = rows.Close()
				return result, fmt.Errorf("write row from %s.%s: %w", table.Schema, table.Name, err)
			}
			processed++
			if counted.n-lastCheckpoint >= batchBytes {
				if err := encoder.Encode(backupRecord{Kind: "checkpoint", Table: tableIndex, Rows: processed, Bytes: counted.n}); err != nil {
					_ = rows.Close()
					return result, fmt.Errorf("write backup checkpoint: %w", err)
				}
				if err := compressed.Flush(); err != nil {
					_ = rows.Close()
					return result, fmt.Errorf("compress backup batch: %w", err)
				}
				if err := buffered.Flush(); err != nil {
					_ = rows.Close()
					return result, fmt.Errorf("flush backup batch: %w", err)
				}
				if err := file.Sync(); err != nil {
					_ = rows.Close()
					return result, fmt.Errorf("sync backup batch: %w", err)
				}
				lastCheckpoint = counted.n
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return result, fmt.Errorf("read %s.%s: %w", table.Schema, table.Name, err)
		}
		if err := rows.Close(); err != nil {
			return result, fmt.Errorf("close %s.%s backup rows: %w", table.Schema, table.Name, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return result, fmt.Errorf("finish backup snapshot: %w", err)
	}
	if err := encoder.Encode(backupRecord{Kind: "complete", Rows: processed, Bytes: counted.n}); err != nil {
		return result, fmt.Errorf("finish backup: %w", err)
	}
	if err := compressed.Close(); err != nil {
		return result, fmt.Errorf("finish backup compression: %w", err)
	}
	if err := buffered.Flush(); err != nil {
		return result, fmt.Errorf("flush backup: %w", err)
	}
	if err := file.Sync(); err != nil {
		return result, fmt.Errorf("sync backup: %w", err)
	}
	if err := file.Close(); err != nil {
		return result, fmt.Errorf("close backup: %w", err)
	}
	fileClosed = true
	if err := os.Rename(pendingPath, finalPath); err != nil {
		return result, fmt.Errorf("complete backup: %w", err)
	}
	completed = true
	return TransferResult{Path: finalPath, Tables: len(manifest.Tables), Rows: processed}, nil
}

func encodeBackupValue(value any) backupValue {
	switch value := value.(type) {
	case nil:
		return backupValue{Kind: "null"}
	case int64:
		return backupValue{Kind: "int", Data: strconv.FormatInt(value, 10)}
	case int:
		return backupValue{Kind: "int", Data: strconv.Itoa(value)}
	case float64:
		return backupValue{Kind: "float", Data: strconv.FormatFloat(value, 'g', -1, 64)}
	case bool:
		return backupValue{Kind: "bool", Data: strconv.FormatBool(value)}
	case []byte:
		return backupValue{Kind: "bytes", Data: base64.StdEncoding.EncodeToString(value)}
	case time.Time:
		return backupValue{Kind: "time", Data: value.Format(time.RFC3339Nano)}
	default:
		return backupValue{Kind: "string", Data: fmt.Sprint(value)}
	}
}

func decodeBackupValue(value backupValue) (any, error) {
	switch value.Kind {
	case "null":
		return nil, nil
	case "int":
		return strconv.ParseInt(value.Data, 10, 64)
	case "float":
		return strconv.ParseFloat(value.Data, 64)
	case "bool":
		return strconv.ParseBool(value.Data)
	case "bytes":
		return base64.StdEncoding.DecodeString(value.Data)
	case "time":
		return time.Parse(time.RFC3339Nano, value.Data)
	case "string":
		return value.Data, nil
	default:
		return nil, fmt.Errorf("unsupported backup value type %q", value.Kind)
	}
}

func (a *App) ChooseRestoreBackup() (TransferPreview, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: "Restore database", Filters: []runtime.FileFilter{
		{DisplayName: "Database backup (*.qnb;*.sql)", Pattern: "*.qnb;*.sql"},
		{DisplayName: "SQL dump (*.sql)", Pattern: "*.sql"},
		{DisplayName: "QueryNest backup (*.qnb)", Pattern: "*.qnb"},
	}})
	if err != nil || path == "" {
		return TransferPreview{}, err
	}
	if strings.EqualFold(filepath.Ext(path), ".pqnb") {
		return TransferPreview{}, errors.New("pending .pqnb backups are incomplete and cannot be restored")
	}
	if strings.EqualFold(filepath.Ext(path), ".sql") {
		status := a.GetStatus()
		return previewSQLRestore(path, status.Driver, status.Database)
	}
	if !strings.EqualFold(filepath.Ext(path), ".qnb") {
		return TransferPreview{}, errors.New("restore supports completed .qnb backups and .sql dumps")
	}
	manifest, _, err := readBackupManifest(path)
	if err != nil {
		return TransferPreview{}, err
	}
	preview := TransferPreview{Kind: "restore", Path: path, Format: manifest.Format, Driver: manifest.Driver, Database: manifest.Database, Tables: make([]TransferTablePreview, len(manifest.Tables))}
	for i, table := range manifest.Tables {
		columns := make([]string, len(table.Columns))
		for j, column := range table.Columns {
			columns[j] = column.Name
		}
		preview.Tables[i] = TransferTablePreview{Schema: table.Schema, Name: table.Name, Columns: columns, Rows: table.Rows}
	}
	return preview, nil
}

func readBackupManifest(path string) (backupManifest, io.ReadCloser, error) {
	file, err := os.Open(path)
	if err != nil {
		return backupManifest{}, nil, fmt.Errorf("open backup: %w", err)
	}
	compressed, err := gzip.NewReader(file)
	if err != nil {
		_ = file.Close()
		return backupManifest{}, nil, fmt.Errorf("open backup compression: %w", err)
	}
	decoder := json.NewDecoder(compressed)
	var manifest backupManifest
	if err := decoder.Decode(&manifest); err != nil {
		_ = compressed.Close()
		_ = file.Close()
		return backupManifest{}, nil, fmt.Errorf("read backup manifest: %w", err)
	}
	if manifest.Kind != "manifest" || manifest.Format != queryNestBackupFormat || manifest.Version < 1 || manifest.Version > queryNestBackupVersion {
		_ = compressed.Close()
		_ = file.Close()
		return backupManifest{}, nil, errors.New("unsupported QueryNest backup format")
	}
	return manifest, &backupReadCloser{Decoder: decoder, compressed: compressed, file: file}, nil
}

type backupReadCloser struct {
	*json.Decoder
	compressed *gzip.Reader
	file       *os.File
}

func (r *backupReadCloser) Read(data []byte) (int, error) {
	return 0, errors.New("backup reader only supports JSON decoding")
}
func (r *backupReadCloser) Close() error {
	err := r.compressed.Close()
	if fileErr := r.file.Close(); err == nil {
		err = fileErr
	}
	return err
}

func backupDecoder(reader io.ReadCloser) *json.Decoder {
	return reader.(*backupReadCloser).Decoder
}

func (a *App) RestoreDatabase(path string) (TransferResult, error) {
	if strings.EqualFold(filepath.Ext(path), ".sql") {
		return a.restoreSQLDatabase(path)
	}
	if !strings.EqualFold(filepath.Ext(path), ".qnb") {
		return TransferResult{}, errors.New("restore supports completed .qnb backups and .sql dumps")
	}
	db, driver, readOnly, err := a.editableConnection()
	if err != nil {
		return TransferResult{}, err
	}
	if readOnly {
		return TransferResult{}, errors.New("this connection is read-only; reconnect with editing enabled")
	}
	manifest, reader, err := readBackupManifest(path)
	if err != nil {
		return TransferResult{}, err
	}
	defer reader.Close()
	if manifest.Driver != driver {
		return TransferResult{}, fmt.Errorf("backup uses %s but this database uses %s", manifest.Driver, driver)
	}
	tx, err := db.Begin()
	if err != nil {
		return TransferResult{}, fmt.Errorf("begin restore: %w", err)
	}
	rollback := func(err error) (TransferResult, error) { _ = tx.Rollback(); return TransferResult{}, err }
	if driver == driverPostgres {
		for _, enum := range manifest.Enums {
			if err := restorePostgresEnum(tx, enum); err != nil {
				return rollback(err)
			}
		}
	}
	for _, object := range manifest.Objects {
		if err := validateBackupObject(object); err != nil {
			return rollback(err)
		}
	}
	for _, table := range manifest.Tables {
		if err := ensureSafeBackupTable(table); err != nil {
			return rollback(err)
		}
	}
	if driver == driverPostgres {
		created := make(map[string]bool, len(manifest.Tables))
		for _, table := range manifest.Tables {
			if created[table.Schema] {
				continue
			}
			created[table.Schema] = true
			if _, err := tx.Exec(`CREATE SCHEMA IF NOT EXISTS ` + quoteIdentifier(table.Schema)); err != nil {
				return rollback(fmt.Errorf("create schema %s: %w", table.Schema, err))
			}
		}
		// This restore adds its own foreign keys after the rows land, but the
		// target schema may already carry deferrable ones.
		if _, err := tx.Exec(`SET CONSTRAINTS ALL DEFERRED`); err != nil {
			return rollback(fmt.Errorf("defer constraints for restore: %w", err))
		}
	}
	if len(manifest.Objects) > 0 {
		for _, object := range manifest.Objects {
			if object.Kind != objectTable {
				continue
			}
			exists, err := tableExistsTx(tx, driver, object.Schema, object.Name)
			if err != nil {
				return rollback(err)
			}
			if exists {
				continue
			}
			if _, err := tx.Exec(object.SQL); err != nil {
				return rollback(fmt.Errorf("create %s.%s: %w", object.Schema, object.Name, err))
			}
		}
	} else {
		// A version 1 backup only carries column metadata, so the table shape has
		// to be rebuilt from it and cannot reproduce the source's constraints.
		for _, table := range manifest.Tables {
			exists, err := tableExistsTx(tx, driver, table.Schema, table.Name)
			if err != nil {
				return rollback(err)
			}
			if exists {
				continue
			}
			for _, column := range table.Columns {
				if strings.EqualFold(strings.TrimSpace(column.Type), "USER-DEFINED") {
					return rollback(fmt.Errorf("create %s.%s: this backup only contains the legacy PostgreSQL type marker USER-DEFINED for column %s; create the table first or make a new backup with the corrected QueryNest version", table.Schema, table.Name, column.Name))
				}
			}
			if _, err := tx.Exec(createArchivedTableSQL(driver, table)); err != nil {
				return rollback(fmt.Errorf("create %s.%s: %w", table.Schema, table.Name, err))
			}
		}
	}
	if len(manifest.Objects) > 0 {
		// The backup is authoritative for the objects it carries, so anything the
		// target already has under those names is replaced. Dropping runs in
		// reverse order, which is how a view built on another view comes first,
		// and before the rows load so no index or constraint slows the insert or
		// rejects an intermediate state.
		for i := len(manifest.Objects) - 1; i >= 0; i-- {
			object := manifest.Objects[i]
			statement := dropBackupObjectSQL(driver, object)
			if statement == "" {
				continue
			}
			if _, err := tx.Exec(statement); err != nil {
				return rollback(fmt.Errorf("replace %s %s: %w", object.Kind, object.Name, err))
			}
		}
	}
	if len(manifest.Tables) > 0 {
		if driver == driverPostgres {
			names := make([]string, len(manifest.Tables))
			for i, table := range manifest.Tables {
				names[i] = qualifiedIdentifier(table.Schema, table.Name)
			}
			if _, err := tx.Exec(`TRUNCATE TABLE ` + strings.Join(names, ", ") + ` RESTART IDENTITY`); err != nil {
				return rollback(fmt.Errorf("clear tables for restore: %w", err))
			}
		} else {
			if _, err := tx.Exec(`PRAGMA defer_foreign_keys = ON`); err != nil {
				return rollback(fmt.Errorf("defer foreign keys: %w", err))
			}
			for i := len(manifest.Tables) - 1; i >= 0; i-- {
				table := manifest.Tables[i]
				if _, err := tx.Exec(`DELETE FROM ` + qualifiedIdentifier(table.Schema, table.Name)); err != nil {
					return rollback(fmt.Errorf("clear %s.%s: %w", table.Schema, table.Name, err))
				}
			}
		}
	}
	statements := make([]*sql.Stmt, len(manifest.Tables))
	defer func() {
		for _, statement := range statements {
			if statement != nil {
				_ = statement.Close()
			}
		}
	}()
	for i, table := range manifest.Tables {
		columns, places := make([]string, len(table.Columns)), make([]string, len(table.Columns))
		for j, column := range table.Columns {
			columns[j], places[j] = quoteIdentifier(column.Name), placeholder(driver, j+1)
		}
		overriding := ""
		if driver == driverPostgres && table.IdentityOverride {
			overriding = `OVERRIDING SYSTEM VALUE `
		}
		statements[i], err = tx.Prepare(`INSERT INTO ` + qualifiedIdentifier(table.Schema, table.Name) + ` (` + strings.Join(columns, ", ") + `) ` + overriding + `VALUES (` + strings.Join(places, ", ") + `)`)
		if err != nil {
			return rollback(fmt.Errorf("prepare restore for %s.%s: %w", table.Schema, table.Name, err))
		}
	}
	decoder := backupDecoder(reader)
	var restored int64
	complete := false
	for {
		var record backupRecord
		if err := decoder.Decode(&record); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return rollback(fmt.Errorf("read backup record: %w", err))
		}
		switch record.Kind {
		case "checkpoint":
			continue
		case "complete":
			complete = true
			continue
		case "row":
		default:
			return rollback(fmt.Errorf("unsupported backup record %q", record.Kind))
		}
		if record.Table < 0 || record.Table >= len(manifest.Tables) || len(record.Value) != len(manifest.Tables[record.Table].Columns) {
			return rollback(errors.New("backup row does not match its table schema"))
		}
		values := make([]any, len(record.Value))
		for i, encoded := range record.Value {
			values[i], err = decodeBackupValue(encoded)
			if err != nil {
				return rollback(fmt.Errorf("decode backup value: %w", err))
			}
		}
		if _, err := statements[record.Table].Exec(values...); err != nil {
			table := manifest.Tables[record.Table]
			return rollback(fmt.Errorf("restore row into %s.%s: %w", table.Schema, table.Name, err))
		}
		restored++
	}
	if !complete {
		return rollback(errors.New("backup is pending or incomplete; only completed .qnb files can be restored"))
	}
	if driver == driverPostgres {
		for _, table := range manifest.Tables {
			for _, column := range table.Columns {
				// An identity column carries no nextval default, so every column is
				// asked for its sequence instead of guessing from the default.
				var sequence sql.NullString
				if err := tx.QueryRow(`SELECT pg_get_serial_sequence($1, $2)`, table.Schema+"."+table.Name, column.Name).Scan(&sequence); err != nil {
					return rollback(fmt.Errorf("find sequence for %s.%s: %w", table.Name, column.Name, err))
				}
				if !sequence.Valid {
					continue
				}
				qualified := qualifiedIdentifier(table.Schema, table.Name)
				reset := `SELECT setval($1::regclass, COALESCE((SELECT MAX(` + quoteIdentifier(column.Name) + `) FROM ` + qualified + `), 1), EXISTS (SELECT 1 FROM ` + qualified + `))`
				if _, err := tx.Exec(reset, sequence.String); err != nil {
					return rollback(fmt.Errorf("reset sequence for %s.%s: %w", table.Name, column.Name, err))
				}
			}
		}
	}
	if len(manifest.Objects) > 0 {
		// Foreign keys, routines, indexes, views and triggers, in the order the
		// backup recorded them, which is the order that satisfies dependencies.
		for _, object := range manifest.Objects {
			if object.Kind == objectTable {
				continue
			}
			if _, err := tx.Exec(object.SQL); err != nil {
				return rollback(fmt.Errorf("restore %s %s: %w", object.Kind, object.Name, err))
			}
		}
	} else {
		for _, table := range manifest.Tables {
			for _, index := range table.Indexes {
				if index.Primary || index.Partial || strings.HasPrefix(index.Name, "sqlite_autoindex_") || len(index.Columns) == 0 || slicesContain(index.Columns, "(expression)") {
					continue
				}
				columns := make([]string, len(index.Columns))
				for i, column := range index.Columns {
					columns[i] = quoteIdentifier(column)
				}
				statement := `CREATE `
				if index.Unique {
					statement += `UNIQUE `
				}
				statement += `INDEX IF NOT EXISTS ` + quoteIdentifier(index.Name) + ` ON ` + qualifiedIdentifier(table.Schema, table.Name) + ` (` + strings.Join(columns, ", ") + `)`
				if _, err := tx.Exec(statement); err != nil {
					return rollback(fmt.Errorf("restore index %s: %w", index.Name, err))
				}
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return TransferResult{}, fmt.Errorf("commit restore: %w", err)
	}
	return TransferResult{Path: path, Tables: len(manifest.Tables), Rows: restored}, nil
}

func ensureSafeBackupTable(table backupTable) error {
	if strings.TrimSpace(table.Name) == "" || strings.TrimSpace(table.Schema) == "" || len(table.Columns) == 0 {
		return errors.New("backup contains an invalid table definition")
	}
	for _, column := range table.Columns {
		if strings.TrimSpace(column.Name) == "" || unsafeSQLFragment(column.Type) || column.Default != nil && unsafeSQLFragment(*column.Default) {
			return fmt.Errorf("backup contains an unsafe definition for %s.%s", table.Name, column.Name)
		}
	}
	return nil
}

func postgresBackupEnums(db *sql.DB) ([]backupEnum, error) {
	rows, err := db.Query(`
		SELECT namespace.nspname, data_type.typname, enum_value.enumlabel
		FROM pg_catalog.pg_type data_type
		JOIN pg_catalog.pg_namespace namespace ON namespace.oid = data_type.typnamespace
		JOIN pg_catalog.pg_enum enum_value ON enum_value.enumtypid = data_type.oid
		WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
		ORDER BY namespace.nspname, data_type.typname, enum_value.enumsortorder`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	enums := make([]backupEnum, 0)
	for rows.Next() {
		var schema, name, value string
		if err := rows.Scan(&schema, &name, &value); err != nil {
			return nil, err
		}
		if len(enums) == 0 || enums[len(enums)-1].Schema != schema || enums[len(enums)-1].Name != name {
			enums = append(enums, backupEnum{Schema: schema, Name: name, Values: make([]string, 0)})
		}
		enums[len(enums)-1].Values = append(enums[len(enums)-1].Values, value)
	}
	return enums, rows.Err()
}

func restorePostgresEnum(tx *sql.Tx, enum backupEnum) error {
	if strings.TrimSpace(enum.Schema) == "" || strings.TrimSpace(enum.Name) == "" || len(enum.Values) == 0 {
		return errors.New("backup contains an invalid PostgreSQL enum definition")
	}
	var found string
	err := tx.QueryRow(`
		SELECT data_type.typname
		FROM pg_catalog.pg_type data_type
		JOIN pg_catalog.pg_namespace namespace ON namespace.oid = data_type.typnamespace
		WHERE namespace.nspname = $1 AND data_type.typname = $2 AND data_type.typtype = 'e'`, enum.Schema, enum.Name).Scan(&found)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("inspect enum %s.%s: %w", enum.Schema, enum.Name, err)
	}
	if _, err := tx.Exec(`CREATE SCHEMA IF NOT EXISTS ` + quoteIdentifier(enum.Schema)); err != nil {
		return fmt.Errorf("create schema %s for enum: %w", enum.Schema, err)
	}
	values := make([]string, len(enum.Values))
	for i, value := range enum.Values {
		values[i] = quoteSQLString(value)
	}
	if _, err := tx.Exec(`CREATE TYPE ` + qualifiedIdentifier(enum.Schema, enum.Name) + ` AS ENUM (` + strings.Join(values, ", ") + `)`); err != nil {
		return fmt.Errorf("create enum %s.%s: %w", enum.Schema, enum.Name, err)
	}
	return nil
}

func quoteSQLString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func unsafeSQLFragment(value string) bool {
	lower := strings.ToLower(value)
	return strings.Contains(value, ";") || strings.Contains(lower, "--") || strings.Contains(lower, "/*") || strings.Contains(lower, "*/")
}

func tableExistsTx(tx *sql.Tx, driver, schema, table string) (bool, error) {
	var found string
	var err error
	if driver == driverPostgres {
		err = tx.QueryRow(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`, schema, table).Scan(&found)
	} else {
		err = tx.QueryRow(`SELECT name FROM sqlite_master WHERE name = ? AND type = 'table'`, table).Scan(&found)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func createArchivedTableSQL(driver string, table backupTable) string {
	definitions := make([]string, 0, len(table.Columns)+1)
	primary := make([]string, 0)
	for _, column := range table.Columns {
		columnType := strings.TrimSpace(column.Type)
		if columnType == "" {
			columnType = "TEXT"
		}
		definition := quoteIdentifier(column.Name) + " " + columnType
		sequenceDefault := driver == driverPostgres && column.Default != nil && strings.Contains(strings.ToLower(*column.Default), "nextval(")
		if sequenceDefault {
			definition += " GENERATED BY DEFAULT AS IDENTITY"
		}
		if !column.Nullable {
			definition += " NOT NULL"
		}
		if column.Default != nil && !sequenceDefault {
			definition += " DEFAULT " + *column.Default
		}
		definitions = append(definitions, definition)
		if column.PrimaryKey {
			primary = append(primary, quoteIdentifier(column.Name))
		}
	}
	if len(primary) > 0 {
		definitions = append(definitions, "PRIMARY KEY ("+strings.Join(primary, ", ")+")")
	}
	return `CREATE TABLE ` + qualifiedIdentifier(table.Schema, table.Name) + ` (` + strings.Join(definitions, ", ") + `)`
}

func slicesContain(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (a *App) PreviewTableExport(tables []TableRef) (TransferPreview, error) {
	preview := TransferPreview{Kind: "export", Driver: a.GetStatus().Driver, Database: a.GetStatus().Database, Tables: make([]TransferTablePreview, 0, len(tables))}
	for _, table := range tables {
		data, err := a.GetTableData(table.Schema, table.Name, previewRowLimit, 0, "", "", "")
		if err != nil {
			return TransferPreview{}, fmt.Errorf("preview export %s.%s: %w", table.Schema, table.Name, err)
		}
		preview.Tables = append(preview.Tables, TransferTablePreview{Schema: table.Schema, Name: table.Name, Columns: data.Columns, SampleRows: data.Rows, Rows: data.Total})
	}
	return preview, nil
}

func (a *App) ExportTables(tables []TableRef, format string) (TransferResult, error) {
	if len(tables) == 0 {
		return TransferResult{}, errors.New("select at least one table to export")
	}
	format = strings.ToLower(strings.TrimSpace(format))
	if len(tables) > 1 {
		format = "json"
	}
	if format != "csv" && format != "json" {
		return TransferResult{}, errors.New("export format must be CSV or JSON")
	}
	extension := "." + format
	defaultName := tables[0].Name + extension
	if len(tables) > 1 {
		defaultName = a.GetStatus().Database + "-tables.json"
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{Title: "Export table data", DefaultFilename: defaultName, Filters: []runtime.FileFilter{{DisplayName: strings.ToUpper(format) + " file (*" + extension + ")", Pattern: "*" + extension}}})
	if err != nil || path == "" {
		return TransferResult{}, err
	}
	if !strings.EqualFold(filepath.Ext(path), extension) {
		path += extension
	}
	if format == "csv" {
		return a.exportCSV(path, tables[0])
	}
	return a.exportJSON(path, tables)
}

func (a *App) exportCSV(path string, table TableRef) (TransferResult, error) {
	db, driver, err := a.connection()
	if err != nil {
		return TransferResult{}, err
	}
	columns, err := a.GetTableSchema(table.Schema, table.Name)
	if err != nil {
		return TransferResult{}, err
	}
	names, quoted := previewColumns(columns), make([]string, len(columns))
	for i, name := range names {
		quoted[i] = quoteIdentifier(name)
	}
	rows, err := db.Query(`SELECT ` + strings.Join(quoted, ", ") + ` FROM ` + qualifiedIdentifier(table.Schema, table.Name))
	if err != nil {
		return TransferResult{}, fmt.Errorf("export table: %w", err)
	}
	defer rows.Close()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return TransferResult{}, fmt.Errorf("create export: %w", err)
	}
	defer file.Close()
	writer := csv.NewWriter(file)
	if err := writer.Write(names); err != nil {
		return TransferResult{}, err
	}
	var count int64
	for rows.Next() {
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return TransferResult{}, err
		}
		record := make([]string, len(values))
		for i, value := range values {
			record[i] = exportString(value)
		}
		if err := writer.Write(record); err != nil {
			return TransferResult{}, err
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return TransferResult{}, err
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return TransferResult{}, err
	}
	if err := file.Sync(); err != nil {
		return TransferResult{}, err
	}
	_ = driver
	return TransferResult{Path: path, Tables: 1, Rows: count}, nil
}

func exportString(value any) string {
	if value == nil {
		return `\N`
	}
	if bytes, ok := value.([]byte); ok {
		if utf8.Valid(bytes) {
			return string(bytes)
		}
		return "base64:" + base64.StdEncoding.EncodeToString(bytes)
	}
	if value, ok := value.(time.Time); ok {
		return value.Format(time.RFC3339Nano)
	}
	return fmt.Sprint(value)
}

func (a *App) exportJSON(path string, tables []TableRef) (TransferResult, error) {
	db, _, err := a.connection()
	if err != nil {
		return TransferResult{}, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return TransferResult{}, fmt.Errorf("create export: %w", err)
	}
	defer file.Close()
	buffer := bufio.NewWriterSize(file, 256*1024)
	if _, err := io.WriteString(buffer, `{"format":"`+queryNestExportFormat+`","version":1,"tables":[`); err != nil {
		return TransferResult{}, err
	}
	var total int64
	for tableIndex, table := range tables {
		columns, err := a.GetTableSchema(table.Schema, table.Name)
		if err != nil {
			return TransferResult{}, err
		}
		names, quoted := previewColumns(columns), make([]string, len(columns))
		for i, name := range names {
			quoted[i] = quoteIdentifier(name)
		}
		if tableIndex > 0 {
			_, _ = io.WriteString(buffer, ",")
		}
		header, _ := json.Marshal(struct {
			Schema  string   `json:"schema"`
			Name    string   `json:"name"`
			Columns []string `json:"columns"`
		}{table.Schema, table.Name, names})
		if _, err := buffer.Write(header[:len(header)-1]); err != nil {
			return TransferResult{}, err
		}
		if _, err := io.WriteString(buffer, `,"rows":[`); err != nil {
			return TransferResult{}, err
		}
		rows, err := db.Query(`SELECT ` + strings.Join(quoted, ", ") + ` FROM ` + qualifiedIdentifier(table.Schema, table.Name))
		if err != nil {
			return TransferResult{}, err
		}
		first := true
		for rows.Next() {
			values := make([]any, len(names))
			pointers := make([]any, len(names))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err := rows.Scan(pointers...); err != nil {
				_ = rows.Close()
				return TransferResult{}, err
			}
			for i, value := range values {
				if bytes, ok := value.([]byte); ok {
					values[i] = exportString(bytes)
				}
			}
			encoded, err := json.Marshal(values)
			if err != nil {
				_ = rows.Close()
				return TransferResult{}, err
			}
			if !first {
				_, _ = io.WriteString(buffer, ",")
			}
			first = false
			if _, err := buffer.Write(encoded); err != nil {
				_ = rows.Close()
				return TransferResult{}, err
			}
			total++
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return TransferResult{}, err
		}
		_ = rows.Close()
		if _, err := io.WriteString(buffer, `]}`); err != nil {
			return TransferResult{}, err
		}
	}
	if _, err := io.WriteString(buffer, `]}`); err != nil {
		return TransferResult{}, err
	}
	if err := buffer.Flush(); err != nil {
		return TransferResult{}, err
	}
	if err := file.Sync(); err != nil {
		return TransferResult{}, err
	}
	return TransferResult{Path: path, Tables: len(tables), Rows: total}, nil
}

func (a *App) ChooseTableImport(table TableRef) (TransferPreview, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: "Import table data", Filters: []runtime.FileFilter{{DisplayName: "CSV or JSON (*.csv;*.json)", Pattern: "*.csv;*.json"}}})
	if err != nil || path == "" {
		return TransferPreview{}, err
	}
	var parsed tableExport
	var format string
	var importRows int64
	if strings.EqualFold(filepath.Ext(path), ".csv") {
		parsed, importRows, err = previewCSVImport(path, table)
		format = "csv"
	} else {
		parsed, format, err = parseImportFile(path, table)
		importRows = int64(len(parsed.Rows))
	}
	if err != nil {
		return TransferPreview{}, err
	}
	columns, err := a.GetTableSchema(table.Schema, table.Name)
	if err != nil {
		return TransferPreview{}, err
	}
	target := previewColumns(columns)
	targetSet, sourceSet := map[string]ColumnInfo{}, map[string]bool{}
	for _, column := range columns {
		targetSet[column.Name] = column
	}
	for _, column := range parsed.Columns {
		sourceSet[column] = true
	}
	preview := TransferTablePreview{Schema: table.Schema, Name: table.Name, Columns: parsed.Columns, TargetColumns: target, MissingColumns: make([]string, 0), ExtraColumns: make([]string, 0), RequiredMissing: make([]string, 0), Rows: importRows, SampleRows: parsed.Rows[:min(len(parsed.Rows), previewRowLimit)]}
	for _, source := range parsed.Columns {
		if _, ok := targetSet[source]; !ok {
			preview.ExtraColumns = append(preview.ExtraColumns, source)
		}
	}
	for _, targetColumn := range columns {
		if !sourceSet[targetColumn.Name] {
			preview.MissingColumns = append(preview.MissingColumns, targetColumn.Name)
			if !targetColumn.Nullable && targetColumn.Default == nil && !targetColumn.PrimaryKey {
				preview.RequiredMissing = append(preview.RequiredMissing, targetColumn.Name)
			}
		}
	}
	return TransferPreview{Kind: "import", Path: path, Format: format, Driver: a.GetStatus().Driver, Database: a.GetStatus().Database, Tables: []TransferTablePreview{preview}}, nil
}

func previewCSVImport(path string, target TableRef) (tableExport, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return tableExport{}, 0, fmt.Errorf("open import: %w", err)
	}
	defer file.Close()
	reader := csv.NewReader(bufio.NewReaderSize(file, 256*1024))
	columns, err := reader.Read()
	if errors.Is(err, io.EOF) {
		return tableExport{}, 0, errors.New("CSV file is empty")
	}
	if err != nil {
		return tableExport{}, 0, fmt.Errorf("read CSV header: %w", err)
	}
	samples := make([][]any, 0, previewRowLimit)
	var count int64
	for {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return tableExport{}, 0, fmt.Errorf("read CSV row %d: %w", count+2, err)
		}
		count++
		if len(samples) < previewRowLimit {
			row := make([]any, len(record))
			for i, value := range record {
				if value == `\N` {
					row[i] = nil
				} else {
					row[i] = value
				}
			}
			samples = append(samples, row)
		}
	}
	return tableExport{Schema: target.Schema, Name: target.Name, Columns: columns, Rows: samples}, count, nil
}

func parseImportFile(path string, target TableRef) (tableExport, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return tableExport{}, "", fmt.Errorf("open import: %w", err)
	}
	defer file.Close()
	if strings.EqualFold(filepath.Ext(path), ".csv") {
		rows, err := csv.NewReader(bufio.NewReader(file)).ReadAll()
		if err != nil {
			return tableExport{}, "", fmt.Errorf("read CSV: %w", err)
		}
		if len(rows) == 0 {
			return tableExport{}, "", errors.New("CSV file is empty")
		}
		data := make([][]any, len(rows)-1)
		for i, row := range rows[1:] {
			data[i] = make([]any, len(row))
			for j, value := range row {
				if value == `\N` {
					data[i][j] = nil
				} else {
					data[i][j] = value
				}
			}
		}
		return tableExport{Schema: target.Schema, Name: target.Name, Columns: rows[0], Rows: data}, "csv", nil
	}
	var exported tableExportFile
	if err := json.NewDecoder(file).Decode(&exported); err != nil {
		return tableExport{}, "", fmt.Errorf("read JSON: %w", err)
	}
	if exported.Format != queryNestExportFormat || exported.Version != queryNestFormatVersion {
		return tableExport{}, "", errors.New("unsupported JSON table export")
	}
	for _, table := range exported.Tables {
		if table.Name == target.Name && (table.Schema == target.Schema || table.Schema == "") {
			return table, "json", nil
		}
	}
	if len(exported.Tables) == 1 {
		return exported.Tables[0], "json", nil
	}
	return tableExport{}, "", errors.New("JSON export does not contain the selected table")
}

func (a *App) ImportTable(table TableRef, path, conflict string) (TransferResult, error) {
	db, driver, readOnly, err := a.editableConnection()
	if err != nil {
		return TransferResult{}, err
	}
	if readOnly {
		return TransferResult{}, errors.New("this connection is read-only; reconnect with editing enabled")
	}
	if conflict != "abort" && conflict != "skip" {
		return TransferResult{}, errors.New("conflict option must be abort or skip")
	}
	if strings.EqualFold(filepath.Ext(path), ".csv") {
		return a.importCSVTable(db, driver, table, path, conflict)
	}
	parsed, _, err := parseImportFile(path, table)
	if err != nil {
		return TransferResult{}, err
	}
	targetColumns, err := a.GetTableSchema(table.Schema, table.Name)
	if err != nil {
		return TransferResult{}, err
	}
	allowed := map[string]bool{}
	for _, column := range targetColumns {
		allowed[column.Name] = true
	}
	for _, column := range parsed.Columns {
		if !allowed[column] {
			return TransferResult{}, fmt.Errorf("import column %q does not exist in the target table", column)
		}
	}
	if len(parsed.Columns) == 0 {
		return TransferResult{}, errors.New("import has no columns")
	}
	quoted, places := make([]string, len(parsed.Columns)), make([]string, len(parsed.Columns))
	for i, column := range parsed.Columns {
		quoted[i], places[i] = quoteIdentifier(column), placeholder(driver, i+1)
	}
	statement := `INSERT INTO ` + qualifiedIdentifier(table.Schema, table.Name) + ` (` + strings.Join(quoted, ", ") + `) VALUES (` + strings.Join(places, ", ") + ")"
	if conflict == "skip" {
		statement += " ON CONFLICT DO NOTHING"
	}
	tx, err := db.Begin()
	if err != nil {
		return TransferResult{}, err
	}
	prepared, err := tx.Prepare(statement)
	if err != nil {
		_ = tx.Rollback()
		return TransferResult{}, err
	}
	defer prepared.Close()
	var inserted, skipped int64
	for rowIndex, row := range parsed.Rows {
		if len(row) != len(parsed.Columns) {
			_ = tx.Rollback()
			return TransferResult{}, fmt.Errorf("row %d has %d values; expected %d", rowIndex+2, len(row), len(parsed.Columns))
		}
		result, err := prepared.Exec(row...)
		if err != nil {
			_ = tx.Rollback()
			return TransferResult{}, fmt.Errorf("import row %d: %w", rowIndex+2, err)
		}
		affected, _ := result.RowsAffected()
		inserted += affected
		if affected == 0 {
			skipped++
		}
	}
	if err := tx.Commit(); err != nil {
		return TransferResult{}, err
	}
	return TransferResult{Path: path, Tables: 1, Rows: inserted, Skipped: skipped}, nil
}

func (a *App) importCSVTable(db *sql.DB, driver string, table TableRef, path, conflict string) (TransferResult, error) {
	file, err := os.Open(path)
	if err != nil {
		return TransferResult{}, fmt.Errorf("open import: %w", err)
	}
	defer file.Close()
	reader := csv.NewReader(bufio.NewReaderSize(file, 256*1024))
	columns, err := reader.Read()
	if errors.Is(err, io.EOF) {
		return TransferResult{}, errors.New("CSV file is empty")
	}
	if err != nil {
		return TransferResult{}, fmt.Errorf("read CSV header: %w", err)
	}
	targetColumns, err := a.GetTableSchema(table.Schema, table.Name)
	if err != nil {
		return TransferResult{}, err
	}
	allowed := map[string]bool{}
	for _, column := range targetColumns {
		allowed[column.Name] = true
	}
	for _, column := range columns {
		if !allowed[column] {
			return TransferResult{}, fmt.Errorf("import column %q does not exist in the target table", column)
		}
	}
	if len(columns) == 0 {
		return TransferResult{}, errors.New("import has no columns")
	}
	quoted, places := make([]string, len(columns)), make([]string, len(columns))
	for i, column := range columns {
		quoted[i], places[i] = quoteIdentifier(column), placeholder(driver, i+1)
	}
	statement := `INSERT INTO ` + qualifiedIdentifier(table.Schema, table.Name) + ` (` + strings.Join(quoted, ", ") + `) VALUES (` + strings.Join(places, ", ") + ")"
	if conflict == "skip" {
		statement += " ON CONFLICT DO NOTHING"
	}
	tx, err := db.Begin()
	if err != nil {
		return TransferResult{}, err
	}
	prepared, err := tx.Prepare(statement)
	if err != nil {
		_ = tx.Rollback()
		return TransferResult{}, err
	}
	defer prepared.Close()
	var inserted, skipped, rowIndex int64
	for {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			_ = tx.Rollback()
			return TransferResult{}, fmt.Errorf("read CSV row %d: %w", rowIndex+2, err)
		}
		rowIndex++
		values := make([]any, len(record))
		for i, value := range record {
			if value == `\N` {
				values[i] = nil
			} else {
				values[i] = value
			}
		}
		result, err := prepared.Exec(values...)
		if err != nil {
			_ = tx.Rollback()
			return TransferResult{}, fmt.Errorf("import row %d: %w", rowIndex+1, err)
		}
		affected, _ := result.RowsAffected()
		inserted += affected
		if affected == 0 {
			skipped++
		}
	}
	if err := tx.Commit(); err != nil {
		return TransferResult{}, err
	}
	return TransferResult{Path: path, Tables: 1, Rows: inserted, Skipped: skipped}, nil
}

func (a *App) TruncateTables(tables []TableRef) (int64, error) {
	return a.truncateTables(context.Background(), tables)
}

func (a *App) TruncateTablesTracked(operationID string, tables []TableRef) (int64, error) {
	ctx, finish := a.beginOperation(operationID)
	defer finish()
	return a.truncateTables(ctx, tables)
}

func (a *App) truncateTables(ctx context.Context, tables []TableRef) (int64, error) {
	db, driver, readOnly, err := a.editableConnection()
	if err != nil {
		return 0, err
	}
	if readOnly {
		return 0, errors.New("this connection is read-only; reconnect with editing enabled")
	}
	if len(tables) == 0 {
		return 0, errors.New("select at least one table")
	}
	for _, table := range tables {
		if _, err := a.GetTableSchema(table.Schema, table.Name); err != nil {
			return 0, err
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	if driver == driverPostgres {
		names := make([]string, len(tables))
		for i, table := range tables {
			names[i] = qualifiedIdentifier(table.Schema, table.Name)
		}
		if _, err := tx.ExecContext(ctx, `TRUNCATE TABLE `+strings.Join(names, ", ")); err != nil {
			_ = tx.Rollback()
			return 0, err
		}
		if err := tx.Commit(); err != nil {
			return 0, err
		}
		return int64(len(tables)), nil
	}
	var affected int64
	for i := len(tables) - 1; i >= 0; i-- {
		result, err := tx.ExecContext(ctx, `DELETE FROM `+qualifiedIdentifier(tables[i].Schema, tables[i].Name))
		if err != nil {
			_ = tx.Rollback()
			return 0, err
		}
		count, _ := result.RowsAffected()
		affected += count
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return affected, nil
}
