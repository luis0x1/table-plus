package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	scriptsDirName  = "projects"
	scriptExtension = ".sql"
	// A SQL script that outgrows this is a data file, not something to edit here.
	maxScriptBytes = 4 << 20
)

// ScriptFile describes one saved script. Content is fetched separately so
// listing a workspace stays cheap.
type ScriptFile struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
}

// A script workspace belongs to a database rather than to a saved profile, so
// scripts survive a connection being saved, renamed or re-created. Hashing the
// driver and path keeps credentials and characters the filesystem cannot hold
// out of the directory name, and gives every connection a stable directory.
func connectionHash(driver, path string) string {
	sum := sha256.Sum256([]byte(driver + "\x00" + path))
	return hex.EncodeToString(sum[:8])
}

// Scripts are written to disk, so a name must not be able to escape the
// workspace. Requiring a leading alphanumeric also rules out "." and "..".
var scriptNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`)

func scriptFileName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	base := strings.TrimSuffix(trimmed, scriptExtension)
	if !scriptNamePattern.MatchString(base) {
		return "", fmt.Errorf("%q is not a valid script name: use letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit", name)
	}
	return base + scriptExtension, nil
}

func (a *App) scriptWorkspaceDir() (string, error) {
	status := a.GetStatus()
	if !status.Connected {
		return "", errors.New("connect to a database before working with scripts")
	}
	root, err := a.appDataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, scriptsDirName, connectionHash(status.Driver, status.Path)), nil
}

// ScriptWorkspacePath reports where this connection's scripts live so the user
// can find them outside the application.
func (a *App) ScriptWorkspacePath() (string, error) {
	return a.scriptWorkspaceDir()
}

func (a *App) scriptPath(name string) (string, error) {
	dir, err := a.scriptWorkspaceDir()
	if err != nil {
		return "", err
	}
	fileName, err := scriptFileName(name)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, fileName), nil
}

func describeScript(dir, name string) (ScriptFile, error) {
	info, err := os.Stat(filepath.Join(dir, name))
	if err != nil {
		return ScriptFile{}, fmt.Errorf("read script %s: %w", name, err)
	}
	return ScriptFile{Name: name, Size: info.Size(), Modified: info.ModTime().UTC().Format(time.RFC3339)}, nil
}

// ListScripts returns this connection's scripts. An absent workspace is an
// empty one; it is created on the first save.
func (a *App) ListScripts() ([]ScriptFile, error) {
	dir, err := a.scriptWorkspaceDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []ScriptFile{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read script workspace: %w", err)
	}
	scripts := make([]ScriptFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), scriptExtension) {
			continue
		}
		script, err := describeScript(dir, entry.Name())
		if err != nil {
			continue
		}
		scripts = append(scripts, script)
	}
	sort.Slice(scripts, func(i, j int) bool {
		return strings.ToLower(scripts[i].Name) < strings.ToLower(scripts[j].Name)
	})
	return scripts, nil
}

func (a *App) ReadScript(name string) (string, error) {
	path, err := a.scriptPath(name)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("open script %s: %w", name, err)
	}
	if info.Size() > maxScriptBytes {
		return "", fmt.Errorf("script %s is %d bytes; the editor handles up to %d", name, info.Size(), maxScriptBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read script %s: %w", name, err)
	}
	return string(data), nil
}

// CreateScript adds an empty script and fails if the name is taken, so the
// caller never silently replaces existing work.
func (a *App) CreateScript(name string) (ScriptFile, error) {
	path, err := a.scriptPath(name)
	if err != nil {
		return ScriptFile{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return ScriptFile{}, fmt.Errorf("create script workspace: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return ScriptFile{}, fmt.Errorf("a script named %s already exists", filepath.Base(path))
		}
		return ScriptFile{}, fmt.Errorf("create script: %w", err)
	}
	if err := file.Close(); err != nil {
		return ScriptFile{}, fmt.Errorf("create script: %w", err)
	}
	return describeScript(filepath.Dir(path), filepath.Base(path))
}

// SaveScript replaces a script's contents. The write goes to a temporary file
// first so an interrupted save cannot leave a half-written script behind.
func (a *App) SaveScript(name, content string) (ScriptFile, error) {
	if len(content) > maxScriptBytes {
		return ScriptFile{}, fmt.Errorf("script is %d bytes; the editor handles up to %d", len(content), maxScriptBytes)
	}
	path, err := a.scriptPath(name)
	if err != nil {
		return ScriptFile{}, err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ScriptFile{}, fmt.Errorf("create script workspace: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".script-*.sql")
	if err != nil {
		return ScriptFile{}, fmt.Errorf("write script: %w", err)
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err := temp.WriteString(content); err != nil {
		return ScriptFile{}, fmt.Errorf("write script: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return ScriptFile{}, fmt.Errorf("flush script: %w", err)
	}
	if err := temp.Close(); err != nil {
		return ScriptFile{}, fmt.Errorf("close script: %w", err)
	}
	if err := os.Chmod(temp.Name(), 0o600); err != nil {
		return ScriptFile{}, fmt.Errorf("set script permissions: %w", err)
	}
	if err := replaceFile(temp.Name(), path); err != nil {
		return ScriptFile{}, fmt.Errorf("replace script: %w", err)
	}
	return describeScript(dir, filepath.Base(path))
}

func (a *App) RenameScript(from, to string) (ScriptFile, error) {
	source, err := a.scriptPath(from)
	if err != nil {
		return ScriptFile{}, err
	}
	target, err := a.scriptPath(to)
	if err != nil {
		return ScriptFile{}, err
	}
	if source == target {
		return describeScript(filepath.Dir(target), filepath.Base(target))
	}
	if _, err := os.Stat(target); err == nil {
		return ScriptFile{}, fmt.Errorf("a script named %s already exists", filepath.Base(target))
	} else if !errors.Is(err, os.ErrNotExist) {
		return ScriptFile{}, fmt.Errorf("rename script: %w", err)
	}
	if err := os.Rename(source, target); err != nil {
		return ScriptFile{}, fmt.Errorf("rename script: %w", err)
	}
	return describeScript(filepath.Dir(target), filepath.Base(target))
}

func (a *App) DeleteScript(name string) error {
	path, err := a.scriptPath(name)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("delete script: %w", err)
	}
	return nil
}
