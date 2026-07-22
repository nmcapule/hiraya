package syncapi

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	defaultHistoryLimit = 1000
	defaultActivityPage = 50
	maxActivityPage     = 100
	maxActivityQuery    = 200
)

type ActivityRecord struct {
	Revision  int64    `json:"revision"`
	Action    string   `json:"action"`
	Source    string   `json:"source"`
	Timestamp int64    `json:"timestamp"`
	Summary   string   `json:"summary"`
	Details   []string `json:"details"`
}

type activityPage struct {
	Activities []ActivityRecord `json:"activities"`
	NextBefore *int64           `json:"nextBefore"`
}

func newActivity(revision int64, action, source, summary string, timestamp time.Time, details ...string) *ActivityRecord {
	details = boundedActivityDetails(details)
	return &ActivityRecord{
		Revision: revision, Action: action, Source: source, Timestamp: timestamp.UnixMilli(),
		Summary: summary, Details: append([]string(nil), details...),
	}
}

func activityFromMutation(previous, next Workspace, r *http.Request, timestamp time.Time) *ActivityRecord {
	if next.Revision == previous.Revision {
		return nil
	}
	oldEntries := make(map[string]Entry, len(previous.Entries))
	newEntries := make(map[string]Entry, len(next.Entries))
	for _, entry := range previous.Entries {
		oldEntries[entry.ID] = entry
	}
	for _, entry := range next.Entries {
		newEntries[entry.ID] = entry
	}
	changed := make([]Entry, 0)
	created := make([]Entry, 0)
	deleted := make([]Entry, 0)
	for _, entry := range next.Entries {
		if entry.Revision != next.Revision {
			continue
		}
		changed = append(changed, entry)
		if _, found := oldEntries[entry.ID]; !found {
			created = append(created, entry)
		}
	}
	for _, entry := range previous.Entries {
		if _, found := newEntries[entry.ID]; !found {
			deleted = append(deleted, entry)
		}
	}

	action, summary := "update", "Updated workspace"
	details := entryActivityDetails(changed)
	path := r.URL.Path
	switch {
	case path == "/api/bootstrap":
		action, summary = "bootstrap", "Bootstrapped workspace"
		details = []string{fmt.Sprintf("%d entries", len(next.Entries)), fmt.Sprintf("%d files", countFiles(next.Entries))}
	case path == "/api/imports":
		action, summary = "import", fmt.Sprintf("Imported %d entries", len(created))
		details = entryActivityDetails(created)
	case path == "/api/entries" && len(created) != 0:
		action, summary = "create", fmt.Sprintf("Created %s %q", created[0].Kind, created[0].Name)
		details = entryActivityDetails(created)
	case path == "/api/entries" || strings.HasPrefix(path, "/api/entries/") && r.Method == http.MethodPatch:
		action, summary, details = entryChangeSummary(oldEntries, newEntries, changed)
	case path == "/api/entries/batch-move":
		action, summary = "move", fmt.Sprintf("Moved %d entries", len(changed))
	case path == "/api/entries/batch-delete" || strings.HasPrefix(path, "/api/entries/") && r.Method == http.MethodDelete:
		action, summary = "delete", fmt.Sprintf("Deleted %d entries", len(deleted))
		details = entryActivityDetails(deleted)
	case strings.HasPrefix(path, "/api/files/") && strings.HasSuffix(path, "/content"):
		action = "content"
		if len(changed) != 0 {
			summary = fmt.Sprintf("Updated content of %q", changed[0].Name)
			details = append(details, fmt.Sprintf("MIME type: %s", changed[0].MimeType), fmt.Sprintf("Size: %d bytes", changed[0].Size))
		}
	case path == "/api/layout":
		action, summary = "layout", "Updated desktop layout"
		details = []string{fmt.Sprintf("Snap to grid: %t", next.Layout.SnapToGrid), "Wallpaper: " + next.Layout.Wallpaper}
	case path == "/api/desktop-positions":
		action, summary = "positions", fmt.Sprintf("Moved %d desktop icons", len(changed))
	case path == "/api/editor-settings":
		action, summary = "settings", "Updated editor settings"
		details = []string{fmt.Sprintf("Auto save: %t", next.EditorSettings.AutoSave), fmt.Sprintf("Font size: %d", next.EditorSettings.FontSize), "Language: " + next.EditorSettings.Language}
	case path == "/api/theme-selection":
		action, summary = "theme-selection", "Changed selected theme"
		details = []string{"Theme ID: " + next.Appearance.SelectedThemeID}
	case strings.HasPrefix(path, "/api/themes/") && r.Method == http.MethodPut:
		id := r.PathValue("id")
		index := themeIndex(next.Appearance.CustomThemes, id)
		oldIndex := themeIndex(previous.Appearance.CustomThemes, id)
		if index >= 0 {
			theme := next.Appearance.CustomThemes[index]
			action, summary = "theme-update", fmt.Sprintf("Updated theme %q", theme.Name)
			if oldIndex < 0 {
				action, summary = "theme-create", fmt.Sprintf("Created theme %q", theme.Name)
			}
			details = []string{"Theme ID: " + theme.ID, "Name: " + theme.Name}
		}
	case strings.HasPrefix(path, "/api/themes/") && r.Method == http.MethodDelete:
		id := r.PathValue("id")
		index := themeIndex(previous.Appearance.CustomThemes, id)
		action, summary = "theme-delete", "Deleted custom theme"
		if index >= 0 {
			theme := previous.Appearance.CustomThemes[index]
			summary = fmt.Sprintf("Deleted theme %q", theme.Name)
			details = []string{"Theme ID: " + theme.ID, "Name: " + theme.Name}
		}
	}
	return newActivity(next.Revision, action, "api", summary, timestamp, details...)
}

