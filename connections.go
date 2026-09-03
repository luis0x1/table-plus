package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/zalando/go-keyring"
)

const keyringService = "QueryNest"

type SavedConnection struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Driver      string `json:"driver"`
	Path        string `json:"path,omitempty"`
	Host        string `json:"host,omitempty"`
	Port        int    `json:"port,omitempty"`
	User        string `json:"user,omitempty"`
	Database    string `json:"database,omitempty"`
	SSLMode     string `json:"sslMode,omitempty"`
	ReadOnly    bool   `json:"readOnly"`
	HasPassword bool   `json:"hasPassword"`
}

func (a *App) ListSavedConnections() ([]SavedConnection, error) {
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	return loadConnectionProfiles()
}

func (a *App) ConnectSavedConnection(id, password string) (ConnectionStatus, error) {
	profiles, err := a.ListSavedConnections()
	if err != nil {
		return ConnectionStatus{}, err
	}
	for _, profile := range profiles {
		if profile.ID != id {
			continue
		}
		if profile.Driver == driverSQLite {
			return a.ConnectSQLite(profile.Path)
		}
		if profile.Driver != driverPostgres {
			return ConnectionStatus{}, errors.New("unsupported saved connection driver")
		}
		if password == "" && profile.HasPassword {
			password, err = keyring.Get(keyringService, profile.ID)
			if err != nil {
				return ConnectionStatus{}, fmt.Errorf("read saved password: %w", err)
			}
		}
		return a.ConnectPostgres(PostgresConfig{
			ID: profile.ID, Name: profile.Name, Host: profile.Host, Port: profile.Port,
			User: profile.User, Password: password, Database: profile.Database,
			SSLMode: profile.SSLMode, ReadOnly: profile.ReadOnly,
		})
	}
	return ConnectionStatus{}, errors.New("saved connection not found")
}

func (a *App) DeleteSavedConnection(id string) error {
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	profiles, err := loadConnectionProfiles()
	if err != nil {
		return err
	}
	next := make([]SavedConnection, 0, len(profiles))
	found := false
	hadPassword := false
	for _, profile := range profiles {
		if profile.ID == id {
			found = true
			hadPassword = profile.HasPassword
			continue
		}
		next = append(next, profile)
	}
	if !found {
		return errors.New("saved connection not found")
	}
	if err := writeConnectionProfiles(next); err != nil {
		return err
	}
	if hadPassword {
		if err := keyring.Delete(keyringService, id); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return fmt.Errorf("delete saved password: %w", err)
		}
	}
	return nil
}

func (a *App) saveSQLiteProfile(path, name string) error {
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	profiles, err := loadConnectionProfiles()
	if err != nil {
		return err
	}
	for _, profile := range profiles {
		if profile.Driver == driverSQLite && profile.Path == path {
			return nil
		}
	}
	profiles = append(profiles, SavedConnection{ID: newConnectionID(), Name: name, Driver: driverSQLite, Path: path})
	return writeConnectionProfiles(profiles)
}

func (a *App) savePostgresProfile(input PostgresConfig) error {
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	profiles, err := loadConnectionProfiles()
	if err != nil {
		return err
	}
	id := strings.TrimSpace(input.ID)
	if id == "" {
		id = newConnectionID()
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = input.Database
	}
	profile := SavedConnection{ID: id, Name: name, Driver: driverPostgres, Host: input.Host, Port: input.Port, User: input.User, Database: input.Database, SSLMode: input.SSLMode, ReadOnly: input.ReadOnly}
	if input.SavePassword && input.Password != "" {
		if err := keyring.Set(keyringService, id, input.Password); err != nil {
			return fmt.Errorf("store password in system credential manager: %w", err)
		}
		profile.HasPassword = true
	} else {
		_ = keyring.Delete(keyringService, id)
	}
	next := make([]SavedConnection, 0, len(profiles)+1)
	for _, current := range profiles {
		if current.ID != id {
			next = append(next, current)
		}
	}
	next = append(next, profile)
	return writeConnectionProfiles(next)
}

func loadConnectionProfiles() ([]SavedConnection, error) {
	path, err := connectionProfilesPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return []SavedConnection{}, nil
	}
	if err != nil {
		return nil, err
	}
	var profiles []SavedConnection
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, fmt.Errorf("read saved connections: %w", err)
	}
	return profiles, nil
}

func writeConnectionProfiles(profiles []SavedConnection) error {
	path, err := connectionProfilesPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(profiles, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func connectionProfilesPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "QueryNest", "connections.json"), nil
}

func newConnectionID() string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err == nil {
		return hex.EncodeToString(buffer)
	}
	return fmt.Sprintf("connection-%d", os.Getpid())
}
