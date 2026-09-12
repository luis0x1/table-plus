//go:build windows

package main

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

// os.Rename cannot replace an existing file on Windows. MoveFileEx provides
// the replace-existing behavior SaveScript needs while keeping the final swap
// atomic. Short retries cover transient locks from antivirus and file indexers.
func replaceFile(source, target string) error {
	sourcePath, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return fmt.Errorf("encode temporary path: %w", err)
	}
	targetPath, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return fmt.Errorf("encode target path: %w", err)
	}

	const flags = windows.MOVEFILE_REPLACE_EXISTING | windows.MOVEFILE_WRITE_THROUGH
	delays := [...]time.Duration{0, 10 * time.Millisecond, 25 * time.Millisecond, 50 * time.Millisecond, 100 * time.Millisecond, 200 * time.Millisecond}
	for attempt, delay := range delays {
		if delay > 0 {
			time.Sleep(delay)
		}
		err = windows.MoveFileEx(sourcePath, targetPath, flags)
		if err == nil {
			return nil
		}
		if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) && !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return err
		}
		if attempt == len(delays)-1 {
			return err
		}
	}
	return err
}
