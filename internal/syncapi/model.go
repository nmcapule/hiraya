package syncapi

import (
	"encoding/json"
	"fmt"
	"math"
	"mime"
	"strings"
	"unicode/utf8"
)

type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type WorkspaceBreak struct {
	EntryID     string `json:"entryId"`
	MaxCapacity int    `json:"maxCapacity"`
}

type Layout struct {
	RootOrder       []string         `json:"rootOrder"`
	WorkspaceBreaks []WorkspaceBreak `json:"workspaceBreaks"`
	SnapToGrid      bool             `json:"snapToGrid"`
	Wallpaper       string           `json:"wallpaper"`
}

type EditorSettings struct {
	AutoSave bool   `json:"autoSave"`
	FontSize int    `json:"fontSize"`
	Language string `json:"language"`
}

type Entry struct {
	Kind            string   `json:"kind"`
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	ParentID        *string  `json:"parentId"`
	ModifiedAt      int64    `json:"modifiedAt"`
	Position        Position `json:"position"`
	MimeType        string   `json:"mimeType"`
	Size            int64    `json:"size"`
	Revision        int64    `json:"revision"`
	ContentRevision int64    `json:"contentRevision"`
}

func (e Entry) MarshalJSON() ([]byte, error) {
	type baseEntry struct {
		Kind            string   `json:"kind"`
		ID              string   `json:"id"`
		Name            string   `json:"name"`
		ParentID        *string  `json:"parentId"`
		ModifiedAt      int64    `json:"modifiedAt"`
		Position        Position `json:"position"`
		Revision        int64    `json:"revision"`
		ContentRevision int64    `json:"contentRevision"`
	}
	base := baseEntry{e.Kind, e.ID, e.Name, e.ParentID, e.ModifiedAt, e.Position, e.Revision, e.ContentRevision}
	if e.Kind != "file" {
		return json.Marshal(base)
	}
	return json.Marshal(struct {
		baseEntry
		MimeType string `json:"mimeType"`
		Size     int64  `json:"size"`
	}{baseEntry: base, MimeType: e.MimeType, Size: e.Size})
}

type Workspace struct {
	SchemaVersion    int            `json:"schemaVersion"`
	WorkspaceID      string         `json:"workspaceId"`
	Initialized      bool           `json:"initialized"`
	Revision         int64          `json:"revision"`
	Entries          []Entry        `json:"entries"`
	Layout           Layout         `json:"layout"`
	LayoutRevision   int64          `json:"layoutRevision"`
	EditorSettings   EditorSettings `json:"editorSettings"`
	SettingsRevision int64          `json:"settingsRevision"`
}

type bootstrapWorkspace struct {
	Entries        []Entry        `json:"entries"`
	Layout         Layout         `json:"layout"`
	EditorSettings EditorSettings `json:"editorSettings"`
}

var editorLanguages = map[string]bool{
	"auto": true, "plain": true, "markdown": true, "json": true,
	"javascript": true, "typescript": true, "jsx": true, "tsx": true,
	"css": true, "html": true, "xml": true, "yaml": true,
}

var wallpapers = map[string]bool{"dusk": true, "grove": true, "ember": true}

