package syncapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	idBlobMarker      = ".id-blob-storage"
	idBlobStageName   = ".id-blob-files-stage"
	logicalBackupName = ".logical-files-backup"
)

func entryPaths(entries []Entry) (map[string]string, error) {
	byID := make(map[string]Entry, len(entries))
	for _, entry := range entries {
		byID[entry.ID] = entry
	}
	paths := make(map[string]string, len(entries))
	visiting := make(map[string]bool)
	var resolve func(string) (string, error)
	resolve = func(id string) (string, error) {
		if path, ok := paths[id]; ok {
			return path, nil
		}
		entry, ok := byID[id]
		if !ok || visiting[id] {
			return "", fmt.Errorf("invalid entry hierarchy")
		}
		visiting[id] = true
		path := entry.Name
		if entry.ParentID != nil {
			parent, err := resolve(*entry.ParentID)
			if err != nil {
				return "", err
			}
			path = filepath.Join(parent, entry.Name)
		}
		delete(visiting, id)
		paths[id] = path
		return path, nil
	}
	for _, entry := range entries {
		if _, err := resolve(entry.ID); err != nil {
			return nil, err
		}
	}
	return paths, nil
}

func (s *Store) entryPathLocked(_ []Entry, id string) (string, error) {
	if !validID(id) {
		return "", os.ErrNotExist
	}
	return filepath.Join(s.filesDir, id), nil
}

func ensureNoSymlink(root, path string) error {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes data directory")
	}
	current := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "." || part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symbolic links are not allowed in data directory")
		}
	}
	return nil
}

func regularFile(path string, expectedSize *int64) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("content is not a regular file")
	}
	if expectedSize != nil && info.Size() != *expectedSize {
		return fmt.Errorf("content size is %d, expected %d", info.Size(), *expectedSize)
	}
	return nil
}

func openRegularFile(path string, expectedSize *int64) (*os.File, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("content is not a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || expectedSize != nil && after.Size() != *expectedSize {
		file.Close()
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("content changed or is not a regular file")
	}
	return file, nil
}

func (s *Store) initializeBlobStorage() error {
	defer os.Remove(filepath.Join(s.dir, ".filesystem.json"))
	marker := filepath.Join(s.dir, idBlobMarker)
	stage := filepath.Join(s.dir, idBlobStageName)
	backup := filepath.Join(s.dir, logicalBackupName)
	if _, err := os.Stat(marker); err == nil {
		_ = os.RemoveAll(stage)
		if _, backupErr := os.Stat(backup); backupErr == nil {
			recovery := filepath.Join(s.dir, fmt.Sprintf(".legacy-logical-files-recovery-%d", time.Now().UnixNano()))
			if err := os.Rename(backup, recovery); err != nil {
				return fmt.Errorf("preserve recovered logical storage: %w", err)
			}
		} else if !errors.Is(backupErr, os.ErrNotExist) {
			return fmt.Errorf("inspect logical storage backup: %w", backupErr)
		}
		_ = os.Remove(filepath.Join(s.dir, logicalMarker))
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect blob storage marker: %w", err)
	}

	// Before the marker is durable, always restore the old tree and restart the
	// migration. This handles interruption at either side of the directory swap.
	if _, err := os.Stat(backup); err == nil {
		interrupted := filepath.Join(s.dir, ".interrupted-id-blob-files")
		_ = os.RemoveAll(interrupted)
		if err := os.Rename(s.filesDir, interrupted); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("recover interrupted blob migration: %w", err)
		}
		if err := os.Rename(backup, s.filesDir); err != nil {
			_ = os.Rename(interrupted, s.filesDir)
			return fmt.Errorf("restore logical storage: %w", err)
		}
		_ = os.RemoveAll(interrupted)
	}
	_ = os.RemoveAll(stage)

	logical := filepath.Join(s.dir, logicalMarker)
	if _, err := os.Stat(logical); errors.Is(err, os.ErrNotExist) {
		// Pre-logical releases already used ID-keyed blobs. Validate known files
		// and adopt that storage without interpreting unrelated directory entries.
		for _, entry := range s.workspace.Entries {
			if entry.Kind == "file" {
				path := filepath.Join(s.filesDir, entry.ID)
				if err := ensureNoSymlink(s.dir, path); err != nil {
					return fmt.Errorf("validate legacy blob %q: %w", entry.ID, err)
				}
				if err := regularFile(path, &entry.Size); err != nil {
					return fmt.Errorf("validate legacy blob %q: %w", entry.ID, err)
				}
			}
		}
		if err := atomicWrite(marker, []byte("1\n"), 0o600); err != nil {
			return fmt.Errorf("mark ID blob storage: %w", err)
		}
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect logical storage marker: %w", err)
	}

	if err := os.Mkdir(stage, 0o700); err != nil {
		return fmt.Errorf("stage blob migration: %w", err)
	}
	paths, err := entryPaths(s.workspace.Entries)
	if err != nil {
		return err
	}
	for _, entry := range s.workspace.Entries {
		if entry.Kind != "file" {
			continue
		}
		source := filepath.Join(s.filesDir, paths[entry.ID])
		if err := ensureNoSymlink(s.dir, source); err != nil {
			return fmt.Errorf("validate logical file %q: %w", paths[entry.ID], err)
		}
		in, err := openRegularFile(source, &entry.Size)
		if err != nil {
			return fmt.Errorf("stage logical file %q: %w", paths[entry.ID], err)
		}
		n, copyErr := atomicCopy(filepath.Join(stage, entry.ID), in, entry.Size)
		closeErr := in.Close()
		if err := errors.Join(copyErr, closeErr); err != nil {
			return err
		}
		if n != entry.Size {
			return fmt.Errorf("logical file %q size changed during migration", paths[entry.ID])
		}
	}
	if err := os.Rename(s.filesDir, backup); err != nil {
		return fmt.Errorf("back up logical storage: %w", err)
	}
	if err := os.Rename(stage, s.filesDir); err != nil {
		_ = os.Rename(backup, s.filesDir)
		return fmt.Errorf("promote ID blob storage: %w", err)
	}
	if err := atomicWrite(marker, []byte("1\n"), 0o600); err != nil {
		// atomicWrite may fail after renaming the marker but before syncing its
		// directory. Keep both trees in that case so either marker outcome is
		// recoverable after a restart.
		if _, markerErr := os.Stat(marker); errors.Is(markerErr, os.ErrNotExist) {
			_ = os.RemoveAll(s.filesDir)
			_ = os.Rename(backup, s.filesDir)
		}
		return fmt.Errorf("mark ID blob storage: %w", err)
	}
	if err := syncDir(s.dir); err != nil {
		return err
	}
	recovery := filepath.Join(s.dir, fmt.Sprintf(".legacy-logical-files-recovery-%d", time.Now().UnixNano()))
	if err := os.Rename(backup, recovery); err != nil {
		return fmt.Errorf("preserve legacy logical storage: %w", err)
	}
	_ = os.Remove(logical)
	return nil
}

func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func newEntryID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate entry ID: %w", err)
	}
	return hex.EncodeToString(value[:]), nil
}
