package syncapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"mime"
	"net/http"
	"strings"
)

const (
	clientIDHeader       = "X-Hiraya-Client-ID"
	operationIDHeader    = "X-Hiraya-Operation-ID"
	replayHeader         = "X-Hiraya-Idempotent-Replay"
	maxIdempotencyIDSize = 128
	maxReceiptBodySize   = 8 << 20
)

type mutationReceipt struct {
	ClientID     string
	OperationID  string
	Endpoint     string
	RequestHash  [sha256.Size]byte
	Status       int
	ResponseBody []byte
	Revision     int64
}

type idempotencyState struct {
	clientID    string
	operationID string
	endpoint    string
	hash        hash.Hash
	multipart   bool
}

type idempotencyContextKey struct{}

type hashingReadCloser struct {
	io.Reader
	io.Closer
}

type multipartHashReader struct {
	reader    io.Reader
	partHash  hash.Hash
	request   hash.Hash
	name      string
	filename  string
	finalized bool
}

func (s *Server) idempotency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clientID := r.Header.Get(clientIDHeader)
		operationID := r.Header.Get(operationIDHeader)
		if clientID == "" && operationID == "" {
			next.ServeHTTP(w, r)
			return
		}
		if !validIdempotencyID(clientID) || !validIdempotencyID(operationID) {
			writeError(w, http.StatusBadRequest, clientIDHeader+" and "+operationIDHeader+" must both be 1-128 character ASCII identifiers")
			return
		}
		endpoint := r.Method + " " + r.URL.EscapedPath()
		h := sha256.New()
		mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		multipartRequest := strings.HasPrefix(mediaType, "multipart/")
		contentType := r.Header.Get("Content-Type")
		if multipartRequest {
			contentType = mediaType // The boundary is transport framing, not mutation data.
		}
		_, _ = io.WriteString(h, endpoint+"\x00"+contentType+"\x00")
		state := &idempotencyState{clientID: clientID, operationID: operationID, endpoint: endpoint, hash: h, multipart: multipartRequest}
		if !state.multipart {
			r.Body = &hashingReadCloser{Reader: io.TeeReader(r.Body, h), Closer: r.Body}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), idempotencyContextKey{}, state)))
	})
}

func validIdempotencyID(value string) bool {
	if len(value) == 0 || len(value) > maxIdempotencyIDSize {
		return false
	}
	for _, c := range []byte(value) {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune("._:-", rune(c))) {
			return false
		}
	}
	return true
}

func hashMultipartPart(r *http.Request, name, filename string, reader io.Reader) io.Reader {
	state, _ := r.Context().Value(idempotencyContextKey{}).(*idempotencyState)
	if state == nil {
		return reader
	}
	partHash := sha256.New()
	return &multipartHashReader{reader: io.TeeReader(reader, partHash), partHash: partHash, request: state.hash, name: name, filename: filename}
}

func (r *multipartHashReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if err == io.EOF && !r.finalized {
		r.finalized = true
		_, _ = io.WriteString(r.request, "part")
		var size [4]byte
		binary.BigEndian.PutUint32(size[:], uint32(len(r.name)))
		_, _ = r.request.Write(size[:])
		_, _ = io.WriteString(r.request, r.name)
		binary.BigEndian.PutUint32(size[:], uint32(len(r.filename)))
		_, _ = r.request.Write(size[:])
		_, _ = io.WriteString(r.request, r.filename)
		_, _ = r.request.Write(r.partHash.Sum(nil))
	}
	return n, err
}

func idempotencyHash(r *http.Request) ([sha256.Size]byte, *idempotencyState) {
	state, _ := r.Context().Value(idempotencyContextKey{}).(*idempotencyState)
	if state == nil {
		return [sha256.Size]byte{}, nil
	}
	var digest [sha256.Size]byte
	copy(digest[:], state.hash.Sum(nil))
	return digest, state
}

// replayMutationLocked must be called after the complete request body has been consumed.
func (s *Server) replayMutationLocked(w http.ResponseWriter, r *http.Request) bool {
	digest, state := idempotencyHash(r)
	if state == nil {
		return false
	}
	receipt, found, err := s.store.mutationReceipt(state.clientID, state.operationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read mutation receipt")
		return true
	}
	if !found {
		return false
	}
	if receipt.Endpoint != state.endpoint || !bytes.Equal(receipt.RequestHash[:], digest[:]) {
		writeError(w, http.StatusConflict, "idempotency operation ID was already used for a different mutation")
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(replayHeader, "true")
	w.WriteHeader(receipt.Status)
	_, _ = w.Write(receipt.ResponseBody)
	return true
}

func (s *Server) persistMutationLocked(next Workspace, r *http.Request, status int, result any) ([]byte, error) {
	body, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("encode mutation response: %w", err)
	}
	body = append(body, '\n')
	if len(body) > maxReceiptBodySize {
		return nil, fmt.Errorf("mutation response exceeds receipt limit")
	}
	digest, state := idempotencyHash(r)
	activity := activityFromMutation(s.store.workspace, next, r, s.now())
	if state == nil {
		return body, s.store.persistLocked(next, activity)
	}
	receipt := &mutationReceipt{ClientID: state.clientID, OperationID: state.operationID, Endpoint: state.endpoint, RequestHash: digest, Status: status, ResponseBody: body, Revision: next.Revision}
	return body, s.store.persistMutationLocked(next, receipt, activity)
}

func writeJSONBody(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
