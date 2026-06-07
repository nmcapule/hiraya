package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"hiraya/internal/server/static"
)

const maxEditableBytes = 2 << 20

func init() {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

type Config struct {
	Root  string
	Shell string
}

type Server struct {
	mu    sync.RWMutex
	root  string
	shell string
}

func New(cfg Config) (*Server, error) {
	if cfg.Shell == "" {
		return nil, errors.New("shell is required")
	}
	root, err := normalizeConfigRoot(cfg.Root)
	if err != nil {
		return nil, err
	}
	return &Server{root: root, shell: cfg.Shell}, nil
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/root", s.handleGetRoot)
	mux.HandleFunc("PUT /api/root", s.handleSetRoot)
	mux.HandleFunc("GET /api/tree", s.handleTree)
	mux.HandleFunc("GET /api/file", s.handleReadFile)
	mux.HandleFunc("GET /api/raw", s.handleRawFile)
	mux.HandleFunc("PUT /api/file", s.handleWriteFile)
	mux.HandleFunc("POST /api/file", s.handleCreateFile)
	mux.HandleFunc("POST /api/dir", s.handleCreateDir)
	mux.HandleFunc("PATCH /api/path", s.handleRename)
	mux.HandleFunc("DELETE /api/path", s.handleDelete)
	mux.HandleFunc("POST /api/replace", s.handleReplace)
	mux.HandleFunc("GET /api/terminal", s.handleTerminal)
	mux.HandleFunc("/", s.handleStatic)
	return mux
}

type entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Type  string `json:"type"`
	Size  int64  `json:"size"`
	MTime string `json:"mtime"`
}

type replaceRequest struct {
	Path          string `json:"path"`
	Search        string `json:"search"`
	Replace       string `json:"replace"`
	CaseSensitive bool   `json:"caseSensitive"`
	WholeWord     bool   `json:"wholeWord"`
	PreviewOnly   bool   `json:"previewOnly"`
}

type replaceMatch struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

type replaceResponse struct {
	Path         string         `json:"path"`
	FilesScanned int            `json:"filesScanned"`
	FilesMatched int            `json:"filesMatched"`
	Replacements int            `json:"replacements"`
	Matches      []replaceMatch `json:"matches"`
}

func (s *Server) rootSnapshot() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.root
}

func (s *Server) setRoot(root string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.root = root
}

func (s *Server) handleGetRoot(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"root": s.rootSnapshot()})
}

