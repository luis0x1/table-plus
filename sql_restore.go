package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type restoreSQLState uint8

const (
	restoreSQLNormal restoreSQLState = iota
	restoreSQLSingleQuote
	restoreSQLDoubleQuote
	restoreSQLBacktick
	restoreSQLBracket
	restoreSQLLineComment
	restoreSQLBlockComment
	restoreSQLDollarQuote
)

// restoreSQLScanner streams one SQL statement at a time. It understands the
// constructs that commonly contain semicolons in database dumps: quoted text,
// comments, PostgreSQL dollar-quoted bodies, and SQLite trigger BEGIN/END
// blocks. Memory use is therefore bounded by the largest statement, not the
// size of the dump file.
type restoreSQLScanner struct {
	file             *os.File
	reader           *bufio.Reader
	statement        strings.Builder
	state            restoreSQLState
	blockDepth       int
	dollarTag        string
	hasCode          bool
	seenWord         bool
	triggerCandidate bool
	isTrigger        bool
	triggerBegin     int
	triggerCase      int
	lineStart        bool
	skippedMeta      int64
}

func openRestoreSQLScanner(path string) (*restoreSQLScanner, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open SQL dump: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("inspect SQL dump: %w", err)
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("SQL restore source must be a regular file")
	}
	reader := bufio.NewReaderSize(file, 64<<10)
	if marker, _ := reader.Peek(3); bytes.Equal(marker, []byte{0xef, 0xbb, 0xbf}) {
		_, _ = reader.Discard(3)
	}
	return &restoreSQLScanner{file: file, reader: reader, lineStart: true}, nil
}

func (scanner *restoreSQLScanner) Close() error { return scanner.file.Close() }

func isSQLWordStart(value byte) bool {
	return value == '_' || value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}

func isSQLWordPart(value byte) bool {
	return isSQLWordStart(value) || value >= '0' && value <= '9' || value == '$'
}

func isDollarTagPart(value byte, first bool) bool {
	if value == '_' || value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' {
		return true
	}
	return !first && value >= '0' && value <= '9'
}

func (scanner *restoreSQLScanner) beginDollarQuote() bool {
	for size := 1; size <= 128; size++ {
		data, err := scanner.reader.Peek(size)
		if err != nil {
			return false
		}
		value := data[size-1]
		if value == '$' {
			tag := append([]byte(nil), data...)
			if _, err := scanner.reader.Discard(size); err != nil {
				return false
			}
			scanner.statement.Write(tag)
			scanner.dollarTag = "$" + string(tag)
			scanner.state = restoreSQLDollarQuote
			return true
		}
		if !isDollarTagPart(value, size == 1) {
			return false
		}
	}
	return false
}

func (scanner *restoreSQLScanner) closeDollarQuote() bool {
	remainder := []byte(scanner.dollarTag[1:])
	data, err := scanner.reader.Peek(len(remainder))
	if err != nil || !bytes.Equal(data, remainder) {
		return false
	}
	closing := append([]byte(nil), data...)
	if _, err := scanner.reader.Discard(len(remainder)); err != nil {
		return false
	}
	scanner.statement.Write(closing)
	scanner.state = restoreSQLNormal
	scanner.dollarTag = ""
	return true
}

func (scanner *restoreSQLScanner) consumeNext() (byte, bool) {
	next, err := scanner.reader.ReadByte()
	if err != nil {
		return 0, false
	}
	scanner.statement.WriteByte(next)
	return next, true
}

func (scanner *restoreSQLScanner) processWord(word string) {
	word = strings.ToLower(word)
	if !scanner.seenWord {
		scanner.seenWord = true
		scanner.triggerCandidate = word == "create"
		return
	}
	if scanner.triggerCandidate && !scanner.isTrigger {
		switch word {
		case "or", "replace", "temp", "temporary", "constraint":
			return
		case "trigger":
			scanner.isTrigger = true
			scanner.triggerCandidate = false
		default:
			scanner.triggerCandidate = false
		}
	}
	if !scanner.isTrigger {
		return
	}
	switch word {
	case "begin":
		scanner.triggerBegin++
	case "case":
		if scanner.triggerBegin > 0 {
			scanner.triggerCase++
		}
	case "end":
		if scanner.triggerCase > 0 {
			scanner.triggerCase--
		} else if scanner.triggerBegin > 0 {
			scanner.triggerBegin--
		}
	}
}

func (scanner *restoreSQLScanner) resetStatement() {
	scanner.statement.Reset()
	scanner.hasCode = false
	scanner.seenWord = false
	scanner.triggerCandidate = false
	scanner.isTrigger = false
	scanner.triggerBegin = 0
	scanner.triggerCase = 0
}

