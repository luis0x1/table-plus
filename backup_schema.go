package main

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// backupObject carries data-definition SQL produced by the source database
// itself. Rebuilding DDL from introspected column metadata silently drops
// foreign keys, CHECK and UNIQUE constraints, collations, generated columns,
// partial and expression indexes, views and triggers, so a backup stores what
// the server reports rather than an approximation of it.
type backupObject struct {
	Kind   string `json:"kind"`
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Table  string `json:"table,omitempty"`
	SQL    string `json:"sql"`
}

const (
	objectTable      = "table"
	objectConstraint = "constraint"
	objectFunction   = "function"
	objectIndex      = "index"
	objectView       = "view"
	objectTrigger    = "trigger"
)

// Restoring replays SQL read from a file, so every statement must still be the
// kind of statement its manifest entry claims it is.
var backupObjectPrefixes = map[string]*regexp.Regexp{
	objectTable:      regexp.MustCompile(`(?is)^create\s+table\s`),
	objectConstraint: regexp.MustCompile(`(?is)^alter\s+table\s`),
	objectFunction:   regexp.MustCompile(`(?is)^create\s+(or\s+replace\s+)?(function|procedure)\s`),
	objectIndex:      regexp.MustCompile(`(?is)^create\s+(unique\s+)?index\s`),
	objectView:       regexp.MustCompile(`(?is)^create\s+(or\s+replace\s+)?(materialized\s+)?view\s`),
	objectTrigger:    regexp.MustCompile(`(?is)^create\s+(constraint\s+)?trigger\s`),
}

func validateBackupObject(object backupObject) error {
	statement := strings.TrimSpace(object.SQL)
	prefix, known := backupObjectPrefixes[object.Kind]
	if !known {
		return fmt.Errorf("backup contains an unsupported schema object kind %q", object.Kind)
	}
	if statement == "" || !prefix.MatchString(statement) {
		return fmt.Errorf("backup object %s %q does not contain a matching statement", object.Kind, object.Name)
	}
	scanner := newRestoreSQLScanner(strings.NewReader(statement))
	parsed, err := scanner.Next()
	if err != nil {
		return fmt.Errorf("backup object %s %q is malformed: %w", object.Kind, object.Name, err)
	}
	if trailing, nextErr := scanner.Next(); !errors.Is(nextErr, io.EOF) {
		if nextErr != nil {
			return fmt.Errorf("backup object %s %q is malformed: %w", object.Kind, object.Name, nextErr)
		}
		return fmt.Errorf("backup object %s %q contains a trailing statement %q", object.Kind, object.Name, trailing)
	}
	if err := validateBackupObjectIdentity(object, parsed); err != nil {
		return err
	}
	return nil
}

type backupSQLToken struct {
	text   string
	quoted bool
}

func validateBackupObjectIdentity(object backupObject, statement string) error {
	tokens, err := backupSQLHeaderTokens(statement)
	if err != nil {
		return fmt.Errorf("backup object %s %q is malformed: %w", object.Kind, object.Name, err)
	}
	position := 0
	consume := func(word string) bool {
		if position >= len(tokens) || tokens[position].quoted || !strings.EqualFold(tokens[position].text, word) {
			return false
		}
		position++
		return true
	}
	if !consume("create") && object.Kind != objectConstraint {
		return backupIdentityError(object)
	}
	switch object.Kind {
	case objectTable:
		if consume("temp") || consume("temporary") {
		}
		if !consume("table") {
			return backupIdentityError(object)
		}
		consumeOptionalWords(tokens, &position, "if", "not", "exists")
		return validateParsedObjectName(object, tokens, position, object.Schema, object.Name)
	case objectView:
		consumeOptionalWords(tokens, &position, "or", "replace")
		consume("materialized")
		if !consume("view") {
			return backupIdentityError(object)
		}
		return validateParsedObjectName(object, tokens, position, object.Schema, object.Name)
	case objectFunction:
		consumeOptionalWords(tokens, &position, "or", "replace")
		if !consume("function") && !consume("procedure") {
			return backupIdentityError(object)
		}
		return validateParsedObjectName(object, tokens, position, object.Schema, object.Name)
	case objectIndex:
		consume("unique")
		if !consume("index") {
			return backupIdentityError(object)
		}
		consumeOptionalWords(tokens, &position, "if", "not", "exists")
		next, err := validateParsedObjectNameAtOptionalSchema(object, tokens, position, object.Schema, object.Name, true)
		if err != nil {
			return err
		}
		on := findBackupSQLWord(tokens, next, "on")
		if on < 0 {
			return backupIdentityError(object)
		}
		return validateParsedObjectName(object, tokens, on+1, object.Schema, object.Table)
	case objectTrigger:
		consume("constraint")
		if !consume("trigger") {
			return backupIdentityError(object)
		}
		next, err := validateParsedObjectNameAt(object, tokens, position, "", object.Name)
		if err != nil {
			return err
		}
		on := findBackupSQLWord(tokens, next, "on")
		if on < 0 {
			return backupIdentityError(object)
		}
		return validateParsedObjectName(object, tokens, on+1, object.Schema, object.Table)
	case objectConstraint:
		position = 0
		if !consume("alter") || !consume("table") {
			return backupIdentityError(object)
		}
		next, err := validateParsedObjectNameAt(object, tokens, position, object.Schema, object.Table)
		if err != nil {
			return err
		}
		position = next
		if !consume("add") {
			return backupIdentityError(object)
		}
		consume("constraint")
		return validateParsedObjectName(object, tokens, position, "", object.Name)
	default:
		return backupIdentityError(object)
	}
}

