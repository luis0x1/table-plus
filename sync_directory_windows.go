//go:build windows

package main

// replaceFile uses MoveFileEx with MOVEFILE_WRITE_THROUGH on Windows. Calling
// os.File.Sync on a directory handle returns access denied there, so no
// additional directory flush is required after the write-through rename.
func syncDirectory(string) error {
	return nil
}