func (scanner *restoreSQLScanner) finishStatement() string {
	statement := strings.TrimSpace(scanner.statement.String())
	hasCode := scanner.hasCode
	scanner.resetStatement()
	if !hasCode {
		return ""
	}
	return statement
}

func (scanner *restoreSQLScanner) Next() (string, error) {
	for {
		value, err := scanner.reader.ReadByte()
		if errors.Is(err, io.EOF) {
			if scanner.state == restoreSQLLineComment {
				scanner.state = restoreSQLNormal
			}
			if scanner.state != restoreSQLNormal {
				return "", errors.New("SQL dump ends inside a quote or block comment")
			}
			if statement := scanner.finishStatement(); statement != "" {
				return statement, nil
			}
			return "", io.EOF
		}
		if err != nil {
			return "", fmt.Errorf("read SQL dump: %w", err)
		}
		wasLineStart := scanner.lineStart
		scanner.lineStart = value == '\n'
		if scanner.state == restoreSQLNormal && wasLineStart && value == '\\' && !scanner.hasCode {
			// Plain pg_dump files can contain psql-only commands such as
			// \restrict, \unrestrict and \connect. They are not SQL and the
			// active QueryNest connection is already the restore target.
			if _, readErr := scanner.reader.ReadString('\n'); readErr != nil && !errors.Is(readErr, io.EOF) {
				return "", fmt.Errorf("read SQL dump command: %w", readErr)
			}
			scanner.lineStart = true
			scanner.skippedMeta++
			scanner.resetStatement()
			continue
		}
		scanner.statement.WriteByte(value)

		switch scanner.state {
		case restoreSQLLineComment:
			if value == '\n' {
				scanner.state = restoreSQLNormal
			}
			continue
		case restoreSQLBlockComment:
			if value == '/' {
				if next, _ := scanner.reader.Peek(1); len(next) == 1 && next[0] == '*' {
					scanner.consumeNext()
					scanner.blockDepth++
				}
			} else if value == '*' {
				if next, _ := scanner.reader.Peek(1); len(next) == 1 && next[0] == '/' {
					scanner.consumeNext()
					scanner.blockDepth--
					if scanner.blockDepth == 0 {
						scanner.state = restoreSQLNormal
					}
				}
			}
			continue
		case restoreSQLDollarQuote:
			if value == '$' {
				scanner.closeDollarQuote()
			}
			continue
		case restoreSQLSingleQuote, restoreSQLDoubleQuote, restoreSQLBacktick, restoreSQLBracket:
			closing := byte('\'')
			switch scanner.state {
			case restoreSQLDoubleQuote:
				closing = '"'
			case restoreSQLBacktick:
				closing = '`'
			case restoreSQLBracket:
				closing = ']'
			}
			if value != closing {
				continue
			}
			if next, _ := scanner.reader.Peek(1); len(next) == 1 && next[0] == closing {
				scanner.consumeNext()
				continue
			}
			scanner.state = restoreSQLNormal
			continue
		}

		if value == '-' {
			if next, _ := scanner.reader.Peek(1); len(next) == 1 && next[0] == '-' {
				scanner.consumeNext()
				scanner.state = restoreSQLLineComment
				continue
			}
		}
		if value == '/' {
			if next, _ := scanner.reader.Peek(1); len(next) == 1 && next[0] == '*' {
				scanner.consumeNext()
				scanner.state = restoreSQLBlockComment
				scanner.blockDepth = 1
				continue
			}
		}
		switch value {
		case '\'':
			scanner.state = restoreSQLSingleQuote
			scanner.hasCode = true
			continue
		case '"':
			scanner.state = restoreSQLDoubleQuote
			scanner.hasCode = true
			continue
		case '`':
			scanner.state = restoreSQLBacktick
			scanner.hasCode = true
			continue
		case '[':
			scanner.state = restoreSQLBracket
			scanner.hasCode = true
			continue
		case '$':
			if scanner.beginDollarQuote() {
				scanner.hasCode = true
				continue
			}
		}

		if isSQLWordStart(value) {
			word := []byte{value}
			for {
				next, err := scanner.reader.Peek(1)
				if err != nil || len(next) == 0 || !isSQLWordPart(next[0]) {
					break
				}
				part, ok := scanner.consumeNext()
				if !ok {
					break
				}
				word = append(word, part)
			}
			scanner.hasCode = true
			scanner.processWord(string(word))
			continue
		}
		if value == ';' {
			if !scanner.isTrigger || scanner.triggerBegin == 0 {
				if statement := scanner.finishStatement(); statement != "" {
					return statement, nil
				}
			}
			continue
		}
		if value != ' ' && value != '\t' && value != '\r' && value != '\n' {
			scanner.hasCode = true
		}
	}
}

