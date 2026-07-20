package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"hiraya/internal/syncapi"
)

const defaultMaxUpload = int64(100 << 20)

func main() {
	dataDir := env("HIRAYA_DATA_DIR", ".hiraya-data")
	addr := env("HIRAYA_ADDR", "127.0.0.1:8080")
	staticDir := env("HIRAYA_STATIC_DIR", "dist")
	maxUpload := defaultMaxUpload
	if value := os.Getenv("HIRAYA_MAX_UPLOAD_BYTES"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 1 {
			log.Fatalf("invalid HIRAYA_MAX_UPLOAD_BYTES %q", value)
		}
		maxUpload = parsed
	}
	store, err := syncapi.OpenStore(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           syncapi.New(store, staticDir, maxUpload),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("Hiraya server listening on http://%s", addr)
	serveErr := server.ListenAndServe()
	if err := store.Close(); err != nil {
		log.Printf("close store: %v", err)
	}
	if serveErr != nil && serveErr != http.ErrServerClosed {
		log.Fatal(serveErr)
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
