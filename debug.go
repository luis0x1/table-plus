package main

import (
	"log"
	"os"
)

var debugMode bool

func configureDebugMode() {
	for _, argument := range os.Args[1:] {
		if argument == "--debug" {
			debugMode = true
			break
		}
	}
	if !debugMode {
		return
	}
	if err := enableDebugConsole(); err != nil {
		log.Printf("debug console: %v", err)
	}
	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.Lshortfile)
	log.Printf("debug mode enabled (pid=%d)", os.Getpid())
}

func debugLogf(format string, arguments ...any) {
	if debugMode {
		log.Printf(format, arguments...)
	}
}
