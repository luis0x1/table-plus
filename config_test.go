package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func TestAppConfigMigratesAndRestoresSidebarSizes(t *testing.T) {
	app := NewApp()
	app.configPath = filepath.Join(t.TempDir(), ".querynet", "config.json")
	legacy := SidebarPreferences{Databases: 1.5, Tables: 2}
	config, err := app.LoadAppConfig(legacy)
	if err != nil || config.Sidebars != legacy || config.Appearance != (AppearancePreferences{FontSize: 17, FontFamily: "system"}) || config.Transfer != (TransferPreferences{BackupBatchSizeMB: 500}) || config.Version != 1 {
		t.Fatalf("migrate preferences: %#v, %v", config, err)
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{app.configPath: 0o600, filepath.Dir(app.configPath): 0o700} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != want {
				t.Fatalf("incorrect permissions for %s: %v, %v", path, info, err)
			}
		}
	}
	want := SidebarPreferences{Databases: 2, Tables: 1.25}
	if err := app.SaveSidebarPreferences(want); err != nil {
		t.Fatal(err)
	}
	wantAppearance := AppearancePreferences{FontSize: 19, FontFamily: "serif"}
	if err := app.SaveAppearancePreferences(wantAppearance); err != nil {
		t.Fatal(err)
	}
	wantTransfer := TransferPreferences{BackupBatchSizeMB: 256}
	if err := app.SaveTransferPreferences(wantTransfer); err != nil {
		t.Fatal(err)
	}
	reopened := NewApp()
	reopened.configPath = app.configPath
	config, err = reopened.LoadAppConfig(legacy)
	if err != nil || config.Sidebars != want || config.Appearance != wantAppearance || config.Transfer != wantTransfer {
		t.Fatalf("file must override old browser preferences: %#v, %v", config, err)
	}
}

func TestAppConfigDefaultsAndPath(t *testing.T) {
	app := NewApp()
	configDir, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	path, err := app.appConfigPath()
	if err != nil || path != filepath.Join(configDir, "QueryNest", "config.json") {
		t.Fatalf("incorrect config path: %s, %v", path, err)
	}
	app.configPath = filepath.Join(t.TempDir(), "config.json")
	config, err := app.LoadAppConfig(SidebarPreferences{})
	if err != nil || config.Sidebars != (SidebarPreferences{Databases: 1, Tables: 1}) || config.Appearance != (AppearancePreferences{FontSize: 17, FontFamily: "system"}) || config.Transfer != (TransferPreferences{BackupBatchSizeMB: 500}) {
		t.Fatalf("incorrect defaults: %#v, %v", config, err)
	}
}

func TestAppConfigMigratesLegacyFileToSharedDataDirectory(t *testing.T) {
	app := NewApp()
	app.dataDirOverride = filepath.Join(t.TempDir(), "QueryNest")
	app.legacyConfigPath = filepath.Join(t.TempDir(), ".querynet", "config.json")
	want := AppConfig{
		Version:    1,
		Sidebars:   SidebarPreferences{Databases: 1.75, Tables: 1.25},
		Appearance: AppearancePreferences{FontSize: 18, FontFamily: "mono"},
		Transfer:   TransferPreferences{BackupBatchSizeMB: 500},
		Editing:    EditingPreferences{UndoHistoryLimit: 100, CaretWidth: 2, EditorFontSize: 12, EditorFontFamily: "mono"},
	}
	if err := writeAppConfig(app.legacyConfigPath, want, nil); err != nil {
		t.Fatal(err)
	}
	got, err := app.LoadAppConfig(SidebarPreferences{Databases: 2, Tables: 2})
	if err != nil || got != want {
		t.Fatalf("migrate legacy config: got %#v, want %#v, error %v", got, want, err)
	}
	newPath, err := app.appConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	migrated, _, err := readAppConfig(newPath)
	if err != nil || migrated != want {
		t.Fatalf("read migrated config: got %#v, want %#v, error %v", migrated, want, err)
	}
}

