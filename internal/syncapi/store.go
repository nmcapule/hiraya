package syncapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	metadataName  = "workspace.json"
	logicalMarker = ".logical-path-storage"
	diskIndexName = ".filesystem.json"
	watchDebounce = 75 * time.Millisecond
	watchFallback = time.Second
)

type Store struct {
	dir       string
	filesDir  string
	mu        sync.RWMutex
	workspace Workspace
	subs      map[chan int64]struct{}
	disk      map[string]diskFingerprint
	watcher   *fsnotify.Watcher
	watched   map[string]bool
	done      chan struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup
}

func OpenStore(dir string) (*Store, error) {
	filesDir := filepath.Join(dir, "files")
	backup := filepath.Join(dir, ".id-files-backup")
	if _, markerErr := os.Stat(filepath.Join(dir, logicalMarker)); errors.Is(markerErr, os.ErrNotExist) {
		if _, backupErr := os.Stat(backup); backupErr == nil {
			interrupted := filepath.Join(dir, ".interrupted-logical-files")
			_ = os.RemoveAll(interrupted)
			if err := os.Rename(filepath.Join(dir, "files"), interrupted); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, fmt.Errorf("recover interrupted storage migration: %w", err)
			}
			if err := os.Rename(backup, filepath.Join(dir, "files")); err != nil {
				_ = os.Rename(interrupted, filepath.Join(dir, "files"))
				return nil, fmt.Errorf("recover ID storage backup: %w", err)
			}
			_ = os.RemoveAll(interrupted)
		}
	}
	if err := os.MkdirAll(filesDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	filesInfo, err := os.Lstat(filesDir)
	if err != nil {
		return nil, fmt.Errorf("inspect files directory: %w", err)
	}
	if !filesInfo.IsDir() || filesInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("files path must be a real directory")
	}
	s := &Store{dir: dir, filesDir: filesDir, subs: make(map[chan int64]struct{}), disk: make(map[string]diskFingerprint), done: make(chan struct{}), watched: make(map[string]bool)}
	s.workspace.Entries = []Entry{}
	s.workspace.Layout.Views = []View{}
	s.workspace.Layout.Wallpaper = "dusk"
	s.workspace.EditorSettings = EditorSettings{AutoSave: true, FontSize: 13, Language: "auto"}
	b, err := os.ReadFile(filepath.Join(dir, metadataName))
	if errors.Is(err, os.ErrNotExist) {
		if err := s.initializeFilesystem(); err != nil {
			return nil, err
		}
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read workspace: %w", err)
	}
	if err := json.Unmarshal(b, &s.workspace); err != nil {
		return nil, fmt.Errorf("decode workspace: %w", err)
	}
	if s.workspace.Entries == nil {
		s.workspace.Entries = []Entry{}
	}
	if s.workspace.Layout.Views == nil {
		s.workspace.Layout.Views = []View{}
	}
	if s.workspace.Initialized {
		if err := validateLayout(s.workspace.Layout); err != nil {
			return nil, fmt.Errorf("stored workspace: %w", err)
		}
		if err := validateSettings(s.workspace.EditorSettings); err != nil {
			return nil, fmt.Errorf("stored workspace: %w", err)
		}
		if err := validateEntries(s.workspace.Entries, s.workspace.Layout); err != nil {
			return nil, fmt.Errorf("stored workspace: %w", err)
		}
	}
	if err := s.initializeFilesystem(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) initializeFilesystem() error {
	migrated := false
	if _, err := os.Stat(filepath.Join(s.dir, logicalMarker)); errors.Is(err, os.ErrNotExist) {
		if s.workspace.Initialized {
			if err := s.migrateIDStorage(); err != nil {
				return fmt.Errorf("migrate file storage: %w", err)
			}
			migrated = true
		}
		if err := atomicWrite(filepath.Join(s.dir, logicalMarker), []byte("1\n"), 0o600); err != nil {
			return fmt.Errorf("mark logical file storage: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("inspect file storage: %w", err)
	}
	if b, err := os.ReadFile(filepath.Join(s.dir, diskIndexName)); err == nil {
		if err := json.Unmarshal(b, &s.disk); err != nil {
			slog.Warn("ignoring invalid filesystem index", "error", err)
			s.disk = make(map[string]diskFingerprint)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read filesystem index: %w", err)
	}
	if migrated {
		if err := s.refreshDiskIndexLocked(); err != nil {
			return err
		}
	} else if s.workspace.Initialized {
		s.mu.Lock()
		if err := s.reconcileFilesystemLocked(); err != nil {
			s.mu.Unlock()
			return fmt.Errorf("reconcile filesystem: %w", err)
		}
		s.mu.Unlock()
	} else if err := s.refreshDiskIndexLocked(); err != nil {
		return err
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("create filesystem watcher: %w", err)
	}
	s.watcher = watcher
	if err := s.addWatchDirs(); err != nil {
		watcher.Close()
		return err
	}
	s.wg.Add(1)
	go s.watchFilesystem()
	return nil
}

// Close releases filesystem watcher resources. It is safe to call more than once.
func (s *Store) Close() error {
	var err error
	s.closeOnce.Do(func() {
		close(s.done)
		if s.watcher != nil {
			err = s.watcher.Close()
		}
		s.wg.Wait()
	})
	return err
}

func (s *Store) snapshot() Workspace {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneWorkspace(s.workspace)
}

func cloneWorkspace(workspace Workspace) Workspace {
	workspace.Entries = append([]Entry(nil), workspace.Entries...)
	workspace.Layout.Views = append([]View(nil), workspace.Layout.Views...)
	workspace.Entries = nonNilEntries(workspace.Entries)
	workspace.Layout.Views = nonNilViews(workspace.Layout.Views)
	return workspace
}

func (s *Store) persistLocked(next Workspace) error {
	next.Entries = nonNilEntries(next.Entries)
	next.Layout.Views = nonNilViews(next.Layout.Views)
	b, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(s.dir, metadataName), b, 0o600); err != nil {
		return fmt.Errorf("persist workspace: %w", err)
	}
	s.workspace = next
	return nil
}

func nonNilEntries(v []Entry) []Entry {
	if v == nil {
		return []Entry{}
	}
	return v
}

func nonNilViews(v []View) []View {
	if v == nil {
		return []View{}
	}
	return v
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func atomicCopy(path string, r io.Reader, max int64) (int64, error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return 0, err
	}
	n, err := io.Copy(tmp, io.LimitReader(r, max+1))
	if err == nil && n > max {
		err = errTooLarge
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return n, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return n, err
	}
	d, err := os.Open(dir)
	if err != nil {
		return n, err
	}
	defer d.Close()
	return n, d.Sync()
}

func (s *Store) subscribe() (chan int64, func()) {
	ch := make(chan int64, 1)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	revision := s.workspace.Revision
	s.mu.Unlock()
	ch <- revision
	return ch, func() {
		s.mu.Lock()
		delete(s.subs, ch)
		close(ch)
		s.mu.Unlock()
	}
}

func (s *Store) publishLocked(revision int64) {
	for ch := range s.subs {
		select {
		case ch <- revision:
		default:
			select {
			case <-ch:
			default:
			}
			ch <- revision
		}
	}
}
