package main

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestResolveDesktopDataDirectory(t *testing.T) {
	want := filepath.Join(t.TempDir(), "QueryNest")
	got, err := resolveAppDataDir(desktopBuildMode, "linux", func() (string, error) {
		return filepath.Dir(want), nil
	}, func() (string, error) {
		return "", errors.New("desktop mode must not inspect the executable")
	})
	if err != nil || got != want {
		t.Fatalf("desktop data directory: got %q, want %q, error %v", got, want, err)
	}
}

func TestResolvePortableDataDirectory(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "QueryNest.exe")
	got, err := resolveAppDataDir(portableBuildMode, "windows", func() (string, error) {
		return "", errors.New("portable mode must not inspect user configuration")
	}, func() (string, error) {
		return executable, nil
	})
	want := filepath.Join(filepath.Dir(executable), "data")
	if err != nil || got != want {
		t.Fatalf("portable data directory: got %q, want %q, error %v", got, want, err)
	}
}

func TestResolvePortableMacDataBesideBundle(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "QueryNest.app", "Contents", "MacOS", "QueryNest")
	got, err := resolveAppDataDir(portableBuildMode, "darwin", nil, func() (string, error) {
		return executable, nil
	})
	want := filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(executable)))), "data")
	if err != nil || got != want {
		t.Fatalf("portable macOS data directory: got %q, want %q, error %v", got, want, err)
	}
}

func TestResolveDataDirectoryRejectsUnknownBuildMode(t *testing.T) {
	if _, err := resolveAppDataDir("network", "linux", nil, nil); err == nil {
		t.Fatal("unknown build mode must fail")
	}
}

func TestConfigAndConnectionsShareDataDirectory(t *testing.T) {
	app := NewApp()
	app.dataDirOverride = t.TempDir()
	configPath, configErr := app.appConfigPath()
	connectionsPath, connectionsErr := app.connectionProfilesPath()
	if configErr != nil || connectionsErr != nil {
		t.Fatalf("resolve storage paths: %v, %v", configErr, connectionsErr)
	}
	if filepath.Dir(configPath) != filepath.Dir(connectionsPath) {
		t.Fatalf("paths do not share a directory: %q and %q", configPath, connectionsPath)
	}
}
