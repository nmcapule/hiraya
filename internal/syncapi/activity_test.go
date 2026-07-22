package syncapi

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestActivityAPIRecordsSearchesAndPaginatesMutations(t *testing.T) {
	dir := t.TempDir()
	store, server := newTestServer(t, dir)
	if response := bootstrapRequest(t, server, testBootstrap(), nil); response.Code != http.StatusCreated {
		t.Fatalf("bootstrap = %d: %s", response.Code, response.Body.String())
	}
	for _, settings := range []EditorSettings{
		{AutoSave: false, FontSize: 14, Language: "markdown"},
		{AutoSave: true, FontSize: 16, Language: "typescript"},
	} {
		if response := jsonRequest(t, server, http.MethodPut, "/api/editor-settings", settings); response.Code != http.StatusOK {
			t.Fatalf("settings = %d: %s", response.Code, response.Body.String())
		}
	}

	page := getActivityPage(t, server, "/api/activity?limit=2")
	if len(page.Activities) != 2 || page.Activities[0].Revision != 3 || page.Activities[1].Revision != 2 || page.NextBefore == nil || *page.NextBefore != 2 {
		t.Fatalf("first page = %+v", page)
	}
	next := getActivityPage(t, server, "/api/activity?limit=2&before=2")
	if len(next.Activities) != 1 || next.Activities[0].Action != "bootstrap" || next.NextBefore != nil {
		t.Fatalf("next page = %+v", next)
	}
	search := getActivityPage(t, server, "/api/activity?q=TypeScript")
	if len(search.Activities) != 1 || search.Activities[0].Revision != 3 || !strings.Contains(strings.Join(search.Activities[0].Details, " "), "typescript") {
		t.Fatalf("detail search = %+v", search)
	}
	if got := getActivityPage(t, server, "/api/activity?q=api"); len(got.Activities) != 3 {
		t.Fatalf("source search = %+v", got)
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if page, err := reopened.activity("", 0, 10); err != nil || len(page.Activities) != 3 {
		t.Fatalf("persisted activity = %+v, %v", page, err)
	}
}

func TestActivityIdempotentReplayDoesNotDuplicate(t *testing.T) {
	_, server := newTestServer(t, t.TempDir())
	if response := bootstrapRequest(t, server, testBootstrap(), nil); response.Code != http.StatusCreated {
		t.Fatalf("bootstrap = %d", response.Code)
	}
	settings := EditorSettings{AutoSave: false, FontSize: 17, Language: "json"}
	body, _ := json.Marshal(settings)
	first := idempotentRequest(server, http.MethodPut, "/api/editor-settings", "application/json", body, "client", "settings-1")
	replay := idempotentRequest(server, http.MethodPut, "/api/editor-settings", "application/json", body, "client", "settings-1")
	if first.Code != http.StatusOK || replay.Code != http.StatusOK || replay.Header().Get(replayHeader) != "true" {
		t.Fatalf("idempotent responses = %d, %d (%q)", first.Code, replay.Code, replay.Header().Get(replayHeader))
	}
	page := getActivityPage(t, server, "/api/activity")
	if len(page.Activities) != 2 || page.Activities[0].Revision != 2 {
		t.Fatalf("activity after replay = %+v", page)
	}
}

func TestActivityRetentionPrunesAfterInsertAndStartup(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	for revision := int64(1); revision <= 5; revision++ {
		next := cloneWorkspace(store.workspace)
		next.Revision = revision
		store.mu.Lock()
		err = store.persistLocked(next, newActivity(revision, "test", "api", "Revision", time.UnixMilli(revision), "retained detail"))
		store.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
	}
	if page, err := store.activity("", 0, 10); err != nil || len(page.Activities) != 3 || page.Activities[2].Revision != 3 {
		t.Fatalf("insertion retention = %+v, %v", page, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if page, err := reopened.activity("", 0, 10); err != nil || len(page.Activities) != 2 || page.Activities[1].Revision != 4 {
		t.Fatalf("startup retention = %+v, %v", page, err)
	}
}

func TestActivityStateReceiptAndRecordRollBackTogether(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	next := cloneWorkspace(store.workspace)
	next.Revision = 1
	next.Entries = []Entry{
		{Kind: "folder", ID: "duplicate", Name: "One", Revision: 1},
		{Kind: "folder", ID: "duplicate", Name: "Two", Revision: 1},
	}
	receipt := &mutationReceipt{ClientID: "client", OperationID: "operation", Endpoint: "POST /api/entries", RequestHash: sha256.Sum256([]byte("request")), Status: http.StatusOK, ResponseBody: []byte("{}\n"), Revision: 1}
	store.mu.Lock()
	err = store.persistMutationLocked(next, receipt, newActivity(1, "create", "api", "Created folder", time.Now()))
	store.mu.Unlock()
	if err == nil {
		t.Fatal("invalid workspace unexpectedly committed")
	}
	var activities, receipts int
	if err := store.db.QueryRow(`SELECT count(*) FROM activity`).Scan(&activities); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT count(*) FROM mutation_receipts`).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if store.snapshot().Revision != 0 || activities != 0 || receipts != 0 {
		t.Fatalf("partial transaction: revision=%d activity=%d receipts=%d", store.snapshot().Revision, activities, receipts)
	}
}

func TestActivityAPIRejectsUnboundedParameters(t *testing.T) {
	_, server := newTestServer(t, t.TempDir())
	for _, path := range []string{
		"/api/activity?limit=101",
		"/api/activity?before=0",
		"/api/activity?q=" + strings.Repeat("x", maxActivityQuery+1),
		"/api/activity?q=" + strings.Repeat("😀", maxActivityQuery/2+1),
	} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d", path, response.Code)
		}
	}
}

func TestEntryActivityDistinguishesRenameAndDesktopMove(t *testing.T) {
	old := Entry{Kind: "file", ID: "entry", Name: "before.txt", Position: Position{X: 1, Y: 2}}
	renamed := old
	renamed.Name = "after.txt"
	action, summary, details := entryChangeSummary(map[string]Entry{old.ID: old}, map[string]Entry{renamed.ID: renamed}, []Entry{renamed})
	if action != "rename" || !strings.Contains(summary, old.Name) || !strings.Contains(strings.Join(details, " "), old.Name) {
		t.Fatalf("rename activity = %q, %q, %v", action, summary, details)
	}
	moved := old
	moved.Position.X++
	action, summary, _ = entryChangeSummary(map[string]Entry{old.ID: old}, map[string]Entry{moved.ID: moved}, []Entry{moved})
	if action != "positions" || !strings.Contains(summary, old.Name) {
		t.Fatalf("position activity = %q, %q", action, summary)
	}
}

func TestActivityBoundsBatchDetails(t *testing.T) {
	details := make([]string, 25)
	for index := range details {
		details[index] = fmt.Sprintf("Item %d", index)
	}
	record := newActivity(1, "import", "api", "Imported items", time.Now(), details...)
	if len(record.Details) != 19 || record.Details[18] != "Additional items: 7" {
		t.Fatalf("bounded details = %v", record.Details)
	}
}

func getActivityPage(t *testing.T, handler http.Handler, path string) activityPage {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", path, response.Code, response.Body.String())
	}
	var page activityPage
	decodeResponse(t, response, &page)
	return page
}
