package main

import (
	"errors"
	"fmt"
	"strings"
)

// consoleStatementOperation classifies one SQL statement without trusting the
// renderer's statement splitter. CTE bodies are nested, so the first operation
// token after WITH is the statement that will actually execute.
func consoleStatementOperation(query string) (string, error) {
	words, err := topLevelSQLWords(query)
	if err != nil {
		return "", err
	}
	if len(words) == 0 {
		return "", errors.New("query is empty")
	}
	if words[0] != "with" {
		return words[0], nil
	}
	for _, word := range words[1:] {
		switch word {
		case "select", "insert", "update", "delete", "merge", "replace", "values", "table":
			return word, nil
		}
	}
	return "", errors.New("unable to find the statement after WITH")
}

func topLevelSQLWords(query string) ([]string, error) {
	words := make([]string, 0, 8)
	depth := 0
	ended := false
	for index := 0; index < len(query); {
		current := query[index]
		if isSQLSpace(current) {
			index++
			continue
		}
		if index+1 < len(query) && query[index:index+2] == "--" {
			if newline := strings.IndexByte(query[index+2:], '\n'); newline >= 0 {
				index += newline + 3
			} else {
				break
			}
			continue
		}
		if index+1 < len(query) && query[index:index+2] == "/*" {
			level := 1
			index += 2
			for index < len(query) && level > 0 {
				switch {
				case index+1 < len(query) && query[index:index+2] == "/*":
					level++
					index += 2
				case index+1 < len(query) && query[index:index+2] == "*/":
					level--
					index += 2
				default:
					index++
				}
			}
			if level != 0 {
				return nil, errors.New("unterminated SQL comment")
			}
			continue
		}
		if ended {
			return nil, errors.New("the query console accepts exactly one statement")
		}
		switch current {
		case '\'', '"', '`':
			next, err := skipSQLQuoted(query, index, current)
			if err != nil {
				return nil, err
			}
			index = next
			continue
		case '[':
			closing := strings.IndexByte(query[index+1:], ']')
			if closing < 0 {
				return nil, errors.New("unterminated bracketed SQL identifier")
			}
			index += closing + 2
			continue
		case '$':
			if tag, ok := sqlDollarQuoteTag(query[index:]); ok {
				closing := strings.Index(query[index+len(tag):], tag)
				if closing < 0 {
					return nil, errors.New("unterminated dollar-quoted SQL body")
				}
				index += len(tag) + closing + len(tag)
				continue
			}
		case '(':
			depth++
			index++
			continue
		case ')':
			if depth == 0 {
				return nil, errors.New("unbalanced SQL parentheses")
			}
			depth--
			index++
			continue
		case ';':
			if depth == 0 {
				ended = true
			}
			index++
			continue
		}
		if isSQLWordStart(current) {
			start := index
			for index < len(query) && isSQLWordPart(query[index]) {
				index++
			}
			if depth == 0 {
				words = append(words, strings.ToLower(query[start:index]))
			}
			continue
		}
		index++
	}
	if depth != 0 {
		return nil, errors.New("unbalanced SQL parentheses")
	}
	return words, nil
}

func skipSQLQuoted(query string, start int, quote byte) (int, error) {
	for index := start + 1; index < len(query); index++ {
		if query[index] != quote {
			continue
		}
		if index+1 < len(query) && query[index+1] == quote {
			index++
			continue
		}
		return index + 1, nil
	}
	return 0, fmt.Errorf("unterminated %q SQL value", quote)
}

func sqlDollarQuoteTag(value string) (string, bool) {
	if len(value) < 2 || value[0] != '$' {
		return "", false
	}
	for index := 1; index < len(value); index++ {
		if value[index] == '$' {
			return value[:index+1], true
		}
		if !isSQLWordPart(value[index]) {
			return "", false
		}
	}
	return "", false
}

func isSQLSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n' || value == '\f'
}
