package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	desktopBuildMode  = "desktop"
	portableBuildMode = "portable"
	appDataDirName    = "QueryNest"
)

// appBuildMode is stamped into production binaries by scripts/build.go.
// Keeping desktop as the source default also gives development builds the
// normal operating-system storage behavior.
var appBuildMode = desktopBuildMode

func (a *App) appDataDir() (string, error) {
	if a.dataDirOverride != "" {
		return a.dataDirOverride, nil
	}
	return resolveAppDataDir(appBuildMode, runtime.GOOS, os.UserConfigDir, os.Executable)
}

func resolveAppDataDir(mode, goos string, userConfigDir, executable func() (string, error)) (string, error) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", desktopBuildMode:
		dir, err := userConfigDir()
		if err != nil {
			return "", fmt.Errorf("locate application data directory: %w", err)
		}
		return filepath.Join(dir, appDataDirName), nil
	case portableBuildMode:
		path, err := executable()
		if err != nil {
			return "", fmt.Errorf("locate executable for portable data: %w", err)
		}
		base := filepath.Dir(path)
		if goos == "darwin" && filepath.Base(base) == "MacOS" && filepath.Base(filepath.Dir(base)) == "Contents" {
			// Store beside QueryNest.app, not inside the signed application bundle.
			base = filepath.Dir(filepath.Dir(filepath.Dir(base)))
		}
		return filepath.Join(base, "data"), nil
	default:
		return "", fmt.Errorf("unsupported QueryNest build mode %q", mode)
	}
}