func TestAppConfigPreservesUnknownSettings(t *testing.T) {
	app := NewApp()
	app.configPath = filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(app.configPath, []byte(`{"version":1,"theme":"dark","sidebars":{"databases":1,"tables":1,"future":true}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := app.SaveSidebarPreferences(SidebarPreferences{Databases: 2, Tables: 2}); err != nil {
		t.Fatal(err)
	}
	if err := app.SaveAppearancePreferences(AppearancePreferences{FontSize: 19, FontFamily: "humanist"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(app.configPath)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		Theme    string `json:"theme"`
		Sidebars struct {
			Future bool `json:"future"`
		} `json:"sidebars"`
		Appearance struct {
			FontSize   int    `json:"fontSize"`
			FontFamily string `json:"fontFamily"`
		} `json:"appearance"`
	}
	if err := json.Unmarshal(data, &saved); err != nil || saved.Theme != "dark" || !saved.Sidebars.Future || saved.Appearance.FontSize != 19 || saved.Appearance.FontFamily != "humanist" {
		t.Fatalf("lost unrelated settings: %s, %v", data, err)
	}
}

func TestAppConfigRejectsInvalidSettingsWithoutOverwriting(t *testing.T) {
	app := NewApp()
	app.configPath = filepath.Join(t.TempDir(), "config.json")
	valid := SidebarPreferences{Databases: 1, Tables: 1}
	for _, content := range []string{`{`, `null`, `[]`, `{"version":2}`, `{"sidebars":{"tables":3}}`, `{"appearance":{"fontSize":30}}`, `{"appearance":{"fontFamily":""}}`, `{"transfer":{"backupBatchSizeMB":0}}`} {
		if err := os.WriteFile(app.configPath, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := app.LoadAppConfig(valid); err == nil {
			t.Fatalf("accepted invalid config: %s", content)
		}
		if err := app.SaveSidebarPreferences(valid); err == nil {
			t.Fatalf("overwrote invalid config: %s", content)
		}
		data, err := os.ReadFile(app.configPath)
		if err != nil || string(data) != content {
			t.Fatalf("changed original file: %s, %v", data, err)
		}
	}
	for _, value := range []float64{0, 2.01, math.NaN(), math.Inf(1)} {
		if err := app.SaveSidebarPreferences(SidebarPreferences{Databases: value, Tables: 1}); err == nil {
			t.Fatalf("accepted invalid size: %v", value)
		}
	}
	for _, preferences := range []AppearancePreferences{{FontSize: 13, FontFamily: "system"}, {FontSize: 21, FontFamily: "system"}, {FontSize: 17, FontFamily: ""}, {FontSize: 17, FontFamily: "bad\nfont"}} {
		if err := app.SaveAppearancePreferences(preferences); err == nil {
			t.Fatalf("accepted invalid appearance: %#v", preferences)
		}
	}
	app.configPath = filepath.Join(app.configPath, "config.json") // Parent is a file.
	if _, err := app.LoadAppConfig(valid); err == nil {
		t.Fatal("configuration I/O failure must be reported")
	}
}

func TestAppConfigConcurrentUpdatesRemainReadable(t *testing.T) {
	app := NewApp()
	app.configPath = filepath.Join(t.TempDir(), "config.json")
	if _, err := app.LoadAppConfig(SidebarPreferences{Databases: 1, Tables: 1}); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for i := 0; i < 20; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			if err := app.SaveSidebarPreferences(SidebarPreferences{Databases: 1 + float64(i)/20, Tables: 2}); err != nil {
				t.Error(err)
			}
			// Read directly without the application lock to detect incomplete files.
			if _, _, err := readAppConfig(app.configPath); err != nil {
				t.Error(err)
			}
		}(i)
	}
	workers.Wait()
	files, err := os.ReadDir(filepath.Dir(app.configPath))
	if err != nil || len(files) != 1 || files[0].Name() != "config.json" {
		t.Fatalf("left temporary files behind: %v, %v", files, err)
	}
}

func TestEditingPreferencesRoundTripAndValidation(t *testing.T) {
	app := NewApp()
	app.configPath = filepath.Join(t.TempDir(), ".querynet", "config.json")
	config, err := app.LoadAppConfig(SidebarPreferences{Databases: 1, Tables: 1})
	if err != nil || config.Editing != (EditingPreferences{UndoHistoryLimit: 100, CaretWidth: 2, EditorFontSize: 12, EditorFontFamily: "mono"}) {
		t.Fatalf("default editing preferences: %#v, %v", config.Editing, err)
	}
	if err := app.SaveEditingPreferences(EditingPreferences{UndoHistoryLimit: 25, CaretWidth: 3, EditorFontSize: 15, EditorFontFamily: "JetBrains Mono"}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := app.LoadAppConfig(SidebarPreferences{Databases: 1, Tables: 1})
	if err != nil || reloaded.Editing != (EditingPreferences{UndoHistoryLimit: 25, CaretWidth: 3, EditorFontSize: 15, EditorFontFamily: "JetBrains Mono"}) {
		t.Fatalf("persisted editing preferences: %#v, %v", reloaded.Editing, err)
	}
	if reloaded.Transfer.BackupBatchSizeMB != 500 || reloaded.Appearance.FontSize != 17 {
		t.Fatalf("saving editing preferences disturbed other sections: %#v", reloaded)
	}
	for _, limit := range []int{9, 1001, 0, -1} {
		if err := app.SaveEditingPreferences(EditingPreferences{UndoHistoryLimit: limit, CaretWidth: 2, EditorFontSize: 12, EditorFontFamily: "mono"}); err == nil {
			t.Fatalf("accepted out-of-range undo history limit %d", limit)
		}
	}
	for _, width := range []int{0, 5, -1} {
		if err := app.SaveEditingPreferences(EditingPreferences{UndoHistoryLimit: 100, CaretWidth: width, EditorFontSize: 12, EditorFontFamily: "mono"}); err == nil {
			t.Fatalf("accepted out-of-range caret width %d", width)
		}
	}
	for _, size := range []int{9, 25, 0} {
		if err := app.SaveEditingPreferences(EditingPreferences{UndoHistoryLimit: 100, CaretWidth: 2, EditorFontSize: size, EditorFontFamily: "mono"}); err == nil {
			t.Fatalf("accepted out-of-range editor font size %d", size)
		}
	}
	if err := app.SaveEditingPreferences(EditingPreferences{UndoHistoryLimit: 100, CaretWidth: 2, EditorFontSize: 12}); err == nil {
		t.Fatal("accepted an empty editor font family")
	}
	after, err := app.LoadAppConfig(SidebarPreferences{Databases: 1, Tables: 1})
	if err != nil || after.Editing != (EditingPreferences{UndoHistoryLimit: 25, CaretWidth: 3, EditorFontSize: 15, EditorFontFamily: "JetBrains Mono"}) {
		t.Fatalf("rejected write changed stored settings: %#v, %v", after.Editing, err)
	}
}

func TestAppConfigWithoutEditingSectionKeepsDefault(t *testing.T) {
	app := NewApp()
	app.configPath = filepath.Join(t.TempDir(), "config.json")
	// A config written before the editing section existed must still load.
	legacy := `{"version":1,"sidebars":{"databases":1,"tables":1},"appearance":{"fontSize":18,"fontFamily":"mono"},"transfer":{"backupBatchSizeMB":250}}`
	if err := os.WriteFile(app.configPath, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := app.LoadAppConfig(SidebarPreferences{Databases: 1, Tables: 1})
	if err != nil || config.Editing != (EditingPreferences{UndoHistoryLimit: 100, CaretWidth: 2, EditorFontSize: 12, EditorFontFamily: "mono"}) {
		t.Fatalf("missing editing section: %#v, %v", config.Editing, err)
	}
	if config.Appearance.FontSize != 18 || config.Transfer.BackupBatchSizeMB != 250 {
		t.Fatalf("existing settings were not preserved: %#v", config)
	}
}

func TestAppConfigWithoutCaretWidthKeepsDefault(t *testing.T) {
	app := NewApp()
	app.configPath = filepath.Join(t.TempDir(), "config.json")
	legacy := `{"version":1,"sidebars":{"databases":1,"tables":1},"appearance":{"fontSize":17,"fontFamily":"system"},"transfer":{"backupBatchSizeMB":500},"editing":{"undoHistoryLimit":60}}`
	if err := os.WriteFile(app.configPath, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := app.LoadAppConfig(SidebarPreferences{Databases: 1, Tables: 1})
	if err != nil || config.Editing != (EditingPreferences{UndoHistoryLimit: 60, CaretWidth: 2, EditorFontSize: 12, EditorFontFamily: "mono"}) {
		t.Fatalf("missing caret width: %#v, %v", config.Editing, err)
	}
}
