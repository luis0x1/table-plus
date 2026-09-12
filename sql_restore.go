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
	return &restoreSQLScanner{file: file, reader: reader}, nil
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
		if !skipRestoreTransactionWrapper(statement) {
			statements++
		}
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
		statements++
		result, err := tx.Exec(statement)
		if err != nil {
			return rollback(fmt.Errorf("restore SQL statement %d (%s): %w", statements, restoreStatementSummary(statement), err))
		}
		if affected, err := result.RowsAffected(); err == nil && affected > 0 {
			rows += affected
		}
	}
	if statements == 0 {
		return rollback(errors.New("SQL dump does not contain any executable statements"))
	}
	if err := tx.Commit(); err != nil {
		return TransferResult{}, fmt.Errorf("commit SQL restore: %w", err)
	}
	tables, _ := a.ListTables()
	return TransferResult{Path: filepath.Clean(path), Tables: len(tables), Rows: rows, Statements: statements}, nil
}
