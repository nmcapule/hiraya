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
	ptmx, cmd, err := startPTY(terminalCommand{
		Path: "/bin/sh",
		Env:  []string{"TERM=xterm-256color"},
	}, t.TempDir(), 80, 24)
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

func TestBuildTerminalCommandDefaultsToShell(t *testing.T) {
	command, err := buildTerminalCommand(Config{Shell: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	if command.Path != "/bin/sh" {
		t.Fatalf("path = %q, want /bin/sh", command.Path)
	}
	if len(command.Args) != 0 {
		t.Fatalf("args = %q, want none", command.Args)
	}
	if !containsEnv(command.Env, "TERM=xterm-256color") {
		t.Fatalf("env = %q, want TERM=xterm-256color", command.Env)
	}
	if containsEnvPrefix(command.Env, "SHELL=") {
		t.Fatalf("env = %q, did not expect SHELL override in shell mode", command.Env)
	}
}

func TestBuildTerminalCommandSelectsByobu(t *testing.T) {
	command, err := buildTerminalCommand(Config{
		Shell:        "/usr/bin/zsh",
		TerminalMode: TerminalModeByobu,
		ByobuPath:    "/usr/bin/byobu",
	})
	if err != nil {
		t.Fatal(err)
	}
	if command.Path != "/usr/bin/byobu" {
		t.Fatalf("path = %q, want /usr/bin/byobu", command.Path)
	}
	if len(command.Args) != 0 {
		t.Fatalf("args = %q, want none", command.Args)
	}
	if !containsEnv(command.Env, "TERM=xterm-256color") {
		t.Fatalf("env = %q, want TERM=xterm-256color", command.Env)
	}
	if !containsEnv(command.Env, "SHELL=/usr/bin/zsh") {
		t.Fatalf("env = %q, want SHELL=/usr/bin/zsh", command.Env)
	}
}

func TestBuildTerminalCommandRejectsInvalidMode(t *testing.T) {
	if _, err := buildTerminalCommand(Config{Shell: "/bin/sh", TerminalMode: "tmux"}); err == nil {
		t.Fatal("expected invalid terminal mode error")
	}
}

func TestBuildTerminalCommandRequiresByobuPath(t *testing.T) {
	if _, err := buildTerminalCommand(Config{Shell: "/bin/sh", TerminalMode: TerminalModeByobu}); err == nil {
		t.Fatal("expected missing byobu path error")
	}
}

func containsEnv(env []string, value string) bool {
	for _, current := range env {
		if current == value {
			return true
		}
	}
	return false
}

func containsEnvPrefix(env []string, prefix string) bool {
	for _, current := range env {
		if strings.HasPrefix(current, prefix) {
			return true
		}
	}
	return false
}