func restoreSQLBody(statement string) string {
	body := strings.TrimSpace(statement)
	for body != "" {
		switch {
		case strings.HasPrefix(body, "--"):
			if newline := strings.IndexByte(body, '\n'); newline >= 0 {
				body = strings.TrimSpace(body[newline+1:])
				continue
			}
			return ""
		case strings.HasPrefix(body, "/*"):
			if end := strings.Index(body[2:], "*/"); end >= 0 {
				body = strings.TrimSpace(body[end+4:])
				continue
			}
			return ""
		default:
			return body
		}
	}
	return ""
}

var (
	pgDumpCopyPattern = regexp.MustCompile(`(?is)^copy\s+(.+?)\s*\((.*)\)\s+from\s+stdin(?:\s+with\s*\([^)]*\))?\s*;?\s*$`)
	ownerToPattern    = regexp.MustCompile(`(?is)\bowner\s+to\b`)
)

func splitPGDumpIdentifiers(value string, separator byte) ([]string, error) {
	parts := make([]string, 0, 2)
	start := 0
	quoted := false
	for index := 0; index < len(value); index++ {
		switch value[index] {
		case '"':
			if quoted && index+1 < len(value) && value[index+1] == '"' {
				index++
				continue
			}
			quoted = !quoted
		case separator:
			if !quoted {
				part := strings.TrimSpace(value[start:index])
				if part == "" {
					return nil, errors.New("empty identifier in COPY statement")
				}
				parts = append(parts, part)
				start = index + 1
			}
		}
	}
	if quoted {
		return nil, errors.New("unterminated quoted identifier in COPY statement")
	}
	part := strings.TrimSpace(value[start:])
	if part == "" {
		return nil, errors.New("empty identifier in COPY statement")
	}
	return append(parts, part), nil
}

func unquotePGDumpIdentifier(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, `"`) {
		if strings.ContainsAny(value, " \t\r\n\"") {
			return "", fmt.Errorf("invalid unquoted identifier %q", value)
		}
		return value, nil
	}
	if len(value) < 2 || !strings.HasSuffix(value, `"`) {
		return "", fmt.Errorf("unterminated quoted identifier %q", value)
	}
	return strings.ReplaceAll(value[1:len(value)-1], `""`, `"`), nil
}

func parsePGDumpCopyStatement(statement, driver string) (string, []string, bool, error) {
	body := restoreSQLBody(statement)
	match := pgDumpCopyPattern.FindStringSubmatch(body)
	if len(match) == 0 {
		return "", nil, false, nil
	}
	targetText := strings.TrimSpace(match[1])
	if strings.HasPrefix(strings.ToLower(targetText), "only ") {
		targetText = strings.TrimSpace(targetText[len("only "):])
	}
	targetParts, err := splitPGDumpIdentifiers(targetText, '.')
	if err != nil || len(targetParts) > 2 {
		if err == nil {
			err = errors.New("COPY target must be a table or schema-qualified table")
		}
		return "", nil, true, err
	}
	table, err := unquotePGDumpIdentifier(targetParts[len(targetParts)-1])
	if err != nil {
		return "", nil, true, err
	}
	schema := defaultSchema(driver)
	if len(targetParts) == 2 {
		schema, err = unquotePGDumpIdentifier(targetParts[0])
		if err != nil {
			return "", nil, true, err
		}
	}
	columnParts, err := splitPGDumpIdentifiers(match[2], ',')
	if err != nil {
		return "", nil, true, err
	}
	columns := make([]string, len(columnParts))
	quotedColumns := make([]string, len(columnParts))
	placeholders := make([]string, len(columnParts))
	for index, part := range columnParts {
		columns[index], err = unquotePGDumpIdentifier(part)
		if err != nil {
			return "", nil, true, err
		}
		quotedColumns[index] = quoteIdentifier(columns[index])
		placeholders[index] = placeholder(driver, index+1)
	}
	identityOverride := ""
	if driver == driverPostgres {
		// COPY FROM writes the supplied identity values. Preserve that behavior
		// when the text dump is streamed through parameterized INSERTs.
		identityOverride = " OVERRIDING SYSTEM VALUE"
	}
	query := fmt.Sprintf("INSERT INTO %s (%s)%s VALUES (%s)", qualifiedIdentifier(schema, table), strings.Join(quotedColumns, ", "), identityOverride, strings.Join(placeholders, ", "))
	return query, columns, true, nil
}

