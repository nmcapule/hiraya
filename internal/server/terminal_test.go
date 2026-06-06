package server

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestStartPTYRunsShell(t *testing.T) {
	ptmx, cmd, err := startPTY("/bin/sh", t.TempDir(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	done := make(chan []byte, 1)
	go func() {
		var output bytes.Buffer
		buf := make([]byte, 256)
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			_ = ptmx.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
			n, err := ptmx.Read(buf)
			if n > 0 {
				output.Write(buf[:n])
				if strings.Contains(output.String(), "hiraya-pty-ok") {
					break
				}
			}
			if err != nil && !errors.Is(err, os.ErrDeadlineExceeded) && !errors.Is(err, io.EOF) {
				break
			}
		}
		done <- output.Bytes()
	}()

	if _, err := ptmx.Write([]byte("printf 'hiraya-pty-ok\\n'; exit\n")); err != nil {
		t.Fatal(err)
	}
	output := <-done
	if !strings.Contains(string(output), "hiraya-pty-ok") {
		t.Fatalf("shell output did not contain marker: %q", output)
	}
}
