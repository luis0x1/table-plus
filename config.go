package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

// Scales keep sidebar sizes proportional to the compact/regular window layout.
type SidebarPreferences struct {
	Databases float64 `json:"databases"`
	Tables    float64 `json:"tables"`
}

type AppConfig struct {
	Version  int                `json:"version"`
	Sidebars SidebarPreferences `json:"sidebars"`
}

func (a *App) appConfigPath() (string, error) {
	if a.configPath != "" {
		return a.configPath, nil
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate configuration directory: %w", err)
	}
	return filepath.Join(homeDir, ".querynet", "config.json"), nil
}

func validSidebarPreferences(p SidebarPreferences) bool {
	valid := func(value float64) bool {
		return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 1 && value <= 2
	}
	return valid(p.Databases) && valid(p.Tables)
}

// LoadAppConfig migrates browser preferences only when the file does not exist.
func (a *App) LoadAppConfig(legacy SidebarPreferences) (AppConfig, error) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	path, err := a.appConfigPath()
	if err != nil {
		return AppConfig{}, err
	}
	config, _, err := readAppConfig(path)
	if !errors.Is(err, os.ErrNotExist) {
		return config, err
	}
	if !validSidebarPreferences(legacy) {
		legacy = SidebarPreferences{Databases: 1, Tables: 1}
	}
	config = AppConfig{Version: 1, Sidebars: legacy}
	if err := writeAppConfig(path, config, nil); err != nil {
		return AppConfig{}, err
	}
	return config, nil
}

func (a *App) SaveSidebarPreferences(preferences SidebarPreferences) error {
	if !validSidebarPreferences(preferences) {
		return errors.New("sidebar sizes must be between 1 and 2 times their default width")
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	path, err := a.appConfigPath()
	if err != nil {
		return err
	}
	config, fields, err := readAppConfig(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	config.Version, config.Sidebars = 1, preferences
	return writeAppConfig(path, config, fields)
}

func readAppConfig(path string) (AppConfig, map[string]json.RawMessage, error) {
	config := AppConfig{Version: 1, Sidebars: SidebarPreferences{Databases: 1, Tables: 1}}
	data, err := os.ReadFile(path)
	if err != nil {
		return config, nil, fmt.Errorf("read configuration: %w", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return config, nil, errors.New("read configuration: config.json must contain a JSON object")
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return config, nil, fmt.Errorf("read configuration: %w", err)
	}
	if config.Version != 1 {
		return config, nil, fmt.Errorf("unsupported configuration version: %d", config.Version)
	}
	if !validSidebarPreferences(config.Sidebars) {
		return config, nil, errors.New("read configuration: sidebar sizes must be between 1 and 2")
	}
	return config, fields, nil
}

func writeAppConfig(path string, config AppConfig, fields map[string]json.RawMessage) error {
	if fields == nil {
		fields = make(map[string]json.RawMessage)
	}
	sidebars := make(map[string]json.RawMessage)
	if raw := fields["sidebars"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &sidebars); err != nil {
			return fmt.Errorf("read sidebar configuration: %w", err)
		}
		if sidebars == nil {
			sidebars = make(map[string]json.RawMessage)
		}
	}
	sidebars["databases"], _ = json.Marshal(config.Sidebars.Databases)
	sidebars["tables"], _ = json.Marshal(config.Sidebars.Tables)
	fields["sidebars"], _ = json.Marshal(sidebars)
	fields["version"], _ = json.Marshal(config.Version)
	data, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return fmt.Errorf("encode configuration: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create configuration directory: %w", err)
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".config-*.json")
	if err != nil {
		return fmt.Errorf("create configuration file: %w", err)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("write configuration: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("flush configuration: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close configuration: %w", err)
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return fmt.Errorf("replace configuration: %w", err)
	}
	return nil
}
