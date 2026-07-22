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
)

const (
	workspaceSchemaVersion = 5
	metadataName           = "workspace.json"
	logicalMarker          = ".logical-path-storage"
)

type Store struct {
	dir              string
	filesDir         string
	mu               sync.RWMutex
	workspace        Workspace
	subs             map[chan int64]struct{}
	closeOnce        sync.Once
	db               *sql.DB
	historyLimit     int
	persistWorkspace func(Workspace, bool, *mutationReceipt, *ActivityRecord) error
}

func OpenStore(dir string, configuredHistoryLimit ...int) (*Store, error) {
	historyLimit := defaultHistoryLimit
	if len(configuredHistoryLimit) > 1 || len(configuredHistoryLimit) == 1 && configuredHistoryLimit[0] < 1 {
		return nil, fmt.Errorf("history limit must be positive")
	}
	if len(configuredHistoryLimit) == 1 {
		historyLimit = configuredHistoryLimit[0]
	}
	filesDir := filepath.Join(dir, "files")
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
	s := &Store{dir: dir, filesDir: filesDir, historyLimit: historyLimit, subs: make(map[chan int64]struct{})}
	s.workspace.Entries = []Entry{}
	s.workspace.Layout.Wallpaper = "dusk"
	s.workspace.EditorSettings = EditorSettings{AutoSave: true, FontSize: 13, Language: "auto"}
	s.workspace.Appearance = defaultAppearance()
	if err := s.openDatabase(); err != nil {
		return nil, err
	}
	if err := s.pruneActivity(); err != nil {
		_ = s.db.Close()
		return nil, fmt.Errorf("prune activity history: %w", err)
	}
	s.persistWorkspace = s.persistDatabaseWithActivity
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
		if err := s.persistWorkspace(s.workspace, imported, nil, nil); err != nil {
			_ = s.db.Close()
			return nil, fmt.Errorf("persist workspace: %w", err)
		}
	}
	if err := s.initializeBlobStorage(); err != nil {
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
	if header.SchemaVersion < 5 {
		workspace.Appearance = defaultAppearance()
	}
	workspace.Appearance.CustomThemes = nonNilThemes(workspace.Appearance.CustomThemes)
	if err := validateAppearance(workspace.Appearance); err != nil {
		return fmt.Errorf("stored workspace: %w", err)
	}
	if workspace.Initialized {
		if err := validateSettings(workspace.EditorSettings); err != nil {
			return fmt.Errorf("stored workspace: %w", err)
		}
		if err := validateWorkspace(workspace.Entries, workspace.Layout, workspace.Appearance); err != nil {
			return fmt.Errorf("stored workspace: %w", err)
		}
	}
	return nil
}

// Close releases database resources. It is safe to call more than once.
func (s *Store) Close() error {
	var err error
	s.closeOnce.Do(func() {
		if s.db != nil {
			err = s.db.Close()
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
	workspace.Appearance.CustomThemes = append([]CustomTheme(nil), workspace.Appearance.CustomThemes...)
	workspace.Appearance.CustomThemes = nonNilThemes(workspace.Appearance.CustomThemes)
	return workspace
}

func (s *Store) persistLocked(next Workspace, activity *ActivityRecord) error {
	next.Entries = nonNilEntries(next.Entries)
	next.Appearance.CustomThemes = nonNilThemes(next.Appearance.CustomThemes)
	if next.Revision != s.workspace.Revision && (activity == nil || activity.Revision != next.Revision) {
		return fmt.Errorf("revision-changing persistence requires matching activity")
	}
	if err := s.persistWorkspace(next, false, nil, activity); err != nil {
		return fmt.Errorf("persist workspace: %w", err)
	}
	s.workspace = next
	return nil
}

func (s *Store) persistMutationLocked(next Workspace, receipt *mutationReceipt, activity *ActivityRecord) error {
	next.Entries = nonNilEntries(next.Entries)
	next.Appearance.CustomThemes = nonNilThemes(next.Appearance.CustomThemes)
	if next.Revision != s.workspace.Revision && (activity == nil || activity.Revision != next.Revision) {
		return fmt.Errorf("revision-changing persistence requires matching activity")
	}
	if err := s.persistWorkspace(next, false, receipt, activity); err != nil {
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

func nonNilThemes(v []CustomTheme) []CustomTheme {
	if v == nil {
		return []CustomTheme{}
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
	*workspace = Workspace{SchemaVersion: workspaceSchemaVersion, WorkspaceID: legacy.WorkspaceID, Initialized: legacy.Initialized, Revision: legacy.Revision, Entries: entries, Layout: Layout{SnapToGrid: legacy.Layout.SnapToGrid, Wallpaper: legacy.Layout.Wallpaper}, LayoutRevision: legacy.LayoutRevision, EditorSettings: legacy.EditorSettings, SettingsRevision: legacy.SettingsRevision, Appearance: defaultAppearance()}
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
