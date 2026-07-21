package syncapi

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

type diskFingerprint struct {
	Kind    string `json:"kind"`
	Size    int64  `json:"size,omitempty"`
	ModTime int64  `json:"modTime,omitempty"`
	Hash    string `json:"hash,omitempty"`
}

type diskNode struct {
	rel         string
	name        string
	parent      string
	fingerprint diskFingerprint
}

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

func (s *Store) entryPathLocked(entries []Entry, id string) (string, error) {
	paths, err := entryPaths(entries)
	if err != nil {
		return "", err
	}
	rel, ok := paths[id]
	if !ok {
		return "", os.ErrNotExist
	}
	return filepath.Join(s.filesDir, rel), nil
}

func ensureNoSymlink(root, path string) error {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes files directory")
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
			return fmt.Errorf("symbolic links are not allowed in files directory")
		}
	}
	return nil
}

func (s *Store) migrateIDStorage() error {
	stage, err := os.MkdirTemp(s.dir, ".logical-files-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	paths, err := entryPaths(s.workspace.Entries)
	if err != nil {
		return err
	}
	entries := append([]Entry(nil), s.workspace.Entries...)
	sort.Slice(entries, func(i, j int) bool {
		return strings.Count(paths[entries[i].ID], string(filepath.Separator)) < strings.Count(paths[entries[j].ID], string(filepath.Separator))
	})
	for _, entry := range entries {
		target := filepath.Join(stage, paths[entry.ID])
		if entry.Kind == "folder" {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		source := filepath.Join(s.filesDir, entry.ID)
		info, err := os.Lstat(source)
		if err != nil {
			return fmt.Errorf("read blob %q: %w", entry.ID, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("blob %q is not a regular file", entry.ID)
		}
		in, err := os.Open(source)
		if err != nil {
			return err
		}
		n, copyErr := atomicCopy(target, in, entry.Size)
		closeErr := in.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if n != entry.Size {
			return fmt.Errorf("blob %q size is %d, expected %d", entry.ID, n, entry.Size)
		}
	}
	backup := filepath.Join(s.dir, ".id-files-backup")
	_ = os.RemoveAll(backup)
	if err := os.Rename(s.filesDir, backup); err != nil {
		return err
	}
	if err := os.Rename(stage, s.filesDir); err != nil {
		_ = os.Rename(backup, s.filesDir)
		return err
	}
	if err := atomicWrite(filepath.Join(s.dir, logicalMarker), []byte("1\n"), 0o600); err != nil {
		_ = os.RemoveAll(s.filesDir)
		_ = os.Rename(backup, s.filesDir)
		return err
	}
	for _, entry := range s.workspace.Entries {
		if entry.Kind == "file" {
			if err := os.Remove(filepath.Join(backup, entry.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
				slog.Warn("could not remove migrated source blob", "id", entry.ID, "error", err)
			}
		}
	}
	remaining, readErr := os.ReadDir(backup)
	if readErr != nil {
		slog.Warn("could not inspect migrated ID storage backup", "path", backup, "error", readErr)
	} else if len(remaining) == 0 {
		if err := os.Remove(backup); err != nil {
			slog.Warn("could not remove migrated ID storage backup", "path", backup, "error", err)
		}
	} else {
		recovery := filepath.Join(s.dir, fmt.Sprintf(".legacy-files-recovery-%d", time.Now().UnixNano()))
		if err := os.Rename(backup, recovery); err != nil {
			slog.Warn("could not preserve unrecognized legacy files", "path", backup, "error", err)
		} else {
			slog.Warn("preserved unrecognized legacy files", "path", recovery)
		}
	}
	return syncDir(s.dir)
}

func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func scanFilesystem(root string) (map[string]diskNode, error) {
	nodes := make(map[string]diskNode)
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			slog.Warn("ignoring symbolic link in files directory", "path", rel)
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if err := validateName(d.Name()); err != nil {
			slog.Warn("ignoring invalid filesystem entry", "path", rel, "error", err)
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		node := diskNode{rel: rel, name: d.Name(), parent: filepath.Dir(rel)}
		if node.parent == "." {
			node.parent = ""
		}
		if info.IsDir() {
			node.fingerprint.Kind = "folder"
		} else if info.Mode().IsRegular() {
			node.fingerprint = diskFingerprint{Kind: "file", Size: info.Size(), ModTime: info.ModTime().UnixNano()}
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			hash := sha256.New()
			_, copyErr := io.Copy(hash, file)
			closeErr := file.Close()
			if copyErr != nil || closeErr != nil {
				return errors.Join(copyErr, closeErr)
			}
			node.fingerprint.Hash = hex.EncodeToString(hash.Sum(nil))
		} else {
			slog.Warn("ignoring non-regular filesystem entry", "path", rel)
			return nil
		}
		nodes[rel] = node
		return nil
	})
	return nodes, err
}

func (s *Store) refreshDiskIndexLocked() error {
	nodes, err := scanFilesystem(s.filesDir)
	if err != nil {
		return fmt.Errorf("scan files directory: %w", err)
	}
	disk := make(map[string]diskFingerprint, len(nodes))
	for path, node := range nodes {
		disk[path] = node.fingerprint
	}
	b, err := json.Marshal(disk)
	if err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(s.dir, diskIndexName), b, 0o600); err != nil {
		return fmt.Errorf("persist filesystem index: %w", err)
	}
	s.disk = disk
	return nil
}

func (s *Store) persistDiskIndexLocked() error {
	b, err := json.Marshal(s.disk)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.dir, diskIndexName), b, 0o600)
}

