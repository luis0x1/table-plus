package main

import (
	"embed"
	"log"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	configureDebugMode()
	app := NewApp()
	if err := app.restoreCrashReportingPreference(); err != nil {
		debugLogf("crash-reporting: restore persisted preference: %v", err)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			debugLogf("panic recovered in main; sending crash report if enabled")
			app.captureCrash(recovered)
			panic(recovered)
		}
	}()
	if err := wails.Run(&options.App{
		Title:            "QueryNest",
		Width:            1440,
		Height:           900,
		MinWidth:         1040,
		MinHeight:        680,
		Frameless:        true,
		BackgroundColour: &options.RGBA{R: 13, G: 15, B: 18, A: 1},
		Logger:           newCrashReportingWailsLogger(app),
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
	}); err != nil {
		app.captureWailsFatal("wails.Run returned an error")
		log.Print(err)
		os.Exit(1)
	}
}