func (s *Server) handleSetRoot(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Root string `json:"root"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	root, err := normalizeRoot(body.Root)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.setRoot(root)
	writeJSON(w, http.StatusOK, map[string]string{"root": root})
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	root := s.rootSnapshot()
	target, rel, err := resolve(root, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, errors.New("path is not a directory"))
		return
	}
	items, err := os.ReadDir(target)
	if err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	entries := make([]entry, 0, len(items))
	for _, item := range items {
		itemInfo, err := item.Info()
		if err != nil {
			continue
		}
		kind := "file"
		if itemInfo.IsDir() {
			kind = "dir"
		}
		childRel := cleanSlash(path.Join(rel, item.Name()))
		entries = append(entries, entry{
			Name:  item.Name(),
			Path:  childRel,
			Type:  kind,
			Size:  itemInfo.Size(),
			MTime: itemInfo.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == "dir"
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    rel,
		"entries": entries,
	})
}

func (s *Server) handleReadFile(w http.ResponseWriter, r *http.Request) {
	root := s.rootSnapshot()
	target, rel, err := resolve(root, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, errors.New("path is a directory"))
		return
	}
	if info.Size() > maxEditableBytes {
		writeError(w, http.StatusRequestEntityTooLarge, errors.New("file is larger than 2 MiB"))
		return
	}
	data, err := os.ReadFile(target)
	if err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	if !isText(data) {
		writeError(w, http.StatusUnsupportedMediaType, errors.New("file does not appear to be text"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    rel,
		"content": string(data),
		"size":    info.Size(),
		"mtime":   info.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
	})
}

func (s *Server) handleRawFile(w http.ResponseWriter, r *http.Request) {
	root := s.rootSnapshot()
	target, _, err := resolve(root, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, errors.New("path is a directory"))
		return
	}
	contentType, ok := previewContentType(target)
	if !ok {
		writeError(w, http.StatusUnsupportedMediaType, errors.New("file type cannot be previewed"))
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", "inline")
	http.ServeFile(w, r, target)
}

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	root := s.rootSnapshot()
	target, rel, err := resolve(root, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(body.Content) > maxEditableBytes {
		writeError(w, http.StatusRequestEntityTooLarge, errors.New("content is larger than 2 MiB"))
		return
	}
	if err := os.WriteFile(target, []byte(body.Content), 0o644); err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	info, _ := os.Stat(target)
	writeJSON(w, http.StatusOK, map[string]any{"path": rel, "size": info.Size()})
}

func (s *Server) handleCreateFile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	root := s.rootSnapshot()
	target, rel, err := resolve(root, body.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(body.Content) > maxEditableBytes {
		writeError(w, http.StatusRequestEntityTooLarge, errors.New("content is larger than 2 MiB"))
		return
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	defer file.Close()
	if _, err := file.WriteString(body.Content); err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"path": rel})
}

func (s *Server) handleCreateDir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	root := s.rootSnapshot()
	target, rel, err := resolve(root, body.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"path": rel})
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	root := s.rootSnapshot()
	from, _, err := resolve(root, body.From)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	to, rel, err := resolve(root, body.To)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := os.Rename(from, to); err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": rel})
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	root := s.rootSnapshot()
	target, rel, err := resolve(root, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if rel == "/" {
		writeError(w, http.StatusBadRequest, errors.New("cannot delete workspace root"))
		return
	}
	if err := os.Remove(target); err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": rel})
}

func (s *Server) handleReplace(w http.ResponseWriter, r *http.Request) {
	var body replaceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if body.Search == "" {
		writeError(w, http.StatusBadRequest, errors.New("search text is required"))
		return
	}
	root := s.rootSnapshot()
	target, rel, err := resolve(root, body.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, errors.New("path is not a directory"))
		return
	}
	result, err := replaceInTree(root, target, rel, body)
	if err != nil {
		writeError(w, statusForErr(err), err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	staticFS, err := fs.Sub(static.FS, "dist")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if r.URL.Path != "/" {
		if _, err := fs.Stat(staticFS, strings.TrimPrefix(path.Clean(r.URL.Path), "/")); err == nil {
			http.FileServer(http.FS(staticFS)).ServeHTTP(w, r)
			return
		}
	}
	r.URL.Path = "/"
	http.FileServer(http.FS(staticFS)).ServeHTTP(w, r)
}

func replaceInTree(root, walkRoot, rel string, req replaceRequest) (replaceResponse, error) {
	result := replaceResponse{Path: rel, Matches: []replaceMatch{}}
	err := filepath.WalkDir(walkRoot, func(filePath string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if item.Type()&os.ModeSymlink != 0 {
			if item.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if item.IsDir() {
			return nil
		}
		info, err := item.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxEditableBytes {
			return nil
		}
		if err := ensureInside(root, filePath); err != nil {
			return nil
		}
		data, err := os.ReadFile(filePath)
		if err != nil || !isText(data) {
			return nil
		}
		result.FilesScanned++
		content := string(data)
		next, count := replaceLiteral(content, req.Search, req.Replace, req.CaseSensitive, req.WholeWord)
		if count == 0 {
			return nil
		}
		matchPath := slashPath(root, filePath)
		result.FilesMatched++
		result.Replacements += count
		result.Matches = append(result.Matches, replaceMatch{Path: matchPath, Count: count})
		if req.PreviewOnly {
			return nil
		}
		if len(next) > maxEditableBytes {
			return fmt.Errorf("replacement would make %s larger than 2 MiB", matchPath)
		}
		return os.WriteFile(filePath, []byte(next), info.Mode().Perm())
	})
	return result, err
}

func slashPath(root, filePath string) string {
	rel, err := filepath.Rel(root, filePath)
	if err != nil || rel == "." {
		return "/"
	}
	return cleanSlash(filepath.ToSlash(rel))
}

func resolve(root, input string) (string, string, error) {
	if strings.TrimSpace(input) == "" {
		input = "/"
	}
	slashPath := cleanSlash(input)
	if slashPath == "/" {
		return root, "/", nil
	}
	rel := strings.TrimPrefix(slashPath, "/")
	candidate := filepath.Join(root, filepath.FromSlash(rel))
	resolvedParent := candidate
	if _, err := os.Lstat(candidate); err != nil {
		resolvedParent = filepath.Dir(candidate)
	}
	evaluatedParent, err := filepath.EvalSymlinks(resolvedParent)
	if err != nil {
		if os.IsNotExist(err) {
			evaluatedParent = resolvedParent
		} else {
			return "", "", err
		}
	}
	if err := ensureInside(root, evaluatedParent); err != nil {
		return "", "", err
	}
	if info, err := os.Lstat(candidate); err == nil && info.Mode()&os.ModeSymlink != 0 {
		target, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			return "", "", err
		}
		if err := ensureInside(root, target); err != nil {
			return "", "", err
		}
		candidate = target
	}
	if err := ensureInside(root, candidate); err != nil {
		return "", "", err
	}
	return candidate, slashPath, nil
}

func ensureInside(root, target string) error {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return err
	}
	if rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..") {
		return nil
	}
	return fmt.Errorf("path escapes workspace root")
}

func normalizeRoot(input string) (string, error) {
	if strings.TrimSpace(input) == "" {
		return "", errors.New("root is required")
	}
	if !filepath.IsAbs(input) {
		return "", errors.New("root must be an absolute path")
	}
	root, err := filepath.EvalSymlinks(input)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("root is not a directory: %s", root)
	}
	return root, nil
}

func normalizeConfigRoot(input string) (string, error) {
	if strings.TrimSpace(input) == "" {
		return "", errors.New("root is required")
	}
	root, err := filepath.Abs(input)
	if err != nil {
		return "", err
	}
	return normalizeRoot(root)
}

func cleanSlash(input string) string {
	cleaned := path.Clean("/" + strings.TrimPrefix(input, "/"))
	if cleaned == "." {
		return "/"
	}
	return cleaned
}

func isText(data []byte) bool {
	for _, b := range data {
		if b == 0 {
			return false
		}
	}
	return true
}

func replaceLiteral(content, search, replacement string, caseSensitive, wholeWord bool) (string, int) {
	if search == "" {
		return content, 0
	}
	var out strings.Builder
	pos := 0
	count := 0
	for {
		index := findLiteralAt(content, search, pos, caseSensitive, wholeWord)
		if index < 0 {
			break
		}
		out.WriteString(content[pos:index])
		out.WriteString(replacement)
		pos = index + len(search)
		count++
	}
	if count == 0 {
		return content, 0
	}
	out.WriteString(content[pos:])
	return out.String(), count
}

func findLiteralAt(content, search string, start int, caseSensitive, wholeWord bool) int {
	if start > len(content) {
		return -1
	}
	haystack := content[start:]
	needle := search
	if !caseSensitive {
		haystack = strings.ToLower(haystack)
		needle = strings.ToLower(search)
	}
	offset := 0
	for {
		index := strings.Index(haystack[offset:], needle)
		if index < 0 {
			return -1
		}
		index += start + offset
		if !wholeWord || isWholeWordMatch(content, index, index+len(search)) {
			return index
		}
		offset = index - start + len(search)
	}
}

func isWholeWordMatch(content string, from, to int) bool {
	return !wordCharBefore(content, from) && !wordCharAfter(content, to)
}

func wordCharBefore(content string, index int) bool {
	if index <= 0 {
		return false
	}
	r, _ := utf8.DecodeLastRuneInString(content[:index])
	return isSearchWordChar(r)
}

func wordCharAfter(content string, index int) bool {
	if index >= len(content) {
		return false
	}
	r, _ := utf8.DecodeRuneInString(content[index:])
	return isSearchWordChar(r)
}

func isSearchWordChar(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r)
}

func previewContentType(filePath string) (string, bool) {
	ext := strings.ToLower(filepath.Ext(filePath))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".pdf":
		contentType := mime.TypeByExtension(ext)
		if contentType == "" {
			switch ext {
			case ".svg":
				contentType = "image/svg+xml"
			case ".ico":
				contentType = "image/x-icon"
			case ".pdf":
				contentType = "application/pdf"
			default:
				contentType = "application/octet-stream"
			}
		}
		return contentType, true
	default:
		return "", false
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func statusForErr(err error) int {
	if os.IsNotExist(err) {
		return http.StatusNotFound
	}
	if os.IsPermission(err) {
		return http.StatusForbidden
	}
	if os.IsExist(err) {
		return http.StatusConflict
	}
	return http.StatusInternalServerError
}