func entryChangeSummary(oldEntries, newEntries map[string]Entry, changed []Entry) (string, string, []string) {
	if len(changed) == 0 {
		return "update", "Updated entry", nil
	}
	entry := changed[0]
	old := oldEntries[entry.ID]
	if old.Name != entry.Name {
		return "rename", fmt.Sprintf("Renamed %s %q to %q", entry.Kind, old.Name, entry.Name), []string{"From: " + old.Name, "To: " + entry.Name}
	}
	if !sameParent(old.ParentID, entry.ParentID) {
		return "move", fmt.Sprintf("Moved %s %q", entry.Kind, entry.Name), []string{
			entryDetail(entry),
			"From: " + activityLocation(oldEntries, old.ParentID),
			"To: " + activityLocation(newEntries, entry.ParentID),
		}
	}
	if old.Position != entry.Position {
		return "positions", fmt.Sprintf("Moved desktop item %q", entry.Name), []string{entryDetail(entry)}
	}
	return "update", fmt.Sprintf("Updated %s %q", entry.Kind, entry.Name), []string{entryDetail(entry)}
}

func entryDetail(entry Entry) string {
	kind := entry.Kind
	if kind != "" {
		kind = strings.ToUpper(kind[:1]) + kind[1:]
	}
	return fmt.Sprintf("%s: %s", kind, entry.Name)
}

func activityLocation(entries map[string]Entry, parentID *string) string {
	if parentID == nil {
		return "Desktop"
	}
	if parent, found := entries[*parentID]; found {
		return parent.Name
	}
	return "Unknown folder"
}

func sameParent(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (s *Server) getActivity(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(utf16.Encode([]rune(query))) > maxActivityQuery {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("q must not exceed %d characters", maxActivityQuery))
		return
	}
	before := int64(0)
	if value := r.URL.Query().Get("before"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 1 {
			writeError(w, http.StatusBadRequest, "before must be a positive revision")
			return
		}
		before = parsed
	}
	limit := defaultActivityPage
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > maxActivityPage {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("limit must be between 1 and %d", maxActivityPage))
			return
		}
		limit = parsed
	}
	page, err := s.store.activity(query, before, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read activity")
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func boundedActivityDetails(details []string) []string {
	const maxDetails = 18
	if len(details) <= maxDetails {
		return append([]string(nil), details...)
	}
	bounded := append([]string(nil), details[:maxDetails]...)
	return append(bounded, fmt.Sprintf("Additional items: %d", len(details)-maxDetails))
}

func (s *Store) activity(query string, before int64, limit int) (activityPage, error) {
	args := make([]any, 0, 3)
	where := make([]string, 0, 2)
	if before > 0 {
		where = append(where, "revision < ?")
		args = append(args, before)
	}
	if query != "" {
		where = append(where, `search_text LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(strings.ToLower(query))+"%")
	}
	statement := `SELECT revision, action, source, occurred_at, summary, details_json FROM activity`
	if len(where) != 0 {
		statement += " WHERE " + strings.Join(where, " AND ")
	}
	statement += " ORDER BY revision DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.Query(statement, args...)
	if err != nil {
		return activityPage{}, err
	}
	defer rows.Close()
	items := make([]ActivityRecord, 0, limit+1)
	for rows.Next() {
		var item ActivityRecord
		var detailsJSON string
		if err := rows.Scan(&item.Revision, &item.Action, &item.Source, &item.Timestamp, &item.Summary, &detailsJSON); err != nil {
			return activityPage{}, err
		}
		if err := json.Unmarshal([]byte(detailsJSON), &item.Details); err != nil {
			return activityPage{}, fmt.Errorf("decode activity details: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return activityPage{}, err
	}
	page := activityPage{Activities: items}
	if len(items) > limit {
		page.Activities = items[:limit]
		cursor := items[limit-1].Revision
		page.NextBefore = &cursor
	}
	return page, nil
}

func insertActivity(tx *sql.Tx, activity *ActivityRecord, historyLimit int) error {
	if activity == nil {
		return nil
	}
	details, err := json.Marshal(activity.Details)
	if err != nil {
		return err
	}
	searchParts := []string{activity.Action, activity.Source, activity.Summary}
	searchParts = append(searchParts, activity.Details...)
	if _, err := tx.Exec(`INSERT INTO activity
        (revision, action, source, occurred_at, summary, details_json, search_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, activity.Revision, activity.Action, activity.Source,
		activity.Timestamp, activity.Summary, string(details), strings.ToLower(strings.Join(searchParts, "\n"))); err != nil {
		return err
	}
	_, err = tx.Exec(`DELETE FROM activity WHERE revision NOT IN
        (SELECT revision FROM activity ORDER BY revision DESC LIMIT ?)`, historyLimit)
	return err
}

func (s *Store) pruneActivity() error {
	_, err := s.db.Exec(`DELETE FROM activity WHERE revision NOT IN
        (SELECT revision FROM activity ORDER BY revision DESC LIMIT ?)`, s.historyLimit)
	return err
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}