func validID(id string) bool {
	if id == "" || len(id) > 180 || id == "." || id == ".." || strings.ContainsAny(id, `/\\`) || !utf8.ValidString(id) {
		return false
	}
	for _, r := range id {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}

func validateName(name string) error {
	if strings.TrimSpace(name) != name || name == "" || name == "." || name == ".." {
		return fmt.Errorf("invalid entry name")
	}
	if utf8.RuneCountInString(name) > 180 || strings.ContainsAny(name, `/\\`) || !utf8.ValidString(name) {
		return fmt.Errorf("invalid entry name")
	}
	for _, r := range name {
		if r < 32 || r == 127 {
			return fmt.Errorf("invalid entry name")
		}
	}
	return nil
}

func validateLayout(layout Layout) error {
	if !wallpapers[layout.Wallpaper] {
		return fmt.Errorf("invalid desktop layout")
	}
	ids := make(map[string]bool, len(layout.RootOrder))
	for _, id := range layout.RootOrder {
		if !validID(id) || ids[id] {
			return fmt.Errorf("invalid or duplicate root order ID")
		}
		ids[id] = true
	}
	breakIDs := make(map[string]bool, len(layout.WorkspaceBreaks))
	for _, workspaceBreak := range layout.WorkspaceBreaks {
		if !validID(workspaceBreak.EntryID) || breakIDs[workspaceBreak.EntryID] {
			return fmt.Errorf("invalid or duplicate workspace break ID")
		}
		if workspaceBreak.MaxCapacity < 1 || workspaceBreak.MaxCapacity > 1_000_000 {
			return fmt.Errorf("invalid workspace break capacity")
		}
		breakIDs[workspaceBreak.EntryID] = true
	}
	if len(layout.RootOrder) == 0 && len(layout.WorkspaceBreaks) != 0 {
		return fmt.Errorf("empty root order cannot contain workspace breaks")
	}
	if len(layout.RootOrder) != 0 && breakIDs[layout.RootOrder[0]] {
		return fmt.Errorf("first root cannot be a workspace break")
	}
	for id := range breakIDs {
		if !ids[id] {
			return fmt.Errorf("workspace break must reference a root order entry")
		}
	}
	return nil
}

func validatePosition(position Position) error {
	if math.IsNaN(position.X) || math.IsInf(position.X, 0) || position.X < 0 || math.IsNaN(position.Y) || math.IsInf(position.Y, 0) || position.Y < 0 {
		return fmt.Errorf("invalid entry position")
	}
	return nil
}

func validateSettings(settings EditorSettings) error {
	if settings.FontSize < 11 || settings.FontSize > 22 || !editorLanguages[settings.Language] {
		return fmt.Errorf("invalid editor settings")
	}
	return nil
}

func validateEntries(entries []Entry) error {
	byID := make(map[string]*Entry, len(entries))
	for i := range entries {
		e := &entries[i]
		if !validID(e.ID) || byID[e.ID] != nil {
			return fmt.Errorf("invalid or duplicate entry ID")
		}
		if err := validateName(e.Name); err != nil {
			return err
		}
		if e.Kind != "file" && e.Kind != "folder" {
			return fmt.Errorf("invalid entry kind")
		}
		if err := validatePosition(e.Position); err != nil {
			return err
		}
		if e.Kind == "file" {
			if e.MimeType == "" || len(e.MimeType) > 255 || e.Size < 0 {
				return fmt.Errorf("invalid file metadata")
			}
			if _, _, err := mime.ParseMediaType(e.MimeType); err != nil {
				return fmt.Errorf("invalid MIME type")
			}
		} else if e.MimeType != "" || e.Size != 0 {
			return fmt.Errorf("folders cannot have file metadata")
		}
		byID[e.ID] = e
	}

	siblingNames := make(map[string]map[string]bool)
	for i := range entries {
		e := &entries[i]
		parentKey := "\x00"
		if e.ParentID != nil {
			parentKey = *e.ParentID
			parent := byID[*e.ParentID]
			if parent == nil || parent.Kind != "folder" {
				return fmt.Errorf("entry refers to a missing parent folder")
			}
		}
		if siblingNames[parentKey] == nil {
			siblingNames[parentKey] = make(map[string]bool)
		}
		folded := strings.ToLower(e.Name)
		if siblingNames[parentKey][folded] {
			return fmt.Errorf("duplicate sibling name %q", e.Name)
		}
		siblingNames[parentKey][folded] = true

		seen := map[string]bool{e.ID: true}
		for parentID := e.ParentID; parentID != nil; parentID = byID[*parentID].ParentID {
			if seen[*parentID] {
				return fmt.Errorf("folder cycle")
			}
			seen[*parentID] = true
		}
	}
	return nil
}

func validateRootOrder(entries []Entry, rootOrder []string) error {
	roots := make(map[string]bool)
	for _, entry := range entries {
		if entry.ParentID == nil {
			roots[entry.ID] = true
		}
	}
	if len(rootOrder) != len(roots) {
		return fmt.Errorf("root order must contain every root entry exactly once")
	}
	seen := make(map[string]bool, len(rootOrder))
	for _, id := range rootOrder {
		if !roots[id] || seen[id] {
			return fmt.Errorf("root order must contain every root entry exactly once")
		}
		seen[id] = true
	}
	return nil
}

func sameRootOrder(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

// removeRoots promotes the next surviving icon when a workspace break's root
// disappears, keeping the adaptive group boundary in place.
func removeRoots(layout *Layout, removed map[string]bool) {
	breaks := make(map[string]WorkspaceBreak, len(layout.WorkspaceBreaks))
	for _, workspaceBreak := range layout.WorkspaceBreaks {
		breaks[workspaceBreak.EntryID] = workspaceBreak
	}
	nextBreaks := make([]WorkspaceBreak, 0, len(layout.WorkspaceBreaks))
	for i, id := range layout.RootOrder {
		workspaceBreak, isBreak := breaks[id]
		if !isBreak {
			continue
		}
		if !removed[id] {
			nextBreaks = append(nextBreaks, workspaceBreak)
			continue
		}
		for j := i + 1; j < len(layout.RootOrder); j++ {
			candidate := layout.RootOrder[j]
			if _, startsNextGroup := breaks[candidate]; startsNextGroup {
				break
			}
			if !removed[candidate] {
				workspaceBreak.EntryID = candidate
				nextBreaks = append(nextBreaks, workspaceBreak)
				break
			}
		}
	}
	layout.RootOrder = removeRootIDs(layout.RootOrder, removed)
	layout.WorkspaceBreaks = nextBreaks
}

func validateWorkspace(entries []Entry, layout Layout) error {
	if err := validateLayout(layout); err != nil {
		return err
	}
	if err := validateEntries(entries); err != nil {
		return err
	}
	return validateRootOrder(entries, layout.RootOrder)
}
