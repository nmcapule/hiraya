package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"hiraya/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	root := flag.String("root", ".", "workspace root")
	shell := flag.String("shell", "", "terminal shell path")
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

	app, err := server.New(server.Config{
		Root:  absRoot,
		Shell: shellPath,
	})
	if err != nil {
		log.Fatalf("configure server: %v", err)
	}

	log.Printf("hiraya listening on %s, root %s", *addr, absRoot)
	if err := http.ListenAndServe(*addr, app.Routes()); err != nil {
		log.Fatal(err)
	}
}