func decodePGDumpCopyValue(value string) (any, error) {
	if value == `\N` {
		return nil, nil
	}
	var decoded strings.Builder
	decoded.Grow(len(value))
	for index := 0; index < len(value); index++ {
		if value[index] != '\\' || index+1 >= len(value) {
			decoded.WriteByte(value[index])
			continue
		}
		index++
		escaped := value[index]
		switch escaped {
		case 'b':
			decoded.WriteByte('\b')
		case 'f':
			decoded.WriteByte('\f')
		case 'n':
			decoded.WriteByte('\n')
		case 'r':
			decoded.WriteByte('\r')
		case 't':
			decoded.WriteByte('\t')
		case 'v':
			decoded.WriteByte('\v')
		case 'x':
			start := index + 1
			end := start
			for end < len(value) && end < start+2 && (value[end] >= '0' && value[end] <= '9' || value[end] >= 'a' && value[end] <= 'f' || value[end] >= 'A' && value[end] <= 'F') {
				end++
			}
			if end == start {
				decoded.WriteByte('x')
				continue
			}
			parsed, err := strconv.ParseUint(value[start:end], 16, 8)
			if err != nil {
				return nil, fmt.Errorf("decode COPY hex escape: %w", err)
			}
			decoded.WriteByte(byte(parsed))
			index = end - 1
		default:
			if escaped >= '0' && escaped <= '7' {
				start := index
				end := start + 1
				for end < len(value) && end < start+3 && value[end] >= '0' && value[end] <= '7' {
					end++
				}
				parsed, err := strconv.ParseUint(value[start:end], 8, 8)
				if err != nil {
					return nil, fmt.Errorf("decode COPY octal escape: %w", err)
				}
				decoded.WriteByte(byte(parsed))
				index = end - 1
			} else {
				decoded.WriteByte(escaped)
			}
		}
	}
	return decoded.String(), nil
}

func (scanner *restoreSQLScanner) readCopyRows(columnCount int, consume func([]any) error) (int64, error) {
	remainder, err := scanner.reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, fmt.Errorf("read COPY data: %w", err)
	}
	if strings.TrimSpace(remainder) != "" {
		return 0, errors.New("COPY data must start on the line after FROM stdin")
	}
	if errors.Is(err, io.EOF) {
		return 0, errors.New("COPY data is missing its \\. terminator")
	}
	scanner.lineStart = true
	var rows int64
	for {
		line, readErr := scanner.reader.ReadString('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return rows, fmt.Errorf("read COPY row %d: %w", rows+1, readErr)
		}
		line = strings.TrimSuffix(line, "\n")
		line = strings.TrimSuffix(line, "\r")
		if line == `\.` {
			scanner.lineStart = true
			return rows, nil
		}
		if errors.Is(readErr, io.EOF) {
			return rows, errors.New("COPY data is missing its \\. terminator")
		}
		fields := strings.Split(line, "\t")
		if len(fields) != columnCount {
			return rows, fmt.Errorf("COPY row %d has %d values; expected %d", rows+1, len(fields), columnCount)
		}
		values := make([]any, len(fields))
		for index, field := range fields {
			values[index], err = decodePGDumpCopyValue(field)
			if err != nil {
				return rows, fmt.Errorf("decode COPY row %d column %d: %w", rows+1, index+1, err)
			}
		}
		if consume != nil {
			if err := consume(values); err != nil {
				return rows, err
			}
		}
		rows++
	}
}

func skipPortablePGDumpStatement(statement, driver string) bool {
	if driver != driverPostgres {
		return false
	}
	body := strings.ToLower(restoreSQLBody(statement))
	fields := strings.Fields(body)
	if len(fields) == 0 {
		return false
	}
	switch fields[0] {
	case "grant", "revoke":
		return true
	case "set":
		return len(fields) >= 2 && (fields[1] == "role" || fields[1] == "session" && len(fields) >= 3 && fields[2] == "authorization")
	case "reset":
		return len(fields) >= 2 && fields[1] == "role"
	case "alter":
		return ownerToPattern.MatchString(body) || len(fields) >= 2 && fields[1] == "database" || len(fields) >= 3 && fields[1] == "default" && fields[2] == "privileges"
	case "create", "drop":
		return len(fields) >= 2 && fields[1] == "database"
	case "comment":
		return len(fields) >= 3 && fields[1] == "on" && fields[2] == "database"
	default:
		return false
	}
}

