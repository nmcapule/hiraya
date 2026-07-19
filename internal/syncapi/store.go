package syncapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

const metadataName = "workspace.json"

type Store struct {
	dir       string
	filesDir  string
	mu        sync.RWMutex
	workspace Workspace
	subs      map[chan int64]struct{}
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "files"), 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	s := &Store{dir: dir, filesDir: filepath.Join(dir, "files"), subs: make(map[chan int64]struct{})}
	s.workspace.Entries = []Entry{}
	s.workspace.Layout.Views = []View{}
	s.workspace.EditorSettings = EditorSettings{AutoSave: true, FontSize: 13, Language: "auto"}
	b, err := os.ReadFile(filepath.Join(dir, metadataName))
	if errors.Is(err, os.ErrNotExist) {
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
	return s, nil
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
