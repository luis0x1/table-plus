//go:build gio

package main

import (
	"context"
	"log"
	"os"

	"gioui.org/app"
	"gioui.org/unit"
)

func main() {
	go func() {
		backend := NewApp()
		backend.startup(context.Background())
		defer backend.shutdown(context.Background())

		var window app.Window
		window.Option(
			app.Title("QueryNest — Gio"),
			app.Size(unit.Dp(1440), unit.Dp(900)),
			app.MinSize(unit.Dp(1040), unit.Dp(680)),
		)

		ui := newGioFrontend(backend, &window)
		if err := ui.run(); err != nil {
			log.Printf("gio frontend: %v", err)
		}
		os.Exit(0)
	}()
	app.Main()
}
