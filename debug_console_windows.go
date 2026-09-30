//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

var (
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	attachConsoleProc = kernel32.NewProc("AttachConsole")
	allocConsoleProc  = kernel32.NewProc("AllocConsole")
)

const attachParentProcess = ^uintptr(0)

func enableDebugConsole() error {
	// A GUI-subsystem executable is not automatically attached to the terminal
	// that launched it. Prefer the parent's console so QueryNest.exe --debug
	// behaves naturally from cmd/PowerShell, and allocate one for shortcuts or
	// double-click launches.
	attachConsoleProc.Call(attachParentProcess)
	if err := bindConsoleStreams(); err == nil {
		return nil
	}
	result, _, callErr := allocConsoleProc.Call()
	if result == 0 {
		return fmt.Errorf("allocate console: %v", callErr)
	}
	return bindConsoleStreams()
}

func bindConsoleStreams() error {
	stdout, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	stderr, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err != nil {
		_ = stdout.Close()
		return err
	}
	stdin, err := os.OpenFile("CONIN$", os.O_RDONLY, 0)
	if err != nil {
		_ = stdout.Close()
		_ = stderr.Close()
		return err
	}
	os.Stdout = stdout
	os.Stderr = stderr
	os.Stdin = stdin
	return nil
}
