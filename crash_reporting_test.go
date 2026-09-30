package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func TestWailsFatalReason(t *testing.T) {
	if got := wailsFatalReason("json: unsupported value: +Inf"); got != "response_serialization" {
		t.Fatalf("serialization fatal reason: got %q", got)
	}
	if got := wailsFatalReason("something else"); got != "runtime" {
		t.Fatalf("runtime fatal reason: got %q", got)
	}
}

func TestWailsFatalEventIncludesSafeSerializationDiagnostic(t *testing.T) {
	raw := "dispatcher: json: unsupported value: +Inf password=do-not-send"
	event := newWailsFatalEvent(raw)

	if event.Level != sentry.LevelFatal {
		t.Fatalf("level: got %q", event.Level)
	}
	if event.Message != "FAT | json: unsupported value: +Inf" {
		t.Fatalf("message: got %q", event.Message)
	}
	if event.Exception[0].Value != event.Message {
		t.Fatalf("exception value: got %q", event.Exception[0].Value)
	}
	if strings.Contains(event.Message, "password") || strings.Contains(event.Exception[0].Value, "password") {
		t.Fatal("unsafe suffix leaked into crash event")
	}
	if event.Tags["querynest.crash_origin"] != "wails" {
		t.Fatalf("origin tag: got %q", event.Tags["querynest.crash_origin"])
	}
	if event.Tags["querynest.crash_reason"] != "response_serialization" {
		t.Fatalf("reason tag: got %q", event.Tags["querynest.crash_reason"])
	}
	if event.Exception[0].Stacktrace == nil {
		t.Fatal("Wails fatal event is missing a stack trace")
	}
}

func TestWailsFatalEventSanitizesUnknownMessage(t *testing.T) {
	raw := "database failed password=do-not-send"
	event := newWailsFatalEvent(raw)

	if event.Message != "Wails fatal error" {
		t.Fatalf("message: got %q", event.Message)
	}
	if event.Tags["querynest.crash_origin"] != "wails" {
		t.Fatalf("origin tag: got %q", event.Tags["querynest.crash_origin"])
	}
	if event.Tags["querynest.crash_reason"] != "runtime" {
		t.Fatalf("reason tag: got %q", event.Tags["querynest.crash_reason"])
	}
	for _, exception := range event.Exception {
		if strings.Contains(exception.Value, "password") || strings.Contains(exception.Type, "password") {
			t.Fatal("raw Wails fatal message leaked into crash event")
		}
	}
}

func TestPanicEventSanitizesArbitraryPanicMessage(t *testing.T) {
	event := newPanicEvent("password=do-not-send")
	if event.Message != "Go panic" {
		t.Fatalf("message: got %q", event.Message)
	}
	if event.Exception[0].Value != "Go panic" {
		t.Fatalf("exception value: got %q", event.Exception[0].Value)
	}
	if event.Tags["querynest.crash_origin"] != "go" || event.Tags["querynest.crash_reason"] != "panic" {
		t.Fatalf("unexpected tags: %#v", event.Tags)
	}
	if strings.Contains(event.Message, "password") || strings.Contains(event.Exception[0].Value, "password") {
		t.Fatal("panic payload leaked into crash event")
	}
	if event.Exception[0].Stacktrace == nil {
		t.Fatal("panic event is missing a stack trace")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestPendingCrashReportRetriesAfterNetworkTimeout(t *testing.T) {
	previousDSN := glitchTipDSN
	previousReady := crashReportingReady
	previousEnabled := crashReportingEnabled.Load()
	previousDelivery := crashDelivery
	previousDelays := crashReportRetryDelays

	var attempts atomic.Int32
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempt := attempts.Add(1)
		if attempt <= 2 {
			return nil, context.DeadlineExceeded
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("")),
			Request:    request,
		}, nil
	})

	glitchTipDSN = "https://public@example.invalid/1"
	crashReportingReady = false
	crashReportingEnabled.Store(false)
	crashDelivery = &crashDeliveryTracker{base: transport}
	crashReportRetryDelays = []time.Duration{10 * time.Millisecond, 10 * time.Millisecond}

	app := NewApp()
	app.dataDirOverride = t.TempDir()
	t.Cleanup(func() {
		app.stopCrashReportRetryLoop()
		glitchTipDSN = previousDSN
		crashReportingReady = previousReady
		crashReportingEnabled.Store(previousEnabled)
		crashDelivery = previousDelivery
		crashReportRetryDelays = previousDelays
		_ = sentry.Init(sentry.ClientOptions{})
	})

	taskPath, err := app.persistCrashReport(newWailsFatalEvent("json: unsupported value: +Inf"))
	if err != nil {
		t.Fatal(err)
	}
	if err := app.SetCrashReportingEnabled(true); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(time.Second)
	for {
		_, err := os.Stat(taskPath)
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("pending task was not delivered after retries; attempts=%d", attempts.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := attempts.Load(); got < 3 {
		t.Fatalf("expected at least 3 delivery attempts, got %d", got)
	}
}

func TestDisablingCrashReportingClearsPendingTasks(t *testing.T) {
	app := NewApp()
	app.dataDirOverride = t.TempDir()
	taskPath, err := app.persistCrashReport(newWailsFatalEvent("json: unsupported value: +Inf"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(taskPath); err != nil {
		t.Fatal(err)
	}

	previousEnabled := crashReportingEnabled.Load()
	t.Cleanup(func() { crashReportingEnabled.Store(previousEnabled) })
	if err := app.SetCrashReportingEnabled(false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(taskPath); !os.IsNotExist(err) {
		t.Fatalf("pending task survived consent revocation: %v", err)
	}
}

func TestRestoreCrashReportingPreferenceEnablesPersistedOptIn(t *testing.T) {
	previousDSN := glitchTipDSN
	previousReady := crashReportingReady
	previousEnabled := crashReportingEnabled.Load()
	glitchTipDSN = "https://public@example.invalid/1"
	crashReportingReady = false
	crashReportingEnabled.Store(false)

	app := NewApp()
	app.configPath = t.TempDir() + "/config.json"
	t.Cleanup(func() {
		app.stopCrashReportRetryLoop()
		glitchTipDSN = previousDSN
		crashReportingReady = previousReady
		crashReportingEnabled.Store(previousEnabled)
		_ = sentry.Init(sentry.ClientOptions{})
	})

	if err := app.SaveCrashReportingPreferences(CrashReportingPreferences{Prompted: true, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := app.restoreCrashReportingPreference(); err != nil {
		t.Fatal(err)
	}
	if !crashReportingEnabled.Load() {
		t.Fatal("persisted crash-reporting opt-in was not restored")
	}
}

func TestRestoreCrashReportingPreferenceDoesNotEnableUnpromptedPreference(t *testing.T) {
	previousEnabled := crashReportingEnabled.Load()
	crashReportingEnabled.Store(false)

	app := NewApp()
	app.configPath = t.TempDir() + "/config.json"
	t.Cleanup(func() {
		app.stopCrashReportRetryLoop()
		crashReportingEnabled.Store(previousEnabled)
	})

	if err := app.SaveCrashReportingPreferences(CrashReportingPreferences{Prompted: false, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := app.restoreCrashReportingPreference(); err != nil {
		t.Fatal(err)
	}
	if crashReportingEnabled.Load() {
		t.Fatal("unprompted crash-reporting preference must not enable reporting")
	}
}