func (s *Store) trackPathLocked(path, kind string) error {
	rel, err := filepath.Rel(s.filesDir, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes files directory")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	fingerprint := diskFingerprint{Kind: kind}
	if kind == "file" {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("file path is not regular")
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			return errors.Join(copyErr, closeErr)
		}
		fingerprint.Size = info.Size()
		fingerprint.ModTime = info.ModTime().UnixNano()
		fingerprint.Hash = hex.EncodeToString(hash.Sum(nil))
	} else if !info.IsDir() {
		return fmt.Errorf("folder path is not a directory")
	}
	s.disk[rel] = fingerprint
	return nil
}

func (s *Store) trackExpectedFileLocked(target, source string) error {
	rel, err := filepath.Rel(s.filesDir, target)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes files directory")
	}
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return errors.Join(copyErr, closeErr)
	}
	s.disk[rel] = diskFingerprint{Kind: "file", Size: n, Hash: hex.EncodeToString(hash.Sum(nil))}
	return nil
}

func (s *Store) trackEmptyFileLocked(target string) error {
	rel, err := filepath.Rel(s.filesDir, target)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes files directory")
	}
	emptyHash := sha256.Sum256(nil)
	s.disk[rel] = diskFingerprint{Kind: "file", Hash: hex.EncodeToString(emptyHash[:])}
	return nil
}

func sameDiskFingerprint(left, right diskFingerprint) bool {
	return left.Kind == right.Kind && left.Size == right.Size && left.Hash == right.Hash
}

func (s *Store) moveDiskPathLocked(oldPath, newPath string) {
	oldRel, oldErr := filepath.Rel(s.filesDir, oldPath)
	newRel, newErr := filepath.Rel(s.filesDir, newPath)
	if oldErr != nil || newErr != nil {
		return
	}
	prefix := oldRel + string(filepath.Separator)
	for path, fingerprint := range s.disk {
		if path != oldRel && !strings.HasPrefix(path, prefix) {
			continue
		}
		suffix := strings.TrimPrefix(path, oldRel)
		delete(s.disk, path)
		s.disk[newRel+suffix] = fingerprint
	}
}

func (s *Store) removeDiskPathLocked(path string) {
	rel, err := filepath.Rel(s.filesDir, path)
	if err != nil {
		return
	}
	prefix := rel + string(filepath.Separator)
	for diskPath := range s.disk {
		if diskPath == rel || strings.HasPrefix(diskPath, prefix) {
			delete(s.disk, diskPath)
		}
	}
}

