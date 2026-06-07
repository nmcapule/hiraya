package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	srv, err := New(Config{Root: root, Shell: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	return srv, root
}

func TestFileCRUD(t *testing.T) {
	srv, _ := newTestServer(t)
	handler := srv.Routes()

	body := bytes.NewBufferString(`{"path":"/notes.txt","content":"hello"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/file", body)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/file?path=/notes.txt", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("read status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var read struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&read); err != nil {
		t.Fatal(err)
	}
	if read.Content != "hello" {
		t.Fatalf("content = %q", read.Content)
	}

	body = bytes.NewBufferString(`{"content":"updated"}`)
	req = httptest.NewRequest(http.MethodPut, "/api/file?path=/notes.txt", body)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("write status = %d, body = %s", rr.Code, rr.Body.String())
	}

	body = bytes.NewBufferString(`{"from":"/notes.txt","to":"/renamed.txt"}`)
	req = httptest.NewRequest(http.MethodPatch, "/api/path", body)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("rename status = %d, body = %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/path?path=/renamed.txt", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func TestTree(t *testing.T) {
	srv, root := newTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/tree?path=/", nil)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("tree status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		Entries []entry `json:"entries"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Entries) != 2 || got.Entries[0].Type != "dir" || got.Entries[0].Name != "src" {
		t.Fatalf("unexpected entries: %+v", got.Entries)
	}
}

func TestGetRoot(t *testing.T) {
	srv, root := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/root", nil)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("root status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		Root string `json:"root"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Root != root {
		t.Fatalf("root = %q, want %q", got.Root, root)
	}
}

func TestSetRootChangesFileAPI(t *testing.T) {
	srv, oldRoot := newTestServer(t)
	newRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(oldRoot, "old.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newRoot, "new.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	body := bytes.NewBufferString(`{"root":` + strconv.Quote(newRoot) + `}`)
	req := httptest.NewRequest(http.MethodPut, "/api/root", body)
	rr := httptest.NewRecorder()
	handler := srv.Routes()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("set root status = %d, body = %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/file?path=/new.txt", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("read new root status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var read struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&read); err != nil {
		t.Fatal(err)
	}
	if read.Content != "new" {
		t.Fatalf("content = %q", read.Content)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/file?path=/old.txt", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("old root read status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if got := srv.rootSnapshot(); got != newRoot {
		t.Fatalf("terminal root snapshot = %q, want %q", got, newRoot)
	}
}

func TestSetRootRejectsInvalidRoots(t *testing.T) {
	srv, root := newTestServer(t)
	filePath := filepath.Join(root, "file.txt")
	if err := os.WriteFile(filePath, []byte("file"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []string{
		`{"root":""}`,
		`{"root":"relative/path"}`,
		`{"root":"/path/that/does/not/exist"}`,
		`{"root":` + strconv.Quote(filePath) + `}`,
	}
	for _, body := range cases {
		req := httptest.NewRequest(http.MethodPut, "/api/root", bytes.NewBufferString(body))
		rr := httptest.NewRecorder()
		srv.Routes().ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("body %s status = %d, response = %s", body, rr.Code, rr.Body.String())
		}
	}
	if got := srv.rootSnapshot(); got != root {
		t.Fatalf("root changed after invalid request: %q, want %q", got, root)
	}
}

func TestRawFilePreview(t *testing.T) {
	srv, root := newTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "image.png"), []byte{0x89, 'P', 'N', 'G'}, 0o644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/raw?path=/image.png", nil)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("raw status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content type = %q", got)
	}
}

func TestRawFilePreviewRejectsUnsupportedType(t *testing.T) {
	srv, root := newTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "archive.bin"), []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/raw?path=/archive.bin", nil)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func TestStaticPWAAssets(t *testing.T) {
	srv, _ := newTestServer(t)
	handler := srv.Routes()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("index status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if !bytes.Contains(rr.Body.Bytes(), []byte(`rel="manifest"`)) {
		t.Fatal("index does not link the web app manifest")
	}

	req = httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("manifest status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); got != "application/manifest+json" {
		t.Fatalf("manifest content type = %q", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/sw.js", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("service worker status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func TestRawFilePreviewRejectsDirectory(t *testing.T) {
	srv, root := newTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/raw?path=/src", nil)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func TestRejectsTraversal(t *testing.T) {
	srv, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/file?path=/../../etc/passwd", nil)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound && rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func TestRejectsSymlinkEscape(t *testing.T) {
	srv, root := newTestServer(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/file?path=/link.txt", nil)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func TestRawFilePreviewRejectsSymlinkEscape(t *testing.T) {
	srv, root := newTestServer(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.png"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.png"), filepath.Join(root, "link.png")); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/raw?path=/link.png", nil)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func TestReplacePreviewDoesNotModifyFiles(t *testing.T) {
	srv, root := newTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "src", "notes.txt")
	if err := os.WriteFile(target, []byte("hello hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	body := bytes.NewBufferString(`{"path":"/src","search":"hello","replace":"hi","previewOnly":true}`)
	req := httptest.NewRequest(http.MethodPost, "/api/replace", body)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("replace status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got replaceResponse
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.FilesScanned != 1 || got.FilesMatched != 1 || got.Replacements != 2 {
		t.Fatalf("unexpected response: %+v", got)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello hello" {
		t.Fatalf("file was modified during preview: %q", data)
	}
}

func TestReplaceAppliesRecursivelyInRequestedDirectory(t *testing.T) {
	srv, root := newTestServer(t)
	if err := os.MkdirAll(filepath.Join(root, "src", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "a.txt"), []byte("foo Foo foobar"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "nested", "b.txt"), []byte("foo"), 0o644); err != nil {
		t.Fatal(err)
	}

	body := bytes.NewBufferString(`{"path":"/src","search":"foo","replace":"bar","wholeWord":true}`)
	req := httptest.NewRequest(http.MethodPost, "/api/replace", body)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("replace status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got replaceResponse
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.FilesScanned != 2 || got.FilesMatched != 2 || got.Replacements != 3 {
		t.Fatalf("unexpected response: %+v", got)
	}
	assertFileContent(t, filepath.Join(root, "src", "a.txt"), "bar bar foobar")
	assertFileContent(t, filepath.Join(root, "src", "nested", "b.txt"), "bar")
}

func TestReplaceDoesNotAffectSiblingDirectories(t *testing.T) {
	srv, root := newTestServer(t)
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "other"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "a.txt"), []byte("needle"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "other", "b.txt"), []byte("needle"), 0o644); err != nil {
		t.Fatal(err)
	}

	body := bytes.NewBufferString(`{"path":"/src","search":"needle","replace":"thread"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/replace", body)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("replace status = %d, body = %s", rr.Code, rr.Body.String())
	}
	assertFileContent(t, filepath.Join(root, "src", "a.txt"), "thread")
	assertFileContent(t, filepath.Join(root, "other", "b.txt"), "needle")
}

func TestReplaceSkipsBinaryAndOversizedFiles(t *testing.T) {
	srv, root := newTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "text.txt"), []byte("same same"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "binary.bin"), []byte{'s', 'a', 'm', 'e', 0}, 0o644); err != nil {
		t.Fatal(err)
	}
	large := bytes.Repeat([]byte("same"), maxEditableBytes/4+1)
	if err := os.WriteFile(filepath.Join(root, "large.txt"), large, 0o644); err != nil {
		t.Fatal(err)
	}

	body := bytes.NewBufferString(`{"path":"/","search":"same","replace":"diff"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/replace", body)
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("replace status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got replaceResponse
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.FilesScanned != 1 || got.FilesMatched != 1 || got.Replacements != 2 {
		t.Fatalf("unexpected response: %+v", got)
	}
	assertFileContent(t, filepath.Join(root, "text.txt"), "diff diff")
	assertFileContent(t, filepath.Join(root, "binary.bin"), "same\x00")
}

func TestReplaceRejectsInvalidRequests(t *testing.T) {
	srv, _ := newTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/replace", bytes.NewBufferString(`{"path":"/","search":""}`))
	rr := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("empty search status = %d, body = %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/replace", bytes.NewBufferString(`{"path":"/../../etc","search":"x"}`))
	rr = httptest.NewRecorder()
	srv.Routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound && rr.Code != http.StatusBadRequest {
		t.Fatalf("traversal status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func assertFileContent(t *testing.T, path string, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Fatalf("%s = %q, want %q", path, data, want)
	}
}
