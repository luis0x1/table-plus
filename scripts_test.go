package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func scriptTestApp(t *testing.T) (*App, string) {
	t.Helper()
	app := openTestApp(t)
	app.dataDirOverride = filepath.Join(t.TempDir(), "QueryNest")
	dir, err := app.ScriptWorkspacePath()
	if err != nil {
		t.Fatal(err)
	}
	return app, dir
}

func TestScriptWorkspaceIsPerConnectionAndStable(t *testing.T) {
	app, dir := scriptTestApp(t)
	root := app.dataDirOverride
	if !strings.HasPrefix(dir, filepath.Join(root, scriptsDirName)+string(os.PathSeparator)) {
		t.Fatalf("workspace outside the projects directory: %s", dir)
	}
	if base := filepath.Base(dir); len(base) != 16 {
		t.Fatalf("workspace directory is not a hash: %s", base)
	}

	again, err := app.ScriptWorkspacePath()
	if err != nil || again != dir {
		t.Fatalf("workspace path is not stable: %s vs %s (%v)", again, dir, err)
	}

	// A different database must not share a workspace.
	other := openTestApp(t)
	other.dataDirOverride = root
	otherDir, err := other.ScriptWorkspacePath()
	if err != nil {
		t.Fatal(err)
	}
	if otherDir == dir {
		t.Fatal("two databases share one script workspace")
	}

	// Disconnecting leaves nothing to scope scripts to.
	disconnected := NewApp()
	disconnected.dataDirOverride = root
	if _, err := disconnected.ListScripts(); err == nil {
		t.Fatal("listing scripts without a connection was allowed")
	}
}

func TestScriptCreateReadSaveRenameDelete(t *testing.T) {
	app, dir := scriptTestApp(t)

	scripts, err := app.ListScripts()
	if err != nil || len(scripts) != 0 {
		t.Fatalf("a fresh workspace should be empty: %#v, %v", scripts, err)
	}

	created, err := app.CreateScript("daily report")
	if err != nil || created.Name != "daily report.sql" {
		t.Fatalf("create: %#v, %v", created, err)
	}
	if _, err := app.CreateScript("daily report.sql"); err == nil {
		t.Fatal("creating an existing script overwrote it")
	}

	const body = "SELECT count(*) FROM customers;\n"
	saved, err := app.SaveScript("daily report", body)
	if err != nil || saved.Size != int64(len(body)) {
		t.Fatalf("save: %#v, %v", saved, err)
	}
	content, err := app.ReadScript("daily report")
	if err != nil || content != body {
		t.Fatalf("read: %q, %v", content, err)
	}

	// No temporary file is left behind by the atomic write.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".script-") {
			t.Fatalf("atomic write left %s behind", entry.Name())
		}
	}

	renamed, err := app.RenameScript("daily report", "weekly report")
	if err != nil || renamed.Name != "weekly report.sql" {
		t.Fatalf("rename: %#v, %v", renamed, err)
	}
	if _, err := app.ReadScript("daily report"); err == nil {
		t.Fatal("the old name still resolves after a rename")
	}
	if content, err := app.ReadScript("weekly report"); err != nil || content != body {
		t.Fatalf("rename lost the contents: %q, %v", content, err)
	}

	if _, err := app.CreateScript("other"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.RenameScript("other", "weekly report"); err == nil {
		t.Fatal("rename overwrote an existing script")
	}

	listed, err := app.ListScripts()
	if err != nil || len(listed) != 2 || listed[0].Name != "other.sql" || listed[1].Name != "weekly report.sql" {
		t.Fatalf("list is wrong or unsorted: %#v, %v", listed, err)
	}

	if err := app.DeleteScript("weekly report"); err != nil {
		t.Fatal(err)
	}
	// Deleting twice is not an error, so a stale UI cannot produce a failure.
	if err := app.DeleteScript("weekly report"); err != nil {
		t.Fatalf("deleting a missing script failed: %v", err)
	}
	if listed, err := app.ListScripts(); err != nil || len(listed) != 1 {
		t.Fatalf("delete did not take effect: %#v, %v", listed, err)
	}
}

func TestScriptNamesCannotEscapeTheWorkspace(t *testing.T) {
	app, dir := scriptTestApp(t)
	outside := filepath.Join(filepath.Dir(dir), "escaped.sql")

	for _, name := range []string{
		"../escaped", "../../escaped", "..", ".", "", "   ",
		"sub/escaped", `sub\escaped`, "/etc/passwd", ".hidden",
		"/absolute", strings.Repeat("x", 200),
	} {
		if _, err := app.CreateScript(name); err == nil {
			t.Errorf("CreateScript accepted %q", name)
		}
		if _, err := app.SaveScript(name, "SELECT 1"); err == nil {
			t.Errorf("SaveScript accepted %q", name)
		}
		if _, err := app.ReadScript(name); err == nil {
			t.Errorf("ReadScript accepted %q", name)
		}
		if err := app.DeleteScript(name); err == nil {
			t.Errorf("DeleteScript accepted %q", name)
		}
		if _, err := app.RenameScript("safe", name); err == nil {
			t.Errorf("RenameScript accepted target %q", name)
		}
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("a script was written outside the workspace: %v", err)
	}
}

func TestScriptSizeLimit(t *testing.T) {
	app, _ := scriptTestApp(t)
	if _, err := app.SaveScript("huge", strings.Repeat("-", maxScriptBytes+1)); err == nil {
		t.Fatal("an oversized script was accepted")
	}
	if _, err := app.SaveScript("fine", strings.Repeat("-", 1024)); err != nil {
		t.Fatalf("a normal script was rejected: %v", err)
	}
}
