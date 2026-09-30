package main

import (
	"os"

	wailslogger "github.com/wailsapp/wails/v2/pkg/logger"
)

type crashReportingWailsLogger struct {
	app      *App
	delegate wailslogger.Logger
}

var _ wailslogger.Logger = (*crashReportingWailsLogger)(nil)

func newCrashReportingWailsLogger(app *App) wailslogger.Logger {
	return &crashReportingWailsLogger{app: app, delegate: wailslogger.NewDefaultLogger()}
}

func (l *crashReportingWailsLogger) Print(message string) {
	l.delegate.Print(message)
}

func (l *crashReportingWailsLogger) Trace(message string) {
	l.delegate.Trace(message)
}

func (l *crashReportingWailsLogger) Debug(message string) {
	l.delegate.Debug(message)
}

func (l *crashReportingWailsLogger) Info(message string) {
	l.delegate.Info(message)
}

func (l *crashReportingWailsLogger) Warning(message string) {
	l.delegate.Warning(message)
}

func (l *crashReportingWailsLogger) Error(message string) {
	l.delegate.Error(message)
}

func (l *crashReportingWailsLogger) Fatal(message string) {
	l.delegate.Print("FAT | " + message)
	l.app.captureWailsFatal(message)
	os.Exit(1)
}
