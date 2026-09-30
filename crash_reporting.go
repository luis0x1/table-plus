package main

import (
	"errors"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/getsentry/sentry-go"
)

var glitchTipDSN string

var (
	crashReportingEnabled atomic.Bool
	crashReportingInitMu  sync.Mutex
	crashReportingSendMu  sync.Mutex
	crashReportingReady   bool
	crashDelivery         = &crashDeliveryTracker{}
)

const crashReportingHTTPTimeout = 5 * time.Second

func configuredGlitchTipDSN() string {
	if value := strings.TrimSpace(glitchTipDSN); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv("QUERYNEST_GLITCHTIP_DSN"))
}

func crashReportingRelease() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				if revision := strings.TrimSpace(setting.Value); revision != "" {
					return "querynest@" + revision
				}
			}
		}
	}
	return "querynest@unknown"
}

func (a *App) CrashReportingConfigured() bool {
	configured := configuredGlitchTipDSN() != ""
	debugLogf("crash-reporting: configured=%t", configured)
	return configured
}

func (a *App) restoreCrashReportingPreference() error {
	path, err := a.appConfigPath()
	if err != nil {
		return err
	}
	config, _, err := readAppConfig(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !config.CrashReporting.Prompted || !config.CrashReporting.Enabled {
		return nil
	}
	return a.SetCrashReportingEnabled(true)
}

type crashDeliveryResult struct {
	attempted  bool
	success    bool
	retryable  bool
	statusCode int
}

type crashDeliveryTracker struct {
	mu     sync.Mutex
	base   http.RoundTripper
	result crashDeliveryResult
}

func (t *crashDeliveryTracker) begin() {
	t.mu.Lock()
	t.result = crashDeliveryResult{}
	t.mu.Unlock()
}

func (t *crashDeliveryTracker) finish() crashDeliveryResult {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.result
}

func (t *crashDeliveryTracker) RoundTrip(request *http.Request) (*http.Response, error) {
	t.mu.Lock()
	base := t.base
	t.mu.Unlock()
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(request)
	result := crashDeliveryResult{attempted: true}
	if err != nil {
		result.retryable = true
	} else if response != nil {
		result.statusCode = response.StatusCode
		result.success = response.StatusCode >= 200 && response.StatusCode < 300
		result.retryable = response.StatusCode == http.StatusRequestTimeout ||
			response.StatusCode == http.StatusTooManyRequests ||
			response.StatusCode >= 500
	}
	t.mu.Lock()
	t.result = result
	t.mu.Unlock()
	return response, err
}

func (a *App) SetCrashReportingEnabled(enabled bool) error {
	debugLogf("crash-reporting: set enabled=%t", enabled)
	if enabled && configuredGlitchTipDSN() == "" {
		debugLogf("crash-reporting: DSN is not configured")
		return errors.New("crash reporting is not configured in this build")
	}
	if enabled {
		crashReportingInitMu.Lock()
		if !crashReportingReady {
			debugLogf("crash-reporting: sentry init start")
			transport := sentry.NewHTTPSyncTransport()
			transport.Timeout = crashReportingHTTPTimeout
			err := sentry.Init(sentry.ClientOptions{
				Dsn:              configuredGlitchTipDSN(),
				Release:          crashReportingRelease(),
				EnableTracing:    false,
				SendDefaultPII:   false,
				AttachStacktrace: true,
				Transport:        transport,
				HTTPTransport:    crashDelivery,
				BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
					if !crashReportingEnabled.Load() {
						debugLogf("crash-reporting: event dropped because reporting is disabled")
						return nil
					}
					event.Breadcrumbs = nil
					event.Request = nil
					event.User = sentry.User{}
					return event
				},
			})
			if err != nil {
				debugLogf("crash-reporting: sentry init failed: %v", err)
				crashReportingInitMu.Unlock()
				return err
			}
			crashReportingReady = true
			debugLogf("crash-reporting: sentry init success")
		}
		crashReportingInitMu.Unlock()
	}
	crashReportingEnabled.Store(enabled)
	debugLogf("crash-reporting: enabled=%t", enabled)
	if !enabled {
		a.stopCrashReportRetryLoop()
		if err := a.clearPendingCrashReports(); err != nil {
			debugLogf("crash-reporting: clear pending reports: %v", err)
		}
	}
	if enabled {
		a.startCrashReportRetryLoop()
	}
	return nil
}