func (s *Store) addWatchDirs() error {
	return filepath.WalkDir(s.filesDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if s.watched[path] {
				return nil
			}
			if err := s.watcher.Add(path); err != nil {
				return fmt.Errorf("watch files directory: %w", err)
			}
			s.watched[path] = true
		}
		return nil
	})
}

func (s *Store) watchFilesystem() {
	defer s.wg.Done()
	fallback := time.NewTicker(watchFallback)
	defer fallback.Stop()
	var timer *time.Timer
	var timerC <-chan time.Time
	for {
		select {
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				prefix := event.Name + string(filepath.Separator)
				for path := range s.watched {
					if path == event.Name || strings.HasPrefix(path, prefix) {
						delete(s.watched, path)
					}
				}
			}
			if timer == nil {
				timer = time.NewTimer(watchDebounce)
			} else {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(watchDebounce)
			}
			timerC = timer.C
		case err, ok := <-s.watcher.Errors:
			if ok {
				slog.Warn("filesystem watcher error", "error", err)
			}
		case <-timerC:
			timerC = nil
			if err := s.reconcileFilesystem(); err != nil {
				slog.Warn("could not reconcile external filesystem change", "error", err)
			}
			if err := s.addWatchDirs(); err != nil {
				slog.Warn("could not watch new filesystem directory", "error", err)
			}
		case <-fallback.C:
			if err := s.reconcileFilesystem(); err != nil {
				slog.Warn("could not reconcile filesystem during watcher fallback", "error", err)
			}
		case <-s.done:
			if timer != nil {
				timer.Stop()
			}
			return
		}
	}
}

func (s *Store) reconcileFilesystem() error {
	for {
		s.mu.RLock()
		generation := s.filesystemGeneration
		s.mu.RUnlock()
		nodes, err := s.scanFiles(s.filesDir)
		if err != nil {
			return err
		}
		s.mu.Lock()
		if generation != s.filesystemGeneration {
			s.mu.Unlock()
			continue
		}
		err = s.reconcileFilesystemLocked(nodes)
		s.mu.Unlock()
		return err
	}
}

