//go:build !windows

package main

import "os"

// syncDirectory persists directory-entry changes after an atomic rename.
// Unix filesystems support fsync on directory handles; Windows uses the
// write-through MoveFileEx path in replaceFile instead.
func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return err
	}
	return directory.Close()
}
