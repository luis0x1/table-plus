package main

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
)

type RowOperation struct {
	Type       string         `json:"type"`
	Values     map[string]any `json:"values"`
	PrimaryKey map[string]any `json:"primaryKey"`
}

func (a *App) ApplyChanges(schema, table string, operations []RowOperation) (int64, error) {
	db, driver, readOnly, err := a.editableConnection()
	if err != nil {
		return 0, err
	}
	if readOnly {
		return 0, errors.New("this connection is read-only; reconnect with editing enabled")
	}
	if len(operations) == 0 {
		return 0, nil
	}
	if schema == "" {
		schema = defaultSchema(driver)
	}
	columns, err := a.GetTableSchema(schema, table)
	if err != nil {
		return 0, err
	}
	allowed := make(map[string]ColumnInfo, len(columns))
	primaryColumns := make([]string, 0)
	for _, column := range columns {
		allowed[column.Name] = column
		if column.PrimaryKey {
			primaryColumns = append(primaryColumns, column.Name)
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	var affectedTotal int64
	for _, operation := range operations {
		statement, args, err := buildRowOperation(driver, schema, table, operation, allowed, primaryColumns)
		if err != nil {
			_ = tx.Rollback()
			return 0, err
		}
		result, err := tx.Exec(statement, args...)
		if err != nil {
			_ = tx.Rollback()
			return 0, fmt.Errorf("apply %s: %w", operation.Type, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			_ = tx.Rollback()
			return 0, err
		}
		if (operation.Type == "update" || operation.Type == "delete") && affected != 1 {
			_ = tx.Rollback()
			return 0, fmt.Errorf("%s expected 1 row, affected %d; data may have changed", operation.Type, affected)
		}
		affectedTotal += affected
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return affectedTotal, nil
}

func buildRowOperation(driver, schema, table string, operation RowOperation, allowed map[string]ColumnInfo, primaryColumns []string) (string, []any, error) {
	qualified := qualifiedIdentifier(schema, table)
	switch operation.Type {
	case "truncate":
		if driver == driverPostgres {
			return "TRUNCATE TABLE " + qualified, nil, nil
		}
		return "DELETE FROM " + qualified, nil, nil
	case "insert":
		keys, err := validatedValueKeys(operation.Values, allowed)
		if err != nil {
			return "", nil, err
		}
		if len(keys) == 0 {
			return "INSERT INTO " + qualified + " DEFAULT VALUES", nil, nil
		}
		columns, places, args := make([]string, len(keys)), make([]string, len(keys)), make([]any, len(keys))
		for index, key := range keys {
			columns[index], places[index], args[index] = quoteIdentifier(key), placeholder(driver, index+1), operation.Values[key]
		}
		return "INSERT INTO " + qualified + " (" + strings.Join(columns, ", ") + ") VALUES (" + strings.Join(places, ", ") + ")", args, nil
	case "update":
		if len(primaryColumns) == 0 {
			return "", nil, errors.New("updating requires a primary key")
		}
		keys, err := validatedValueKeys(operation.Values, allowed)
		if err != nil || len(keys) == 0 {
			if err == nil {
				err = errors.New("update has no changed values")
			}
			return "", nil, err
		}
		args, sets := make([]any, 0, len(keys)+len(primaryColumns)), make([]string, len(keys))
		for index, key := range keys {
			args = append(args, operation.Values[key])
			sets[index] = quoteIdentifier(key) + " = " + placeholder(driver, len(args))
		}
		where, err := primaryKeyPredicate(driver, operation.PrimaryKey, primaryColumns, &args)
		if err != nil {
			return "", nil, err
		}
		return "UPDATE " + qualified + " SET " + strings.Join(sets, ", ") + " WHERE " + where, args, nil
	case "delete":
		if len(primaryColumns) == 0 {
			return "", nil, errors.New("deleting requires a primary key")
		}
		args := make([]any, 0, len(primaryColumns))
		where, err := primaryKeyPredicate(driver, operation.PrimaryKey, primaryColumns, &args)
		if err != nil {
			return "", nil, err
		}
		return "DELETE FROM " + qualified + " WHERE " + where, args, nil
	default:
		return "", nil, fmt.Errorf("unsupported operation %q", operation.Type)
	}
}

func validatedValueKeys(values map[string]any, allowed map[string]ColumnInfo) ([]string, error) {
	keys := make([]string, 0, len(values))
	for key := range values {
		if _, ok := allowed[key]; !ok {
			return nil, fmt.Errorf("column %q not found", key)
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, nil
}

func primaryKeyPredicate(driver string, values map[string]any, columns []string, args *[]any) (string, error) {
	parts := make([]string, len(columns))
	for index, name := range columns {
		value, ok := values[name]
		if !ok {
			return "", fmt.Errorf("missing primary key value for %s", name)
		}
		*args = append(*args, value)
		operator := "IS"
		if driver == driverPostgres {
			operator = "IS NOT DISTINCT FROM"
		}
		parts[index] = quoteIdentifier(name) + " " + operator + " " + placeholder(driver, len(*args))
	}
	return strings.Join(parts, " AND "), nil
}

func (a *App) UpdateCell(schema, table, column string, value any, primaryKey map[string]any) error {
	db, driver, readOnly, err := a.editableConnection()
	if err != nil {
		return err
	}
	if readOnly {
		return errors.New("this connection is read-only; reconnect with editing enabled")
	}
	if schema == "" {
		schema = defaultSchema(driver)
	}
	columns, err := a.GetTableSchema(schema, table)
	if err != nil {
		return err
	}
	allowed := make(map[string]ColumnInfo, len(columns))
	primaryColumns := make([]string, 0)
	for _, info := range columns {
		allowed[info.Name] = info
		if info.PrimaryKey {
			primaryColumns = append(primaryColumns, info.Name)
		}
	}
	if _, ok := allowed[column]; !ok {
		return errors.New("column not found")
	}
	if len(primaryColumns) == 0 {
		return errors.New("editing requires a primary key")
	}

	args := []any{value}
	where := ""
	for index, name := range primaryColumns {
		keyValue, ok := primaryKey[name]
		if !ok {
			return fmt.Errorf("missing primary key value for %s", name)
		}
		if index > 0 {
			where += " AND "
		}
		operator := "IS"
		if driver == driverPostgres {
			operator = "IS NOT DISTINCT FROM"
		}
		args = append(args, keyValue)
		where += quoteIdentifier(name) + " " + operator + " " + placeholder(driver, len(args))
	}
	statement := "UPDATE " + qualifiedIdentifier(schema, table) + " SET " + quoteIdentifier(column) + " = " + placeholder(driver, 1) + " WHERE " + where
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	result, err := tx.Exec(statement, args...)
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("update cell: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if affected != 1 {
		_ = tx.Rollback()
		return fmt.Errorf("expected to update 1 row, updated %d", affected)
	}
	return tx.Commit()
}

func (a *App) editableConnection() (*sql.DB, string, bool, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.db == nil {
		return nil, "", false, errors.New("no database connected")
	}
	return a.db, a.driver, a.readOnly, nil
}