func consumeOptionalWords(tokens []backupSQLToken, position *int, words ...string) {
	start := *position
	for _, word := range words {
		if *position >= len(tokens) || tokens[*position].quoted || !strings.EqualFold(tokens[*position].text, word) {
			*position = start
			return
		}
		*position++
	}
}

func findBackupSQLWord(tokens []backupSQLToken, start int, word string) int {
	for index := start; index < len(tokens); index++ {
		if !tokens[index].quoted && strings.EqualFold(tokens[index].text, word) {
			return index
		}
	}
	return -1
}

func validateParsedObjectName(object backupObject, tokens []backupSQLToken, start int, schema, name string) error {
	_, err := validateParsedObjectNameAt(object, tokens, start, schema, name)
	return err
}

func validateParsedObjectNameAt(object backupObject, tokens []backupSQLToken, start int, schema, name string) (int, error) {
	return validateParsedObjectNameAtOptionalSchema(object, tokens, start, schema, name, false)
}

func validateParsedObjectNameAtOptionalSchema(object backupObject, tokens []backupSQLToken, start int, schema, name string, allowMissingSchema bool) (int, error) {
	first, next, ok := readBackupIdentifier(tokens, start)
	if !ok {
		return start, backupIdentityError(object)
	}
	actualSchema, actualName := "", first.text
	nameQuoted := first.quoted
	if next < len(tokens) && tokens[next].text == "." {
		second, end, ok := readBackupIdentifier(tokens, next+1)
		if !ok {
			return start, backupIdentityError(object)
		}
		actualSchema, actualName, nameQuoted, next = first.text, second.text, second.quoted, end
	}
	if !backupIdentifierEqual(actualName, name, nameQuoted) {
		return start, backupIdentityError(object)
	}
	if actualSchema != "" && !backupIdentifierEqual(actualSchema, schema, first.quoted) {
		return start, backupIdentityError(object)
	}
	if actualSchema == "" && schema != "" && schema != "main" && !allowMissingSchema {
		return start, backupIdentityError(object)
	}
	return next, nil
}

func readBackupIdentifier(tokens []backupSQLToken, position int) (backupSQLToken, int, bool) {
	if position >= len(tokens) || tokens[position].text == "." || tokens[position].text == "(" || tokens[position].text == ")" {
		return backupSQLToken{}, position, false
	}
	return tokens[position], position + 1, true
}

func backupIdentifierEqual(actual, expected string, quoted bool) bool {
	if quoted {
		return actual == expected
	}
	return strings.EqualFold(actual, expected)
}

func backupIdentityError(object backupObject) error {
	return fmt.Errorf("backup %s SQL does not create manifest object %s.%s", object.Kind, object.Schema, object.Name)
}