func (s *Store) reconcileFilesystemLocked(nodes map[string]diskNode) error {
	// Watch newly discovered directories before publishing their metadata so
	// immediate child edits cannot race the next watch registration.
	if s.watcher != nil {
		if err := s.addWatchDirs(); err != nil {
			slog.Warn("could not watch new filesystem directory", "error", err)
		}
	}
	if !s.workspace.Initialized {
		return s.setDiskIndexLocked(nodes)
	}
	paths, err := entryPaths(s.workspace.Entries)
	if err != nil {
		return err
	}
	pathEntries := make(map[string]Entry, len(paths))
	for _, entry := range s.workspace.Entries {
		pathEntries[paths[entry.ID]] = entry
	}
	changed := false
	deleted := make(map[string]bool)
	for path, entry := range pathEntries {
		node, exists := nodes[path]
		if !exists || node.fingerprint.Kind != entry.Kind {
			deleted[entry.ID] = true
		}
	}
	for again := true; again; {
		again = false
		for _, entry := range s.workspace.Entries {
			if entry.ParentID != nil && deleted[*entry.ParentID] && !deleted[entry.ID] {
				deleted[entry.ID] = true
				again = true
			}
		}
	}
	next := cloneWorkspace(s.workspace)
	if len(deleted) != 0 {
		kept := next.Entries[:0]
		for _, entry := range next.Entries {
			if !deleted[entry.ID] {
				kept = append(kept, entry)
			}
		}
		next.Entries = kept
		changed = true
	}
	paths, _ = entryPaths(next.Entries)
	pathIDs := make(map[string]string, len(paths))
	for id, path := range paths {
		pathIDs[path] = id
	}
	revision := next.Revision + 1
	for i := range next.Entries {
		entry := &next.Entries[i]
		if entry.Kind != "file" {
			continue
		}
		path := paths[entry.ID]
		node, exists := nodes[path]
		if exists && node.fingerprint.Kind == "file" && !sameDiskFingerprint(node.fingerprint, s.disk[path]) {
			entry.Size = node.fingerprint.Size
			entry.MimeType = inferMIME(filepath.Join(s.filesDir, path), entry.Name)
			entry.ModifiedAt = time.Now().UnixMilli()
			entry.Revision = revision
			entry.ContentRevision = revision
			changed = true
		}
	}
	ordered := make([]string, 0, len(nodes))
	for path := range nodes {
		ordered = append(ordered, path)
	}
	sort.Slice(ordered, func(i, j int) bool {
		di, dj := strings.Count(ordered[i], string(filepath.Separator)), strings.Count(ordered[j], string(filepath.Separator))
		if di != dj {
			return di < dj
		}
		return ordered[i] < ordered[j]
	})
	siblingNames := make(map[string]map[string]bool)
	for id, path := range paths {
		parent := filepath.Dir(path)
		if parent == "." {
			parent = ""
		}
		if siblingNames[parent] == nil {
			siblingNames[parent] = make(map[string]bool)
		}
		entry := next.Entries[entryIndex(next.Entries, id)]
		siblingNames[parent][strings.ToLower(entry.Name)] = true
	}
	rootCount := 0
	for _, entry := range next.Entries {
		if entry.ParentID == nil {
			rootCount++
		}
	}
	for _, path := range ordered {
		if _, exists := pathIDs[path]; exists {
			continue
		}
		node := nodes[path]
		parentID := (*string)(nil)
		if node.parent == "" {
		} else {
			id, exists := pathIDs[node.parent]
			if !exists {
				continue
			}
			parent := next.Entries[entryIndex(next.Entries, id)]
			if parent.Kind != "folder" {
				continue
			}
			parentID = &id
		}
		if siblingNames[node.parent] == nil {
			siblingNames[node.parent] = make(map[string]bool)
		}
		folded := strings.ToLower(node.name)
		if siblingNames[node.parent][folded] {
			slog.Warn("ignoring filesystem entry with conflicting sibling name", "path", path)
			continue
		}
		id, err := newEntryID()
		if err != nil {
			return err
		}
		entry := Entry{Kind: node.fingerprint.Kind, ID: id, Name: node.name, ParentID: parentID, ModifiedAt: time.Now().UnixMilli(), Revision: revision}
		if parentID == nil {
			entry.Position = autoPosition(rootCount)
			rootCount++
		}
		if entry.Kind == "file" {
			entry.Size = node.fingerprint.Size
			entry.MimeType = inferMIME(filepath.Join(s.filesDir, path), entry.Name)
			entry.ContentRevision = revision
		}
		next.Entries = append(next.Entries, entry)
		pathIDs[path] = id
		siblingNames[node.parent][folded] = true
		changed = true
	}
	if changed {
		next.Revision = revision
		if err := validateWorkspace(next.Entries, next.Layout, next.Appearance); err != nil {
			return fmt.Errorf("external filesystem state is invalid: %w", err)
		}
		if err := s.persistLocked(next); err != nil {
			return err
		}
		if err := s.setDiskIndexLocked(nodes); err != nil {
			slog.Warn("could not persist reconciled filesystem index", "error", err)
		}
		s.publishLocked(revision)
		return nil
	}
	return s.setDiskIndexLocked(nodes)
}

func (s *Store) setDiskIndexLocked(nodes map[string]diskNode) error {
	disk := make(map[string]diskFingerprint, len(nodes))
	for path, node := range nodes {
		disk[path] = node.fingerprint
	}
	s.disk = disk
	return s.persistDiskIndexLocked()
}

func newEntryID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate entry ID: %w", err)
	}
	return hex.EncodeToString(value[:]), nil
}

func autoPosition(index int) Position {
	return Position{X: float64(24 + (index%8)*104), Y: float64(24 + (index/8)*112)}
}

func inferMIME(path, name string) string {
	if value := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); value != "" {
		return value
	}
	file, err := os.Open(path)
	if err != nil {
		return "application/octet-stream"
	}
	defer file.Close()
	var sample [512]byte
	n, _ := file.Read(sample[:])
	return http.DetectContentType(sample[:n])
}
