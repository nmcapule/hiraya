package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/nmcapule/hiraya/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	root := flag.String("root", ".", "workspace root")
	shell := flag.String("shell", "", "terminal shell path")
	terminalMode := flag.String("terminal-mode", server.TerminalModeShell, "terminal startup mode: shell or byobu")
	flag.Parse()

	absRoot, err := filepath.Abs(*root)
	if err != nil {
		log.Fatalf("resolve root: %v", err)
	}
	if info, err := os.Stat(absRoot); err != nil {
		log.Fatalf("stat root: %v", err)
	} else if !info.IsDir() {
		log.Fatalf("root is not a directory: %s", absRoot)
	}

	shellPath := *shell
	if shellPath == "" {
		shellPath = os.Getenv("SHELL")
	}
	if shellPath == "" {
		shellPath = "/bin/sh"
	}

	var byobuPath string
	switch *terminalMode {
	case server.TerminalModeShell:
	case server.TerminalModeByobu:
		byobuPath, err = exec.LookPath("byobu")
		if err != nil {
			log.Fatalf("terminal mode byobu requires byobu in PATH: %v", err)
		}
	default:
		log.Fatalf("invalid terminal mode %q; expected %q or %q", *terminalMode, server.TerminalModeShell, server.TerminalModeByobu)
	}

	app, err := server.New(server.Config{
		Root:         absRoot,
		Shell:        shellPath,
		TerminalMode: *terminalMode,
		ByobuPath:    byobuPath,
	})
	if err != nil {
		log.Fatalf("configure server: %v", err)
	}

	log.Printf("hiraya listening on %s, root %s", *addr, absRoot)
	if err := http.ListenAndServe(*addr, app.Routes()); err != nil {
		log.Fatal(err)
	}
}
