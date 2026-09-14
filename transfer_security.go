package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const previewTokenLifetime = 15 * time.Minute

type previewedFile struct {
	path      string
	info      os.FileInfo
	digest    [sha256.Size]byte
	createdAt time.Time
}

func (a *App) registerPreviewFile(path string) (string, error) {
	entry, err := inspectPreviewFile(path)
	if err != nil {
		return "", err
	}
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("create preview capability: %w", err)
	}
	token := "preview_" + hex.EncodeToString(random)
	now := time.Now()
	entry.createdAt = now
	a.previewMu.Lock()
	for current, preview := range a.previewFiles {
		if now.Sub(preview.createdAt) > previewTokenLifetime {
			delete(a.previewFiles, current)
		}
	}
	if len(a.previewFiles) >= 32 {
		var oldestToken string
		var oldest time.Time
		for current, preview := range a.previewFiles {
			if oldestToken == "" || preview.createdAt.Before(oldest) {
				oldestToken, oldest = current, preview.createdAt
			}
		}
		delete(a.previewFiles, oldestToken)
	}
	a.previewFiles[token] = entry
	a.previewMu.Unlock()
	return token, nil
}

func (a *App) consumePreviewFile(token string) (string, error) {
	if !strings.HasPrefix(token, "preview_") || len(token) != len("preview_")+48 {
		return "", errors.New("restore or import requires a fresh file preview")
	}
	a.previewMu.Lock()
	entry, ok := a.previewFiles[token]
	delete(a.previewFiles, token)
	a.previewMu.Unlock()
	if !ok || time.Since(entry.createdAt) > previewTokenLifetime {
		return "", errors.New("file preview expired; preview the file again")
	}
	current, err := inspectPreviewFile(entry.path)
	if err != nil {
		return "", err
	}
	if !os.SameFile(entry.info, current.info) || entry.info.Size() != current.info.Size() || !entry.info.ModTime().Equal(current.info.ModTime()) || entry.digest != current.digest {
		return "", errors.New("the selected file changed after preview; preview it again")
	}
	return entry.path, nil
}

func inspectPreviewFile(path string) (previewedFile, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return previewedFile{}, fmt.Errorf("inspect selected file: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return previewedFile{}, errors.New("selected source must be a regular file, not a symlink")
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return previewedFile{}, fmt.Errorf("resolve selected file: %w", err)
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return previewedFile{}, fmt.Errorf("resolve selected file: %w", err)
	}
	file, err := os.Open(canonical)
	if err != nil {
		return previewedFile{}, fmt.Errorf("open selected file: %w", err)
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() {
		return previewedFile{}, errors.New("selected source is not a regular file")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return previewedFile{}, fmt.Errorf("fingerprint selected file: %w", err)
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return previewedFile{path: canonical, info: openedInfo, digest: digest}, nil
}

func openTransferSource(path string) (*os.File, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open transfer source: %w", err)
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("transfer source must be a regular file")
	}
	if info.Size() > maxTransferSourceBytes {
		_ = file.Close()
		return nil, fmt.Errorf("transfer source exceeds the %d byte limit", maxTransferSourceBytes)
	}
	return file, nil
}