func backupSQLHeaderTokens(statement string) ([]backupSQLToken, error) {
	tokens := make([]backupSQLToken, 0, 32)
	for index := 0; index < len(statement) && len(tokens) < 128; {
		value := statement[index]
		if isSQLSpace(value) {
			index++
			continue
		}
		if index+1 < len(statement) && statement[index:index+2] == "--" {
			newline := strings.IndexByte(statement[index+2:], '\n')
			if newline < 0 {
				break
			}
			index += newline + 3
			continue
		}
		if index+1 < len(statement) && statement[index:index+2] == "/*" {
			end := strings.Index(statement[index+2:], "*/")
			if end < 0 {
				return nil, errors.New("unterminated SQL comment")
			}
			index += end + 4
			continue
		}
		if value == '\'' || value == '$' {
			break
		}
		if value == '"' || value == '`' || value == '[' {
			closing := value
			if value == '[' {
				closing = ']'
			}
			index++
			var text strings.Builder
			closed := false
			for index < len(statement) {
				if statement[index] != closing {
					text.WriteByte(statement[index])
					index++
					continue
				}
				if index+1 < len(statement) && statement[index+1] == closing {
					text.WriteByte(closing)
					index += 2
					continue
				}
				index++
				tokens = append(tokens, backupSQLToken{text: text.String(), quoted: true})
				closed = true
				break
			}
			if !closed {
				return nil, errors.New("unterminated quoted identifier")
			}
			continue
		}
		if isSQLWordStart(value) {
			start := index
			for index < len(statement) && isSQLWordPart(statement[index]) {
				index++
			}
			tokens = append(tokens, backupSQLToken{text: statement[start:index]})
			continue
		}
		if value == '.' || value == '(' || value == ')' || value == ',' || value == ';' {
			tokens = append(tokens, backupSQLToken{text: string(value)})
		}
		index++
	}
	return tokens, nil
}

// backupSchemaObjects returns the archived tables' DDL plus everything that
// depends on them, ordered so that replaying the slice in order succeeds.
func backupSchemaObjects(db *sql.DB, driver string, tables []backupTable) ([]backupObject, error) {
	if driver == driverPostgres {
		return postgresSchemaObjects(db, tables)
	}
	return sqliteSchemaObjects(db, tables)
}

