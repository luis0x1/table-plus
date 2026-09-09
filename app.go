package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	_ "modernc.org/sqlite"
)

const maxPageSize = 500

const (
	driverSQLite   = "SQLite"
	driverPostgres = "PostgreSQL"
)

type App struct {
	configMu         sync.Mutex
	configPath       string
	dataDirOverride  string
	legacyConfigPath string
	ctx              context.Context
	mu               sync.RWMutex
	profilesMu       *sync.Mutex
	sessionsMu       sync.RWMutex
	sessions         map[string]*App
	sessionOrder     []string
	sessionID        string
	postgresConfig   *PostgresConfig
	db               *sql.DB
	path             string
	name             string
	driver           string
	readOnly         bool
}

type ConnectionStatus struct {
	ID        string `json:"id"`
	Database  string `json:"database"`
	Connected bool   `json:"connected"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Driver    string `json:"driver"`
	ReadOnly  bool   `json:"readOnly"`
}

type TableSummary struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Type   string `json:"type"`
	Rows   int64  `json:"rows"`
}

type PostgresConfig struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	Password       string `json:"password"`
	Database       string `json:"database"`
	SSLMode        string `json:"sslMode"`
	ReadOnly       bool   `json:"readOnly"`
	SaveConnection bool   `json:"saveConnection"`
	SavePassword   bool   `json:"savePassword"`
}

type ColumnInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Nullable   bool   `json:"nullable"`
	PrimaryKey bool   `json:"primaryKey"`
	Default    any    `json:"default"`
}

type IndexInfo struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	Primary bool     `json:"primary"`
	Partial bool     `json:"partial"`
}

type TableData struct {
	Columns    []string `json:"columns"`
	Rows       [][]any  `json:"rows"`
	Total      int64    `json:"total"`
	DurationMs int64    `json:"durationMs"`
}

type QueryResult struct {
	Columns      []string `json:"columns"`
	Rows         [][]any  `json:"rows"`
	RowsAffected int64    `json:"rowsAffected"`
	DurationMs   int64    `json:"durationMs"`
	Message      string   `json:"message"`
}

func NewApp() *App { return &App{profilesMu: &sync.Mutex{}, sessions: make(map[string]*App)} }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

func (a *App) shutdown(_ context.Context) { a.closeAllSessions(); _ = a.closeDB() }

func (a *App) GetStatus() ConnectionStatus {
	a.mu.RLock()
	defer a.mu.RUnlock()
	database := a.name
	if a.postgresConfig != nil {
		database = a.postgresConfig.Database
	}
	return ConnectionStatus{ID: a.sessionID, Database: database, Connected: a.db != nil, Name: a.name, Path: a.path, Driver: a.driver, ReadOnly: a.readOnly}
}

func (a *App) ChooseSQLiteFile() (ConnectionStatus, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Open SQLite database",
		Filters: []runtime.FileFilter{{DisplayName: "SQLite database (*.db;*.sqlite;*.sqlite3)", Pattern: "*.db;*.sqlite;*.sqlite3"}, {DisplayName: "All files", Pattern: "*"}},
	})
	if err != nil || path == "" {
		return a.GetStatus(), err
	}
	status, err := a.ConnectSQLite(path)
	if err == nil {
		_ = a.saveSQLiteProfile(path, status.Name)
	}
	return status, err
}

func (a *App) ConnectSQLite(path string) (ConnectionStatus, error) {
	if strings.TrimSpace(path) == "" {
		return ConnectionStatus{}, errors.New("database path is required")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return ConnectionStatus{}, err
	}
	if stat, err := os.Stat(abs); err != nil {
		return ConnectionStatus{}, fmt.Errorf("open database: %w", err)
	} else if stat.IsDir() {
		return ConnectionStatus{}, errors.New("selected path is a directory")
	}
	dsn := sqliteDSN(abs, false)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return ConnectionStatus{}, err
	}
	db.SetMaxOpenConns(4)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return ConnectionStatus{}, fmt.Errorf("connect database: %w", err)
	}
	a.swapDB(db, abs, strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs)), driverSQLite, false, nil)
	return a.GetStatus(), nil
}

func (a *App) ConnectPostgres(input PostgresConfig) (ConnectionStatus, error) {
	input, err := normalizePostgresConfig(input)
	if err != nil {
		return ConnectionStatus{}, err
	}
	db, err := openPostgresDB(input)
	if err != nil {
		return ConnectionStatus{}, err
	}
	displayPath := fmt.Sprintf("%s:%d/%s", input.Host, input.Port, input.Database)
	displayName := strings.TrimSpace(input.Name)
	if displayName == "" {
		displayName = input.Database
	}
	a.swapDB(db, displayPath, displayName, driverPostgres, input.ReadOnly, &input)
	if input.SaveConnection {
		if err := a.savePostgresProfile(input); err != nil {
			return a.GetStatus(), fmt.Errorf("connected, but could not save connection: %w", err)
		}
	}
	return a.GetStatus(), nil
}

// TestPostgresConnection uses a temporary connection without changing the active
// database or saving a profile or password.
func (a *App) TestPostgresConnection(input PostgresConfig) error {
	input, err := normalizePostgresConfig(input)
	if err != nil {
		return err
	}
	db, err := openPostgresDB(input)
	if err != nil {
		return err
	}
	if err := db.Close(); err != nil {
		return fmt.Errorf("close PostgreSQL test connection: %w", err)
	}
	return nil
}

func normalizePostgresConfig(input PostgresConfig) (PostgresConfig, error) {
	input.Host = strings.TrimSpace(input.Host)
	input.User = strings.TrimSpace(input.User)
	input.Database = strings.TrimSpace(input.Database)
	input.SSLMode = strings.ToLower(strings.TrimSpace(input.SSLMode))
	if input.Host == "" || input.User == "" || input.Database == "" {
		return PostgresConfig{}, errors.New("host, user, and database are required")
	}
	if input.Port == 0 {
		input.Port = 5432
	}
	if input.Port < 1 || input.Port > 65535 {
		return PostgresConfig{}, errors.New("port must be between 1 and 65535")
	}
	if input.SSLMode == "" {
		input.SSLMode = "prefer"
	}
	sslModes := map[string]bool{"disable": true, "allow": true, "prefer": true, "require": true, "verify-ca": true, "verify-full": true}
	if !sslModes[input.SSLMode] {
		return PostgresConfig{}, errors.New("invalid SSL mode")
	}

	return input, nil
}

func openPostgresDB(input PostgresConfig) (*sql.DB, error) {
	endpoint := &url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(input.User, input.Password),
		Host:   net.JoinHostPort(input.Host, strconv.Itoa(input.Port)),
		Path:   "/" + input.Database,
	}
	query := endpoint.Query()
	query.Set("sslmode", input.SSLMode)
	endpoint.RawQuery = query.Encode()
	config, err := pgx.ParseConfig(endpoint.String())
	if err != nil {
		return nil, fmt.Errorf("invalid PostgreSQL configuration: %w", err)
	}
	if input.ReadOnly {
		config.RuntimeParams["default_transaction_read_only"] = "on"
	}
	db := stdlib.OpenDB(*config)
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("connect PostgreSQL: %w", err)
	}
	return db, nil
}

func (a *App) ConnectDemo() (ConnectionStatus, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	dir = filepath.Join(dir, "querynest")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ConnectionStatus{}, err
	}
	path := filepath.Join(dir, "querynest-demo.db")
	if err := seedDemo(path); err != nil {
		return ConnectionStatus{}, err
	}
	return a.ConnectSQLite(path)
}

func seedDemo(path string) error {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer db.Close()
	statements := []string{
		`CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, company TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, ordered_at TEXT NOT NULL)`,
		`CREATE VIEW IF NOT EXISTS active_customers AS SELECT id, name, email, company FROM customers WHERE status = 'active'`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM customers`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	customers := [][]any{
		{1, "Olivia Martin", "olivia@northstar.io", "Northstar Labs", "active", "2026-08-29 09:42:11"},
		{2, "Jackson Lee", "jackson@sisyphus.co", "Sisyphus", "active", "2026-08-28 16:18:03"},
		{3, "Sophia Brown", "sophia@catalog.com", "Catalog", "invited", "2026-08-26 11:03:45"},
		{4, "Noah Williams", "noah@circooles.com", "Circooles", "active", "2026-08-24 14:25:37"},
		{5, "Emma Davis", "emma@quotient.com", "Quotient", "suspended", "2026-08-21 08:56:22"},
		{6, "Liam Wilson", "liam@layers.to", "Layers", "active", "2026-08-19 18:32:09"},
		{7, "Ava Taylor", "ava@commandr.com", "Command R", "invited", "2026-08-17 10:12:56"},
		{8, "Ethan Moore", "ethan@hourglass.io", "Hourglass", "active", "2026-08-14 13:47:28"},
	}
	for _, row := range customers {
		if _, err := tx.Exec(`INSERT INTO customers(id,name,email,company,status,created_at) VALUES(?,?,?,?,?,?)`, row...); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	orders := [][]any{{1001, 1, 249.00, "USD", "paid", "2026-09-01 10:20:00"}, {1002, 2, 89.50, "USD", "pending", "2026-09-01 12:05:00"}, {1003, 1, 510.00, "USD", "paid", "2026-09-02 08:41:00"}, {1004, 4, 120.00, "EUR", "refunded", "2026-09-02 14:12:00"}, {1005, 6, 75.25, "USD", "paid", "2026-09-03 09:06:00"}}
	for _, row := range orders {
		if _, err := tx.Exec(`INSERT INTO orders(id,customer_id,total,currency,status,ordered_at) VALUES(?,?,?,?,?,?)`, row...); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (a *App) Disconnect() error { return a.closeDB() }

func (a *App) closeDB() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.db == nil {
		return nil
	}
	err := a.db.Close()
	a.db, a.path, a.name, a.driver, a.readOnly = nil, "", "", "", false
	a.postgresConfig = nil
	return err
}

func (a *App) swapDB(db *sql.DB, path, name, driver string, readOnly bool, config *PostgresConfig) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.db != nil {
		_ = a.db.Close()
	}
	a.db, a.path, a.name, a.driver, a.readOnly = db, path, name, driver, readOnly
	a.postgresConfig = config
}

