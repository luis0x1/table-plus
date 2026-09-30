package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
)

const (
	crashReportTaskVersion = 1
	crashReportDirName     = "crash-reports"
)

var crashReportRetryDelays = []time.Duration{
	2 * time.Second,
	10 * time.Second,
	30 * time.Second,
	2 * time.Minute,
	5 * time.Minute,
}

type crashReportTask struct {
	Version   int           `json:"version"`
	CreatedAt time.Time     `json:"createdAt"`
	Event     *sentry.Event `json:"event"`
}

func (a *App) crashReportPendingDir() (string, error) {
	root, err := a.appDataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, crashReportDirName, "pending"), nil
}

func (a *App) persistCrashReport(event *sentry.Event) (string, error) {
	dir, err := a.crashReportPendingDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create crash report queue: %w", err)
	}
	task := crashReportTask{Version: crashReportTaskVersion, CreatedAt: time.Now().UTC(), Event: event}
	data, err := json.Marshal(task)
	if err != nil {
		return "", fmt.Errorf("encode crash report task: %w", err)
	}
	name := fmt.Sprintf("%d-%d.json", task.CreatedAt.UnixNano(), os.Getpid())
	path := filepath.Join(dir, name)
	temp := path + ".tmp"
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("write crash report task: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(temp)
		return "", fmt.Errorf("write crash report task: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temp)
		return "", fmt.Errorf("sync crash report task: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temp)
		return "", fmt.Errorf("close crash report task: %w", err)
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return "", fmt.Errorf("commit crash report task: %w", err)
	}
	if directory, err := os.Open(dir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return path, nil
}

func readCrashReportTask(path string) (crashReportTask, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return crashReportTask{}, err
	}
	var task crashReportTask
	if err := json.Unmarshal(data, &task); err != nil {
		return crashReportTask{}, fmt.Errorf("decode crash report task: %w", err)
	}
	if task.Version != crashReportTaskVersion || task.Event == nil {
		return crashReportTask{}, errors.New("unsupported crash report task")
	}
	return task, nil
}

func (a *App) retryPendingCrashReportsOnce() (bool, error) {
	dir, err := a.crashReportPendingDir()
	if err != nil {
		return false, err
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read crash report queue: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		path := filepath.Join(dir, name)
		task, err := readCrashReportTask(path)
		if err != nil {
			debugLogf("crash-reporting: skip invalid pending report %s: %v", name, err)
			continue
		}
		debugLogf("crash-reporting: retry pending report %s", name)
		result := sendCrashEvent(task.Event)
		if !result.success {
			if result.retryable {
				return true, nil
			}
			debugLogf("crash-reporting: pending report %s failed permanently with HTTP %d", name, result.statusCode)
			continue
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return true, fmt.Errorf("remove delivered crash report: %w", err)
		}
	}
	return false, nil
}

func crashReportRetryDelay(attempt int) time.Duration {
	if len(crashReportRetryDelays) == 0 {
		return time.Minute
	}
	if attempt >= len(crashReportRetryDelays) {
		return crashReportRetryDelays[len(crashReportRetryDelays)-1]
	}
	return crashReportRetryDelays[attempt]
}

func (a *App) startCrashReportRetryLoop() {
	a.crashRetryMu.Lock()
	if a.crashRetryCancel != nil {
		a.crashRetryMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.crashRetryGen++
	generation := a.crashRetryGen
	a.crashRetryCancel = cancel
	a.crashRetryMu.Unlock()

	go func() {
		defer func() {
			a.crashRetryMu.Lock()
			if a.crashRetryGen == generation {
				a.crashRetryCancel = nil
			}
			a.crashRetryMu.Unlock()
		}()

		for attempt := 0; crashReportingEnabled.Load(); attempt++ {
			pending, err := a.retryPendingCrashReportsOnce()
			if err != nil {
				debugLogf("crash-reporting: retry pending reports: %v", err)
				pending = true
			}
			if !pending {
				debugLogf("crash-reporting: pending queue empty")
				return
			}
			delay := crashReportRetryDelay(attempt)
			debugLogf("crash-reporting: retry scheduled in %s", delay)
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				if !timer.Stop() {
					<-timer.C
				}
				return
			case <-timer.C:
			}
		}
	}()
}

func (a *App) stopCrashReportRetryLoop() {
	a.crashRetryMu.Lock()
	cancel := a.crashRetryCancel
	a.crashRetryGen++
	a.crashRetryCancel = nil
	a.crashRetryMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (a *App) clearPendingCrashReports() error {
	dir, err := a.crashReportPendingDir()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read crash report queue: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if !strings.HasSuffix(entry.Name(), ".json") && !strings.HasSuffix(entry.Name(), ".tmp") {
			continue
		}
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove pending crash report: %w", err)
		}
	}
	return nil
}
