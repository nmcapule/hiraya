package syncapi

import (
	"database/sql"
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
	workspaceSchemaVersion = 4
	metadataName           = "workspace.json"
	logicalMarker          = ".logical-path-storage"
	diskIndexName          = ".filesystem.json"
	watchDebounce          = 75 * time.Millisecond
	watchFallback          = time.Second
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
	// filesystemGeneration invalidates scans that overlap an API mutation.
	filesystemGeneration uint64
	db                   *sql.DB
	persistWorkspace     func(Workspace, bool) error
	scanFiles            func(string) (map[string]diskNode, error)
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
	if backups, globErr := filepath.Glob(filepath.Join(dir, ".content-backup-*")); globErr == nil {
		for _, backup := range backups {
			if removeErr := os.Remove(backup); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				slog.Warn("could not remove orphaned content backup", "path", backup, "error", removeErr)
			}
		}
	}
	s := &Store{dir: dir, filesDir: filesDir, subs: make(map[chan int64]struct{}), disk: make(map[string]diskFingerprint), done: make(chan struct{}), watched: make(map[string]bool), scanFiles: scanFilesystem}
	s.workspace.Entries = []Entry{}
	s.workspace.Layout.Wallpaper = "dusk"
	s.workspace.EditorSettings = EditorSettings{AutoSave: true, FontSize: 13, Language: "auto"}
	if err := s.openDatabase(); err != nil {
		return nil, err
	}
	s.persistWorkspace = s.persistDatabase
	workspace, found, err := s.loadDatabaseWorkspace()
	if err != nil {
		_ = s.db.Close()
		return nil, err
	}
	if found {
		s.workspace = workspace
	} else {
		b, readErr := os.ReadFile(filepath.Join(dir, metadataName))
		imported := readErr == nil
		if errors.Is(readErr, os.ErrNotExist) {
			s.workspace.SchemaVersion = workspaceSchemaVersion
			s.workspace.WorkspaceID, err = newEntryID()
			if err != nil {
				_ = s.db.Close()
				return nil, err
			}
		} else if readErr != nil {
			_ = s.db.Close()
			return nil, fmt.Errorf("read workspace: %w", readErr)
		} else if err := decodeWorkspaceMetadata(b, &s.workspace); err != nil {
			_ = s.db.Close()
			return nil, err
		}
		if err := s.persistWorkspace(s.workspace, imported); err != nil {
			_ = s.db.Close()
			return nil, fmt.Errorf("persist workspace: %w", err)
		}
	}
	if err := s.initializeFilesystem(); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