func (a *App) connection() (*sql.DB, string, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.db == nil {
		return nil, "", errors.New("no database connected")
	}
	return a.db, a.driver, nil
}

func (a *App) ListTables() ([]TableSummary, error) {
	db, driver, err := a.connection()
	if err != nil {
		return nil, err
	}
	query := `SELECT 'main', name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`
	if driver == driverPostgres {
		query = `SELECT table_schema, table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END
			FROM information_schema.tables
			WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
			ORDER BY table_schema, table_type, table_name`
	}
	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	result := make([]TableSummary, 0)
	for rows.Next() {
		var item TableSummary
		if err := rows.Scan(&item.Schema, &item.Name, &item.Type); err != nil {
			_ = rows.Close()
			return nil, err
		}
		item.Rows = -1
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()
	return result, nil
}

func (a *App) CountTableRows(schema, table string) (int64, error) {
	db, driver, err := a.connection()
	if err != nil {
		return 0, err
	}
	if schema == "" {
		schema = defaultSchema(driver)
	}
	if err := ensureTable(db, driver, schema, table); err != nil {
		return 0, err
	}
	var count int64
	if err := db.QueryRow(`SELECT count(*) FROM ` + qualifiedIdentifier(schema, table)).Scan(&count); err != nil {
		return 0, fmt.Errorf("count rows in %s.%s: %w", schema, table, err)
	}
	return count, nil
}

func (a *App) GetTableSchema(schema, table string) ([]ColumnInfo, error) {
	db, driver, err := a.connection()
	if err != nil {
		return nil, err
	}
	if schema == "" {
		schema = defaultSchema(driver)
	}
	if err := ensureTable(db, driver, schema, table); err != nil {
		return nil, err
	}
	if driver == driverPostgres {
		return postgresTableSchema(db, schema, table)
	}
	rows, err := db.Query(`PRAGMA table_info(` + quoteIdentifier(table) + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make([]ColumnInfo, 0)
	for rows.Next() {
		var cid, notnull, pk int
		var c ColumnInfo
		if err := rows.Scan(&cid, &c.Name, &c.Type, &notnull, &c.Default, &pk); err != nil {
			return nil, err
		}
		c.Nullable, c.PrimaryKey = notnull == 0, pk > 0
		columns = append(columns, c)
	}
	return columns, rows.Err()
}

func (a *App) GetTableIndexes(schema, table string) ([]IndexInfo, error) {
	db, driver, err := a.connection()
	if err != nil {
		return nil, err
	}
	if schema == "" {
		schema = defaultSchema(driver)
	}
	if err := ensureTable(db, driver, schema, table); err != nil {
		return nil, err
	}
	if driver == driverPostgres {
		return postgresTableIndexes(db, schema, table)
	}
	return sqliteTableIndexes(db, schema, table)
}

func (a *App) GetTableData(schema, table string, limit, offset int, filter, sortColumn, sortDirection string) (TableData, error) {
	started := time.Now()
	db, driver, err := a.connection()
	if err != nil {
		return TableData{}, err
	}
	if schema == "" {
		schema = defaultSchema(driver)
	}
	columns, err := a.GetTableSchema(schema, table)
	if err != nil {
		return TableData{}, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > maxPageSize {
		limit = maxPageSize
	}
	if offset < 0 {
		offset = 0
	}
	names := make([]string, len(columns))
	allowed := map[string]bool{}
	for i, col := range columns {
		names[i], allowed[col.Name] = col.Name, true
	}
	where, args := "", []any{}
	if strings.TrimSpace(filter) != "" && len(names) > 0 {
		parts := make([]string, len(names))
		for i, name := range names {
			operator := "LIKE"
			if driver == driverPostgres {
				operator = "ILIKE"
			}
			parts[i] = `CAST(` + quoteIdentifier(name) + ` AS TEXT) ` + operator + ` ` + placeholder(driver, len(args)+1)
			args = append(args, "%"+filter+"%")
		}
		where = " WHERE " + strings.Join(parts, " OR ")
	}
	order := ""
	if sortColumn != "" {
		if !allowed[sortColumn] {
			return TableData{}, errors.New("invalid sort column")
		}
		direction := "ASC"
		if strings.EqualFold(sortDirection, "desc") {
			direction = "DESC"
		}
		order = " ORDER BY " + quoteIdentifier(sortColumn) + " " + direction
	}
	qualified := qualifiedIdentifier(schema, table)
	var total int64
	if err := db.QueryRow(`SELECT count(*) FROM `+qualified+where, args...).Scan(&total); err != nil {
		return TableData{}, err
	}
	queryArgs := append(append([]any{}, args...), limit, offset)
	limitPlaceholder := placeholder(driver, len(args)+1)
	offsetPlaceholder := placeholder(driver, len(args)+2)
	rows, err := db.Query(`SELECT * FROM `+qualified+where+order+` LIMIT `+limitPlaceholder+` OFFSET `+offsetPlaceholder, queryArgs...)
	if err != nil {
		return TableData{}, err
	}
	defer rows.Close()
	data, err := scanRows(rows)
	if err != nil {
		return TableData{}, err
	}
	data.Total, data.DurationMs = total, time.Since(started).Milliseconds()
	return data, nil
}

var leadingKeyword = regexp.MustCompile(`(?is)^\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*([a-z]+)`)

func (a *App) ExecuteQuery(query string) (QueryResult, error) {
	started := time.Now()
	db, driver, err := a.connection()
	if err != nil {
		return QueryResult{}, err
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return QueryResult{}, errors.New("query is empty")
	}
	match := leadingKeyword.FindStringSubmatch(query)
	if len(match) < 2 {
		return QueryResult{}, errors.New("unable to parse query")
	}
	allowed := map[string]bool{"select": true, "with": true, "explain": true}
	if driver == driverSQLite {
		allowed["pragma"] = true
	}
	if !allowed[strings.ToLower(match[1])] {
		return QueryResult{}, errors.New("read-only mode only allows SELECT, WITH, and EXPLAIN queries")
	}
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return QueryResult{}, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(query)
	if err != nil {
		return QueryResult{}, err
	}
	defer rows.Close()
	data, err := scanRowsLimited(rows, 1000)
	if err != nil {
		return QueryResult{}, err
	}
	if err := rows.Close(); err != nil {
		return QueryResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return QueryResult{}, err
	}
	return QueryResult{Columns: data.Columns, Rows: data.Rows, RowsAffected: int64(len(data.Rows)), DurationMs: time.Since(started).Milliseconds(), Message: fmt.Sprintf("Returned %d row(s)", len(data.Rows))}, nil
}

func ensureTable(db *sql.DB, driver, schema, table string) error {
	var found string
	var err error
	if driver == driverPostgres {
		err = db.QueryRow(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`, schema, table).Scan(&found)
	} else {
		err = db.QueryRow(`SELECT name FROM sqlite_master WHERE name = ? AND type IN ('table','view')`, table).Scan(&found)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("table or view not found")
	}
	return err
}

func quoteIdentifier(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }

func qualifiedIdentifier(schema, table string) string {
	if schema == "" || schema == "main" {
		return quoteIdentifier(table)
	}
	return quoteIdentifier(schema) + "." + quoteIdentifier(table)
}

func defaultSchema(driver string) string {
	if driver == driverPostgres {
		return "public"
	}
	return "main"
}

func placeholder(driver string, index int) string {
	if driver == driverPostgres {
		return "$" + strconv.Itoa(index)
	}
	return "?"
}

func sqliteDSN(path string, readOnly bool) string {
	normalized := filepath.ToSlash(path)
	if len(path) >= 2 && path[1] == ':' {
		normalized = strings.ReplaceAll(path, `\`, "/")
		if !strings.HasPrefix(normalized, "/") {
			normalized = "/" + normalized
		}
	}
	mode := "rw"
	if readOnly {
		mode = "ro"
	}
	return (&url.URL{Scheme: "file", Path: normalized, RawQuery: "mode=" + mode}).String()
}

func postgresTableSchema(db *sql.DB, schema, table string) ([]ColumnInfo, error) {
	rows, err := db.Query(`
		SELECT attribute.attname,
		       CASE
		         WHEN data_type.typtype IN ('e', 'd')
		           THEN quote_ident(type_namespace.nspname) || '.' || quote_ident(data_type.typname)
		         ELSE pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
		       END,
		       NOT attribute.attnotnull,
		       pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid),
		       EXISTS (
		         SELECT 1
		         FROM pg_catalog.pg_index indexed
		         WHERE indexed.indrelid = table_class.oid
		           AND indexed.indisprimary
		           AND attribute.attnum = ANY(indexed.indkey)
		       )
		FROM pg_catalog.pg_attribute attribute
		JOIN pg_catalog.pg_class table_class ON table_class.oid = attribute.attrelid
		JOIN pg_catalog.pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
		JOIN pg_catalog.pg_type data_type ON data_type.oid = attribute.atttypid
		JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid = data_type.typnamespace
		LEFT JOIN pg_catalog.pg_attrdef default_value
		  ON default_value.adrelid = attribute.attrelid
		 AND default_value.adnum = attribute.attnum
		WHERE table_namespace.nspname = $1
		  AND table_class.relname = $2
		  AND attribute.attnum > 0
		  AND NOT attribute.attisdropped
		ORDER BY attribute.attnum`, schema, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make([]ColumnInfo, 0)
	for rows.Next() {
		var column ColumnInfo
		if err := rows.Scan(&column.Name, &column.Type, &column.Nullable, &column.Default, &column.PrimaryKey); err != nil {
			return nil, err
		}
		columns = append(columns, column)
	}
	return columns, rows.Err()
}

func sqliteTableIndexes(db *sql.DB, schema, table string) ([]IndexInfo, error) {
	rows, err := db.Query(`PRAGMA ` + quoteIdentifier(schema) + `.index_list(` + quoteIdentifier(table) + `)`)
	if err != nil {
		return nil, fmt.Errorf("list indexes: %w", err)
	}
	indexes := make([]IndexInfo, 0)
	for rows.Next() {
		var sequence, unique, partial int
		var index IndexInfo
		var origin string
		if err := rows.Scan(&sequence, &index.Name, &unique, &origin, &partial); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("read index: %w", err)
		}
		index.Type = "btree"
		index.Columns = make([]string, 0)
		index.Unique = unique != 0
		index.Primary = origin == "pk"
		index.Partial = partial != 0
		indexes = append(indexes, index)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("list indexes: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close index list: %w", err)
	}
	for i := range indexes {
		columns, err := db.Query(`PRAGMA ` + quoteIdentifier(schema) + `.index_xinfo(` + quoteIdentifier(indexes[i].Name) + `)`)
		if err != nil {
			return nil, fmt.Errorf("inspect index %q: %w", indexes[i].Name, err)
		}
		for columns.Next() {
			var sequence, columnID, descending, key int
			var name, collation sql.NullString
			if err := columns.Scan(&sequence, &columnID, &name, &descending, &collation, &key); err != nil {
				_ = columns.Close()
				return nil, fmt.Errorf("read index %q column: %w", indexes[i].Name, err)
			}
			if key == 0 {
				continue
			}
			switch {
			case name.Valid:
				indexes[i].Columns = append(indexes[i].Columns, name.String)
			case columnID == -1:
				indexes[i].Columns = append(indexes[i].Columns, "rowid")
			default:
				indexes[i].Columns = append(indexes[i].Columns, "(expression)")
			}
		}
		if err := columns.Err(); err != nil {
			_ = columns.Close()
			return nil, fmt.Errorf("inspect index %q: %w", indexes[i].Name, err)
		}
		if err := columns.Close(); err != nil {
			return nil, fmt.Errorf("close index %q columns: %w", indexes[i].Name, err)
		}
	}
	return indexes, nil
}

func postgresTableIndexes(db *sql.DB, schema, table string) ([]IndexInfo, error) {
	rows, err := db.Query(`
		SELECT index_class.relname,
		       access_method.amname,
		       indexed.indisunique,
		       indexed.indisprimary,
		       indexed.indpred IS NOT NULL,
		       key.position,
		       pg_get_indexdef(indexed.indexrelid, key.position::integer, true)
		FROM pg_catalog.pg_index indexed
		JOIN pg_catalog.pg_class table_class ON table_class.oid = indexed.indrelid
		JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
		JOIN pg_catalog.pg_class index_class ON index_class.oid = indexed.indexrelid
		JOIN pg_catalog.pg_am access_method ON access_method.oid = index_class.relam
		CROSS JOIN LATERAL unnest(indexed.indkey) WITH ORDINALITY AS key(attribute_number, position)
		WHERE namespace.nspname = $1
		  AND table_class.relname = $2
		  AND key.position <= indexed.indnkeyatts
		ORDER BY index_class.relname, key.position`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("list indexes: %w", err)
	}
	defer rows.Close()
	indexes := make([]IndexInfo, 0)
	positions := make(map[string]int)
	for rows.Next() {
		var name, indexType, column string
		var unique, primary, partial bool
		var position int
		if err := rows.Scan(&name, &indexType, &unique, &primary, &partial, &position, &column); err != nil {
			return nil, fmt.Errorf("read index: %w", err)
		}
		indexPosition, ok := positions[name]
		if !ok {
			indexPosition = len(indexes)
			positions[name] = indexPosition
			indexes = append(indexes, IndexInfo{Name: name, Type: indexType, Columns: make([]string, 0), Unique: unique, Primary: primary, Partial: partial})
		}
		indexes[indexPosition].Columns = append(indexes[indexPosition].Columns, column)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list indexes: %w", err)
	}
	return indexes, nil
}

func scanRows(rows *sql.Rows) (TableData, error) { return scanRowsLimited(rows, maxPageSize) }

func scanRowsLimited(rows *sql.Rows, max int) (TableData, error) {
	columns, err := rows.Columns()
	if err != nil {
		return TableData{}, err
	}
	result := TableData{Columns: columns, Rows: make([][]any, 0)}
	for rows.Next() {
		if len(result.Rows) >= max {
			break
		}
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return TableData{}, err
		}
		for i, value := range values {
			if bytes, ok := value.([]byte); ok {
				values[i] = string(bytes)
			}
		}
		result.Rows = append(result.Rows, values)
	}
	return result, rows.Err()
}