func skipRestoreTransactionWrapper(statement string) bool {
	match := leadingKeyword.FindStringSubmatch(statement)
	if len(match) < 2 {
		return false
	}
	switch strings.ToLower(match[1]) {
	case "begin", "commit", "end", "start":
		return true
	default:
		return false
	}
}

func previewSQLRestore(path, driver, database string) (TransferPreview, error) {
	scanner, err := openRestoreSQLScanner(path)
	if err != nil {
		return TransferPreview{}, err
	}
	defer scanner.Close()
	statements := 0
	for {
		statement, err := scanner.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return TransferPreview{}, err
		}
		if skipRestoreTransactionWrapper(statement) || skipPortablePGDumpStatement(statement, driver) {
			continue
		}
		_, columns, copyStatement, err := parsePGDumpCopyStatement(statement, driver)
		if err != nil {
			return TransferPreview{}, fmt.Errorf("inspect COPY statement: %w", err)
		}
		if copyStatement {
			if _, err := scanner.readCopyRows(len(columns), nil); err != nil {
				return TransferPreview{}, err
			}
		}
		statements++
	}
	if statements == 0 {
		return TransferPreview{}, errors.New("SQL dump does not contain any executable statements")
	}
	return TransferPreview{Kind: "restore", Path: path, Format: "sql", Driver: driver, Database: database, Tables: []TransferTablePreview{}, Statements: statements}, nil
}

func restoreStatementSummary(statement string) string {
	compact := strings.Join(strings.Fields(statement), " ")
	if len(compact) > 100 {
		return compact[:97] + "..."
	}
	return compact
}

func (a *App) restoreSQLDatabase(path string) (TransferResult, error) {
	db, driver, readOnly, err := a.editableConnection()
	if err != nil {
		return TransferResult{}, err
	}
	if readOnly {
		return TransferResult{}, errors.New("this connection is read-only; reconnect with editing enabled")
	}
	scanner, err := openRestoreSQLScanner(path)
	if err != nil {
		return TransferResult{}, err
	}
	defer scanner.Close()

	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return TransferResult{}, fmt.Errorf("begin SQL restore: %w", err)
	}
	rollback := func(err error) (TransferResult, error) {
		_ = tx.Rollback()
		return TransferResult{}, err
	}
	if driver == driverSQLite {
		if _, err := tx.Exec(`PRAGMA defer_foreign_keys = ON`); err != nil {
			return rollback(fmt.Errorf("defer foreign keys for SQL restore: %w", err))
		}
	}

	statements := 0
	var rows int64
	var skipped int64
	for {
		statement, err := scanner.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return rollback(err)
		}
		if skipRestoreTransactionWrapper(statement) {
			continue
		}
		if skipPortablePGDumpStatement(statement, driver) {
			skipped++
			continue
		}
		statements++
		insertQuery, columns, copyStatement, err := parsePGDumpCopyStatement(statement, driver)
		if err != nil {
			return rollback(fmt.Errorf("restore SQL statement %d (%s): %w", statements, restoreStatementSummary(statement), err))
		}
		if copyStatement {
			prepared, err := tx.Prepare(insertQuery)
			if err != nil {
				return rollback(fmt.Errorf("prepare COPY statement %d (%s): %w", statements, restoreStatementSummary(statement), err))
			}
			copied, copyErr := scanner.readCopyRows(len(columns), func(values []any) error {
				if _, err := prepared.Exec(values...); err != nil {
					return fmt.Errorf("insert COPY row: %w", err)
				}
				return nil
			})
			closeErr := prepared.Close()
			if copyErr != nil {
				return rollback(fmt.Errorf("restore COPY statement %d (%s): %w", statements, restoreStatementSummary(statement), copyErr))
			}
			if closeErr != nil {
				return rollback(fmt.Errorf("close COPY statement %d: %w", statements, closeErr))
			}
			rows += copied
			continue
		}
		result, err := tx.Exec(statement)
		if err != nil {
			return rollback(fmt.Errorf("restore SQL statement %d (%s): %w", statements, restoreStatementSummary(statement), err))
		}
		if affected, err := result.RowsAffected(); err == nil && affected > 0 {
			rows += affected
		}
	}
	skipped += scanner.skippedMeta
	if statements == 0 {
		return rollback(errors.New("SQL dump does not contain any executable statements"))
	}
	if err := tx.Commit(); err != nil {
		return TransferResult{}, fmt.Errorf("commit SQL restore: %w", err)
	}
	tables, _ := a.ListTables()
	return TransferResult{Path: filepath.Clean(path), Tables: len(tables), Rows: rows, Skipped: skipped, Statements: statements}, nil
}
