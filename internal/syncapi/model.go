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

type View struct {
	ID string `json:"id"`
}

type Layout struct {
	Views   []View `json:"views"`
	Columns int    `json:"columns"`
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
	ViewID          *string  `json:"viewId"`
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
		ViewID          *string  `json:"viewId"`
		Revision        int64    `json:"revision"`
		ContentRevision int64    `json:"contentRevision"`
	}
	base := baseEntry{e.Kind, e.ID, e.Name, e.ParentID, e.ModifiedAt, e.Position, e.ViewID, e.Revision, e.ContentRevision}
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
	if len(layout.Views) == 0 || layout.Columns < 1 || layout.Columns > len(layout.Views) {
		return fmt.Errorf("invalid desktop layout")
	}
	ids := make(map[string]bool, len(layout.Views))
	for _, view := range layout.Views {
		if !validID(view.ID) || ids[view.ID] {
			return fmt.Errorf("invalid or duplicate view ID")
		}
		ids[view.ID] = true
	}
	return nil
}

func validateSettings(settings EditorSettings) error {
	if settings.FontSize < 11 || settings.FontSize > 22 || !editorLanguages[settings.Language] {
		return fmt.Errorf("invalid editor settings")
	}
	return nil
}

func validateEntries(entries []Entry, layout Layout) error {
	views := make(map[string]bool, len(layout.Views))
	for _, view := range layout.Views {
		views[view.ID] = true
	}
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
		if math.IsNaN(e.Position.X) || math.IsInf(e.Position.X, 0) || e.Position.X < 0 || math.IsNaN(e.Position.Y) || math.IsInf(e.Position.Y, 0) || e.Position.Y < 0 {
			return fmt.Errorf("invalid entry position")
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
		if e.ParentID == nil {
			if e.ViewID == nil || !views[*e.ViewID] {
				return fmt.Errorf("root entry refers to a missing view")
			}
		} else {
			parentKey = *e.ParentID
			if e.ViewID != nil {
				return fmt.Errorf("nested entries cannot belong to a view")
			}
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
