package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