func wailsFatalReason(message string) string {
	if strings.Contains(message, "json: unsupported value:") {
		return "response_serialization"
	}
	return "runtime"
}

func wailsFatalReportMessage(message string) string {
	for _, diagnostic := range []string{
		"json: unsupported value: +Inf",
		"json: unsupported value: -Inf",
		"json: unsupported value: NaN",
	} {
		if strings.Contains(message, diagnostic) {
			return "FAT | " + diagnostic
		}
	}
	return "Wails fatal error"
}

func newWailsFatalEvent(message string) *sentry.Event {
	reportMessage := wailsFatalReportMessage(message)
	return &sentry.Event{
		Level:   sentry.LevelFatal,
		Message: reportMessage,
		Tags: map[string]string{
			"querynest.crash_origin": "wails",
			"querynest.crash_reason": wailsFatalReason(message),
		},
		Exception: []sentry.Exception{{
			Type:       "WailsFatal",
			Value:      reportMessage,
			Stacktrace: sentry.NewStacktrace(),
		}},
	}
}

func panicReportMessage(recovered any) string {
	if runtimeError, ok := recovered.(runtime.Error); ok {
		return "PANIC | " + runtimeError.Error()
	}
	return "Go panic"
}

func newPanicEvent(recovered any) *sentry.Event {
	reportMessage := panicReportMessage(recovered)
	return &sentry.Event{
		Level:   sentry.LevelFatal,
		Message: reportMessage,
		Tags: map[string]string{
			"querynest.crash_origin": "go",
			"querynest.crash_reason": "panic",
		},
		Exception: []sentry.Exception{{
			Type:       "GoPanic",
			Value:      reportMessage,
			Stacktrace: sentry.NewStacktrace(),
		}},
	}
}

func sendCrashEvent(event *sentry.Event) crashDeliveryResult {
	crashReportingSendMu.Lock()
	defer crashReportingSendMu.Unlock()
	crashDelivery.begin()
	if sentry.CaptureEvent(event) == nil {
		debugLogf("crash-reporting: event was not accepted by sentry")
		return crashDeliveryResult{retryable: true}
	}
	result := crashDelivery.finish()
	if result.success {
		debugLogf("crash-reporting: delivery confirmed")
		return result
	}
	if result.attempted {
		debugLogf("crash-reporting: delivery failed status=%d retryable=%t", result.statusCode, result.retryable)
	} else {
		debugLogf("crash-reporting: delivery not attempted")
		result.retryable = true
	}
	return result
}

func (a *App) persistAndSendCrashReport(event *sentry.Event) {
	taskPath, err := a.persistCrashReport(event)
	if err != nil {
		debugLogf("crash-reporting: persist report failed: %v", err)
		sendCrashEvent(event)
		return
	}
	if !sendCrashEvent(event).success {
		return
	}
	if err := os.Remove(taskPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		debugLogf("crash-reporting: remove delivered report failed: %v", err)
	}
}

func (a *App) captureWailsFatal(message string) {
	if !crashReportingEnabled.Load() {
		debugLogf("crash-reporting: Wails fatal not sent because reporting is disabled")
		return
	}
	reason := wailsFatalReason(message)
	debugLogf("crash-reporting: capturing Wails fatal reason=%s", reason)
	event := newWailsFatalEvent(message)
	a.persistAndSendCrashReport(event)
}

func (a *App) captureCrash(recovered any) {
	if !crashReportingEnabled.Load() {
		debugLogf("crash-reporting: panic not sent because reporting is disabled")
		return
	}
	debugLogf("crash-reporting: capturing panic")
	a.persistAndSendCrashReport(newPanicEvent(recovered))
}
