package server

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	tiocgptn      = 0x80045430
	tiocsptlck    = 0x40045431
	tiocswinsz    = 0x5414
)

type termMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

type wsConn struct {
	conn net.Conn
	rw   *bufio.ReadWriter
	mu   sync.Mutex
}

type winsize struct {
	Rows uint16
	Cols uint16
	X    uint16
	Y    uint16
}

func (s *Server) handleTerminal(w http.ResponseWriter, r *http.Request) {
	ws, err := upgradeWebSocket(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	defer ws.Close()

	ptmx, cmd, err := startPTY(s.shell, s.root, 80, 24)
	if err != nil {
		_ = ws.WriteJSON(termMessage{Type: "error", Data: err.Error()})
		return
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				if writeErr := ws.WriteJSON(termMessage{Type: "output", Data: string(buf[:n])}); writeErr != nil {
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					_ = ws.WriteJSON(termMessage{Type: "error", Data: err.Error()})
				}
				return
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		default:
		}
		payload, err := ws.ReadText()
		if err != nil {
			return
		}
		var msg termMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "input":
			_, _ = ptmx.Write([]byte(msg.Data))
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				_ = setWinsize(ptmx, msg.Cols, msg.Rows)
			}
		}
	}
}

func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errors.New("missing websocket upgrade")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("missing websocket key")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("response writer cannot hijack")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	hash := sha1.Sum([]byte(key + websocketGUID))
	accept := base64.StdEncoding.EncodeToString(hash[:])
	_, err = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &wsConn{conn: conn, rw: rw}, nil
}

func (w *wsConn) Close() error {
	return w.conn.Close()
}

func (w *wsConn) WriteJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return w.WriteText(data)
}

func (w *wsConn) WriteText(data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	header := []byte{0x81}
	switch {
	case len(data) < 126:
		header = append(header, byte(len(data)))
	case len(data) <= 65535:
		header = append(header, 126, byte(len(data)>>8), byte(len(data)))
	default:
		header = append(header, 127)
		var size [8]byte
		binary.BigEndian.PutUint64(size[:], uint64(len(data)))
		header = append(header, size[:]...)
	}
	if _, err := w.conn.Write(header); err != nil {
		return err
	}
	_, err := w.conn.Write(data)
	return err
}

func (w *wsConn) ReadText() ([]byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(w.rw, header[:]); err != nil {
		return nil, err
	}
	opcode := header[0] & 0x0f
	if opcode == 0x8 {
		return nil, io.EOF
	}
	if opcode != 0x1 {
		return nil, errors.New("unsupported websocket frame")
	}
	masked := header[1]&0x80 != 0
	size := uint64(header[1] & 0x7f)
	switch size {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(w.rw, b[:]); err != nil {
			return nil, err
		}
		size = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(w.rw, b[:]); err != nil {
			return nil, err
		}
		size = binary.BigEndian.Uint64(b[:])
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(w.rw, mask[:]); err != nil {
			return nil, err
		}
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(w.rw, payload); err != nil {
		return nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return payload, nil
}

func startPTY(shellPath, dir string, cols, rows uint16) (*os.File, *exec.Cmd, error) {
	ptmx, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	unlock := int32(0)
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, ptmx.Fd(), tiocsptlck, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		_ = ptmx.Close()
		return nil, nil, errno
	}
	var ptyNum uint32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, ptmx.Fd(), tiocgptn, uintptr(unsafe.Pointer(&ptyNum))); errno != 0 {
		_ = ptmx.Close()
		return nil, nil, errno
	}
	slave, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", ptyNum), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	defer slave.Close()

	cmd := exec.Command(shellPath)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
		Ctty:    0,
	}
	if err := setWinsize(ptmx, cols, rows); err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	return ptmx, cmd, nil
}

func setWinsize(file *os.File, cols, rows uint16) error {
	ws := winsize{Rows: rows, Cols: cols}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), tiocswinsz, uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		return errno
	}
	return nil
}