// SQLite keeps the original statement for every object, so a backup can carry
// it verbatim.
func sqliteSchemaObjects(db *sql.DB, tables []backupTable) ([]backupObject, error) {
	archived := make(map[string]bool, len(tables))
	for _, table := range tables {
		archived[table.Name] = true
	}
	rows, err := db.Query(`
		SELECT type, name, COALESCE(tbl_name, ''), sql
		FROM sqlite_master
		WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\_%' ESCAPE '\'`)
	if err != nil {
		return nil, fmt.Errorf("read SQLite schema: %w", err)
	}
	defer rows.Close()
	type entry struct{ kind, name, owner, ddl string }
	entries := make([]entry, 0)
	views := make(map[string]bool)
	for rows.Next() {
		var item entry
		if err := rows.Scan(&item.kind, &item.name, &item.owner, &item.ddl); err != nil {
			return nil, fmt.Errorf("read SQLite schema: %w", err)
		}
		if item.kind == "view" {
			views[item.name] = true
		}
		entries = append(entries, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read SQLite schema: %w", err)
	}
	// Tables, then the objects that can only exist once their table does. Within
	// a pass the sqlite_master order is kept, which is creation order, so a view
	// built on another view still follows it.
	passes := []string{"table", "index", "view", "trigger"}
	kinds := map[string]string{"table": objectTable, "index": objectIndex, "view": objectView, "trigger": objectTrigger}
	objects := make([]backupObject, 0, len(entries))
	for _, pass := range passes {
		for _, item := range entries {
			if item.kind != pass {
				continue
			}
			switch item.kind {
			case "table":
				if !archived[item.name] {
					continue
				}
			case "index", "trigger":
				if !archived[item.owner] && !views[item.owner] {
					continue
				}
			}
			owner := item.owner
			if item.kind == "table" || item.kind == "view" {
				owner = ""
			}
			objects = append(objects, backupObject{Kind: kinds[item.kind], Schema: "main", Name: item.name, Table: owner, SQL: item.ddl})
		}
	}
	return objects, nil
}

// PostgreSQL has no stored statement, but it can render every part of one.
// Each fragment below comes from a pg_get_*def function or format_type, so the
// result carries the server's own definition rather than a guess at it.
func postgresSchemaObjects(db *sql.DB, tables []backupTable) ([]backupObject, error) {
	objects := make([]backupObject, 0, len(tables)*3)
	foreignKeys := make([]backupObject, 0)
	for _, table := range tables {
		create, foreign, err := postgresCreateTable(db, table.Schema, table.Name)
		if err != nil {
			return nil, err
		}
		objects = append(objects, create)
		foreignKeys = append(foreignKeys, foreign...)
	}
	// Foreign keys are added after the rows land so loading order cannot violate
	// them and so a referenced table always exists by then.
	objects = append(objects, foreignKeys...)
	routines, err := postgresRoutines(db)
	if err != nil {
		return nil, err
	}
	objects = append(objects, routines...)
	for _, table := range tables {
		indexes, err := postgresIndexes(db, table.Schema, table.Name)
		if err != nil {
			return nil, err
		}
		objects = append(objects, indexes...)
	}
	views, err := postgresViews(db)
	if err != nil {
		return nil, err
	}
	objects = append(objects, views...)
	triggers, err := postgresTriggers(db)
	if err != nil {
		return nil, err
	}
	return append(objects, triggers...), nil
}

func postgresCreateTable(db *sql.DB, schema, table string) (backupObject, []backupObject, error) {
	qualified := qualifiedIdentifier(schema, table)
	rows, err := db.Query(`
		SELECT a.attname,
		       pg_catalog.format_type(a.atttypid, a.atttypmod),
		       a.attnotnull,
		       COALESCE(pg_get_expr(d.adbin, d.adrelid), ''),
		       a.attidentity,
		       a.attgenerated,
		       CASE WHEN a.attcollation <> t.typcollation THEN COALESCE(quote_ident(coll.collname), '') ELSE '' END
		FROM pg_attribute a
		JOIN pg_class rel ON rel.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = rel.relnamespace
		JOIN pg_type t ON t.oid = a.atttypid
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
		WHERE n.nspname = $1 AND rel.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`, schema, table)
	if err != nil {
		return backupObject{}, nil, fmt.Errorf("read columns for %s.%s: %w", schema, table, err)
	}
	defer rows.Close()
	definitions := make([]string, 0)
	for rows.Next() {
		var name, dataType, defaultExpr, identity, generated, collation string
		var notNull bool
		if err := rows.Scan(&name, &dataType, &notNull, &defaultExpr, &identity, &generated, &collation); err != nil {
			return backupObject{}, nil, fmt.Errorf("read columns for %s.%s: %w", schema, table, err)
		}
		definition := quoteIdentifier(name) + " " + dataType
		if collation != "" {
			definition += " COLLATE " + collation
		}
		switch {
		case generated == "s":
			definition += " GENERATED ALWAYS AS (" + defaultExpr + ") STORED"
		case identity == "a":
			definition += " GENERATED ALWAYS AS IDENTITY"
		case identity == "d":
			definition += " GENERATED BY DEFAULT AS IDENTITY"
		case defaultExpr != "":
			definition += " DEFAULT " + defaultExpr
		}
		if notNull {
			definition += " NOT NULL"
		}
		definitions = append(definitions, definition)
	}
	if err := rows.Err(); err != nil {
		return backupObject{}, nil, fmt.Errorf("read columns for %s.%s: %w", schema, table, err)
	}
	if len(definitions) == 0 {
		return backupObject{}, nil, fmt.Errorf("read columns for %s.%s: table has no readable columns", schema, table)
	}
	constraints, err := db.Query(`
		SELECT conname, pg_get_constraintdef(oid), contype
		FROM pg_constraint
		WHERE conrelid = $1::regclass
		ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 ELSE 3 END, conname`, qualified)
	if err != nil {
		return backupObject{}, nil, fmt.Errorf("read constraints for %s.%s: %w", schema, table, err)
	}
	defer constraints.Close()
	foreign := make([]backupObject, 0)
	for constraints.Next() {
		var name, definition, kind string
		if err := constraints.Scan(&name, &definition, &kind); err != nil {
			return backupObject{}, nil, fmt.Errorf("read constraints for %s.%s: %w", schema, table, err)
		}
		switch kind {
		case "p", "u", "c":
			definitions = append(definitions, "CONSTRAINT "+quoteIdentifier(name)+" "+definition)
		case "f":
			foreign = append(foreign, backupObject{Kind: objectConstraint, Schema: schema, Name: name, Table: table,
				SQL: "ALTER TABLE " + qualified + " ADD CONSTRAINT " + quoteIdentifier(name) + " " + definition})
		}
	}
	if err := constraints.Err(); err != nil {
		return backupObject{}, nil, fmt.Errorf("read constraints for %s.%s: %w", schema, table, err)
	}
	create := backupObject{Kind: objectTable, Schema: schema, Name: table,
		SQL: "CREATE TABLE " + qualified + " (" + strings.Join(definitions, ", ") + ")"}
	return create, foreign, nil
}

func postgresIndexes(db *sql.DB, schema, table string) ([]backupObject, error) {
	// Indexes that implement a constraint arrive with the constraint itself.
	rows, err := db.Query(`
		SELECT ic.relname, pg_get_indexdef(i.indexrelid)
		FROM pg_index i
		JOIN pg_class ic ON ic.oid = i.indexrelid
		WHERE i.indrelid = $1::regclass
		  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
		ORDER BY ic.relname`, qualifiedIdentifier(schema, table))
	if err != nil {
		return nil, fmt.Errorf("read indexes for %s.%s: %w", schema, table, err)
	}
	defer rows.Close()
	objects := make([]backupObject, 0)
	for rows.Next() {
		var name, definition string
		if err := rows.Scan(&name, &definition); err != nil {
			return nil, fmt.Errorf("read indexes for %s.%s: %w", schema, table, err)
		}
		objects = append(objects, backupObject{Kind: objectIndex, Schema: schema, Name: name, Table: table, SQL: definition})
	}
	return objects, rows.Err()
}

func postgresRoutines(db *sql.DB) ([]backupObject, error) {
	// Triggers cannot be restored without the functions they call.
	rows, err := db.Query(`
		SELECT n.nspname, p.proname, pg_get_functiondef(p.oid)
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
		  AND n.nspname NOT LIKE 'pg\_%'
		  AND p.prokind IN ('f', 'p')
		ORDER BY p.oid`)
	if err != nil {
		return nil, fmt.Errorf("read routines: %w", err)
	}
	defer rows.Close()
	objects := make([]backupObject, 0)
	for rows.Next() {
		var schema, name, definition string
		if err := rows.Scan(&schema, &name, &definition); err != nil {
			return nil, fmt.Errorf("read routines: %w", err)
		}
		objects = append(objects, backupObject{Kind: objectFunction, Schema: schema, Name: name, SQL: definition})
	}
	return objects, rows.Err()
}

func postgresViews(db *sql.DB) ([]backupObject, error) {
	// Ordering by oid follows creation order, so a view built on another view
	// still comes after it.
	rows, err := db.Query(`
		SELECT n.nspname, c.relname, c.relkind, pg_get_viewdef(c.oid, true)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN ('v', 'm')
		  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		  AND n.nspname NOT LIKE 'pg\_%'
		ORDER BY c.oid`)
	if err != nil {
		return nil, fmt.Errorf("read views: %w", err)
	}
	defer rows.Close()
	objects := make([]backupObject, 0)
	for rows.Next() {
		var schema, name, kind, definition string
		if err := rows.Scan(&schema, &name, &kind, &definition); err != nil {
			return nil, fmt.Errorf("read views: %w", err)
		}
		statement := "CREATE VIEW "
		if kind == "m" {
			statement = "CREATE MATERIALIZED VIEW "
		}
		objects = append(objects, backupObject{Kind: objectView, Schema: schema, Name: name,
			SQL: statement + qualifiedIdentifier(schema, name) + " AS " + strings.TrimSuffix(strings.TrimSpace(definition), ";")})
	}
	return objects, rows.Err()
}

func postgresTriggers(db *sql.DB) ([]backupObject, error) {
	rows, err := db.Query(`
		SELECT n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid, true)
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE NOT t.tgisinternal
		  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		  AND n.nspname NOT LIKE 'pg\_%'
		ORDER BY t.oid`)
	if err != nil {
		return nil, fmt.Errorf("read triggers: %w", err)
	}
	defer rows.Close()
	objects := make([]backupObject, 0)
	for rows.Next() {
		var schema, table, name, definition string
		if err := rows.Scan(&schema, &table, &name, &definition); err != nil {
			return nil, fmt.Errorf("read triggers: %w", err)
		}
		objects = append(objects, backupObject{Kind: objectTrigger, Schema: schema, Name: name, Table: table, SQL: definition})
	}
	return objects, rows.Err()
}

var materializedView = regexp.MustCompile(`(?is)^create\s+(or\s+replace\s+)?materialized\s+view\s`)

// dropBackupObjectSQL removes an object so the backup's definition replaces it
// rather than colliding with whatever the target database already had. Restoring
// treats the backup as authoritative for the objects it contains. Routines are
// created with CREATE OR REPLACE and need no drop.
func dropBackupObjectSQL(driver string, object backupObject) string {
	switch object.Kind {
	case objectIndex:
		if driver == driverPostgres {
			return "DROP INDEX IF EXISTS " + qualifiedIdentifier(object.Schema, object.Name)
		}
		return "DROP INDEX IF EXISTS " + quoteIdentifier(object.Name)
	case objectView:
		kind := "VIEW"
		if materializedView.MatchString(strings.TrimSpace(object.SQL)) {
			kind = "MATERIALIZED VIEW"
		}
		return "DROP " + kind + " IF EXISTS " + qualifiedIdentifier(object.Schema, object.Name)
	case objectTrigger:
		if driver == driverPostgres {
			if object.Table == "" {
				return ""
			}
			return "DROP TRIGGER IF EXISTS " + quoteIdentifier(object.Name) + " ON " + qualifiedIdentifier(object.Schema, object.Table)
		}
		return "DROP TRIGGER IF EXISTS " + quoteIdentifier(object.Name)
	case objectConstraint:
		if object.Table == "" {
			return ""
		}
		return "ALTER TABLE " + qualifiedIdentifier(object.Schema, object.Table) + " DROP CONSTRAINT IF EXISTS " + quoteIdentifier(object.Name)
	}
	return ""
}

// postgresColumnTraits reports the columns a restore must not write to, and
// whether the table has a GENERATED ALWAYS identity column, which an INSERT has
// to override explicitly. SQLite excludes generated columns from
// PRAGMA table_info already; PostgreSQL's catalogue does not.
func postgresColumnTraits(db *sql.DB, schema, table string) (map[string]bool, bool, error) {
	rows, err := db.Query(`
		SELECT a.attname, a.attgenerated, a.attidentity
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`, schema, table)
	if err != nil {
		return nil, false, fmt.Errorf("read column traits for %s.%s: %w", schema, table, err)
	}
	defer rows.Close()
	generated := make(map[string]bool)
	override := false
	for rows.Next() {
		var name, isGenerated, identity string
		if err := rows.Scan(&name, &isGenerated, &identity); err != nil {
			return nil, false, fmt.Errorf("read column traits for %s.%s: %w", schema, table, err)
		}
		if isGenerated != "" {
			generated[name] = true
		}
		if identity == "a" {
			override = true
		}
	}
	return generated, override, rows.Err()
}

var virtualTableModule = regexp.MustCompile(`(?is)^\s*create\s+virtual\s+table\s+(?:if\s+not\s+exists\s+)?\S+\s+using\s+([A-Za-z0-9_]+)`)

// sqliteVirtualTables maps each virtual table to the module that provides it.
// Their rows are produced by that module rather than stored, and a build without
// the module cannot even read their definition, so a backup cannot archive them.
func sqliteVirtualTables(db *sql.DB) (map[string]string, error) {
	rows, err := db.Query(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("read SQLite schema: %w", err)
	}
	defer rows.Close()
	modules := make(map[string]string)
	for rows.Next() {
		var name, ddl string
		if err := rows.Scan(&name, &ddl); err != nil {
			return nil, fmt.Errorf("read SQLite schema: %w", err)
		}
		if match := virtualTableModule.FindStringSubmatch(ddl); match != nil {
			modules[name] = match[1]
		}
	}
	return modules, rows.Err()
}

// sqliteAvailableModules lists the virtual table modules this build provides, so
// a skipped table can say whether its module is missing or merely derived.
func sqliteAvailableModules(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query(`SELECT name FROM pragma_module_list`)
	if err != nil {
		// Introspection pragmas are optional; without them every module is
		// reported as unknown rather than failing the caller.
		return map[string]bool{}, nil
	}
	defer rows.Close()
	modules := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("read SQLite modules: %w", err)
		}
		modules[strings.ToLower(name)] = true
	}
	return modules, rows.Err()
}