func decodeWorkspaceMetadata(b []byte, workspace *Workspace) error {
	var header struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(b, &header); err != nil {
		return fmt.Errorf("decode workspace: %w", err)
	}
	if header.SchemaVersion < 0 || header.SchemaVersion > workspaceSchemaVersion {
		return fmt.Errorf("unsupported workspace schema version %d", header.SchemaVersion)
	}
	if header.SchemaVersion < 2 {
		if err := migrateWorkspaceV1(b, workspace); err != nil {
			return fmt.Errorf("migrate workspace schema v1: %w", err)
		}
	} else if err := json.Unmarshal(b, workspace); err != nil {
		return fmt.Errorf("decode workspace: %w", err)
	}
	if workspace.WorkspaceID == "" {
		var err error
		workspace.WorkspaceID, err = newEntryID()
		if err != nil {
			return err
		}
	}
	if !validID(workspace.WorkspaceID) {
		return fmt.Errorf("stored workspace has invalid workspace ID")
	}
	workspace.SchemaVersion = workspaceSchemaVersion
	if workspace.Entries == nil {
		workspace.Entries = []Entry{}
	}
	if workspace.Initialized {
		if err := validateSettings(workspace.EditorSettings); err != nil {
			return fmt.Errorf("stored workspace: %w", err)
		}
		if err := validateWorkspace(workspace.Entries, workspace.Layout); err != nil {
			return fmt.Errorf("stored workspace: %w", err)
		}
	}
	return nil
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
		if err := s.reconcileFilesystem(); err != nil {
			return fmt.Errorf("reconcile filesystem: %w", err)
		}
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

// Close releases filesystem watcher and database resources. It is safe to call more than once.
func (s *Store) Close() error {
	var err error
	s.closeOnce.Do(func() {
		close(s.done)
		if s.watcher != nil {
			err = s.watcher.Close()
		}
		s.wg.Wait()
		if s.db != nil {
			err = errors.Join(err, s.db.Close())
		}
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
	workspace.Entries = nonNilEntries(workspace.Entries)
	return workspace
}

func (s *Store) persistLocked(next Workspace) error {
	next.Entries = nonNilEntries(next.Entries)
	if err := s.persistWorkspace(next, false); err != nil {
		return fmt.Errorf("persist workspace: %w", err)
	}
	s.workspace = next
	return nil
}

func (s *Store) persistMutationLocked(next Workspace, receipt *mutationReceipt) error {
	next.Entries = nonNilEntries(next.Entries)
	if err := s.persistDatabaseWithReceipt(next, false, receipt); err != nil {
		return fmt.Errorf("persist workspace: %w", err)
	}
	s.workspace = next
	return nil
}

func (s *Store) beginMutationLocked() {
	s.filesystemGeneration++
}

func nonNilEntries(v []Entry) []Entry {
	if v == nil {
		return []Entry{}
	}
	return v
}

type legacyView struct {
	ID string `json:"id"`
}

type legacyLayout struct {
	Views      []legacyView `json:"views"`
	Columns    int          `json:"columns"`
	SnapToGrid bool         `json:"snapToGrid"`
	Wallpaper  string       `json:"wallpaper"`
}

type legacyEntry struct {
	Kind            string   `json:"kind"`
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	ParentID        *string  `json:"parentId"`
	ModifiedAt      int64    `json:"modifiedAt"`
	Position        Position `json:"position"`
	ViewID          *string  `json:"viewId"`
	MimeType        string   `json:"mimeType"`
	Size            int64    `json:"size"`
	Revision        int64    `json:"revision"`
	ContentRevision int64    `json:"contentRevision"`
}

func migrateWorkspaceV1(data []byte, workspace *Workspace) error {
	var legacy struct {
		SchemaVersion    int            `json:"schemaVersion"`
		WorkspaceID      string         `json:"workspaceId"`
		Initialized      bool           `json:"initialized"`
		Revision         int64          `json:"revision"`
		Entries          []legacyEntry  `json:"entries"`
		Layout           legacyLayout   `json:"layout"`
		LayoutRevision   int64          `json:"layoutRevision"`
		EditorSettings   EditorSettings `json:"editorSettings"`
		SettingsRevision int64          `json:"settingsRevision"`
	}
	if err := json.Unmarshal(data, &legacy); err != nil {
		return err
	}
	if legacy.Layout.Wallpaper == "" {
		legacy.Layout.Wallpaper = "dusk"
	}
	if legacy.Initialized && (len(legacy.Layout.Views) == 0 || legacy.Layout.Columns < 1 || legacy.Layout.Columns > len(legacy.Layout.Views) || !wallpapers[legacy.Layout.Wallpaper]) {
		return fmt.Errorf("invalid desktop layout")
	}
	viewOrder := make(map[string]int, len(legacy.Layout.Views))
	for i, view := range legacy.Layout.Views {
		if !validID(view.ID) || viewOrder[view.ID] != 0 {
			return fmt.Errorf("invalid or duplicate view ID")
		}
		viewOrder[view.ID] = i + 1
	}
	entries := make([]Entry, len(legacy.Entries))
	for i, entry := range legacy.Entries {
		entries[i] = Entry{Kind: entry.Kind, ID: entry.ID, Name: entry.Name, ParentID: entry.ParentID, ModifiedAt: entry.ModifiedAt, Position: entry.Position, MimeType: entry.MimeType, Size: entry.Size, Revision: entry.Revision, ContentRevision: entry.ContentRevision}
		if entry.ParentID == nil {
			if entry.ViewID == nil || viewOrder[*entry.ViewID] == 0 {
				return fmt.Errorf("root entry refers to a missing view")
			}
		} else if entry.ViewID != nil {
			return fmt.Errorf("nested entries cannot belong to a view")
		}
	}
	if err := validateEntries(entries); err != nil {
		return err
	}
	*workspace = Workspace{SchemaVersion: workspaceSchemaVersion, WorkspaceID: legacy.WorkspaceID, Initialized: legacy.Initialized, Revision: legacy.Revision, Entries: entries, Layout: Layout{SnapToGrid: legacy.Layout.SnapToGrid, Wallpaper: legacy.Layout.Wallpaper}, LayoutRevision: legacy.LayoutRevision, EditorSettings: legacy.EditorSettings, SettingsRevision: legacy.SettingsRevision}
	return nil
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

type contentReplacement struct {
	target string
	backup string
}

func replaceFileContent(target, source, backupDir string, max int64) (*contentReplacement, error) {
	replacement := &contentReplacement{target: target}
	if info, err := os.Lstat(target); err == nil {
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("content target is not a regular file")
		}
		tmp, err := os.CreateTemp(backupDir, ".content-backup-*")
		if err != nil {
			return nil, err
		}
		replacement.backup = tmp.Name()
		old, err := os.Open(target)
		if err != nil {
			tmp.Close()
			_ = os.Remove(replacement.backup)
			return nil, err
		}
		_, copyErr := io.Copy(tmp, old)
		oldCloseErr := old.Close()
		syncErr := tmp.Sync()
		closeErr := tmp.Close()
		if err := errors.Join(copyErr, oldCloseErr, syncErr, closeErr); err != nil {
			_ = os.Remove(replacement.backup)
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	file, err := os.Open(source)
	if err == nil {
		_, err = atomicCopy(target, file, max)
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		if rollbackErr := replacement.rollback(); rollbackErr != nil {
			return nil, errors.Join(err, fmt.Errorf("roll back content replacement: %w", rollbackErr))
		}
		return nil, err
	}
	return replacement, nil
}

func (r *contentReplacement) rollback() error {
	if r.backup == "" {
		removeErr := os.Remove(r.target)
		if errors.Is(removeErr, os.ErrNotExist) {
			return nil
		}
		return removeErr
	}
	backup, err := os.Open(r.backup)
	if err != nil {
		return err
	}
	info, statErr := backup.Stat()
	if statErr != nil {
		backup.Close()
		return statErr
	}
	_, copyErr := atomicCopy(r.target, backup, info.Size())
	closeErr := backup.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return err
	}
	return os.Remove(r.backup)
}

func (r *contentReplacement) commit() error {
	if r.backup == "" {
		return nil
	}
	return os.Remove(r.backup)
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
