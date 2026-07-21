package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"hiraya/internal/syncapi"
)

const defaultMaxUpload = int64(100 << 20)

func main() {
	dataDir := env("HIRAYA_DATA_DIR", ".hiraya-data")
	addr := env("HIRAYA_ADDR", "127.0.0.1:8080")
	staticDir := env("HIRAYA_STATIC_DIR", "dist")
	tlsCertFile := os.Getenv("HIRAYA_TLS_CERT_FILE")
	tlsKeyFile := os.Getenv("HIRAYA_TLS_KEY_FILE")
	if (tlsCertFile == "") != (tlsKeyFile == "") {
		log.Fatal("HIRAYA_TLS_CERT_FILE and HIRAYA_TLS_KEY_FILE must be set together")
	}
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
	scheme := "http"
	if tlsCertFile != "" {
		scheme = "https"
	}
	log.Printf("Hiraya server listening on %s://%s", scheme, addr)
	serveErrors := make(chan error, 1)
	go func() {
		if tlsCertFile != "" {
			serveErrors <- server.ListenAndServeTLS(tlsCertFile, tlsKeyFile)
			return
		}
		serveErrors <- server.ListenAndServe()
	}()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var serveErr error
	select {
	case serveErr = <-serveErrors:
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown: %v", err)
		}
		cancel()
		serveErr = <-serveErrors
	}
	if err := store.Close(); err != nil {
		log.Printf("close store: %v", err)
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		log.Fatal(serveErr)
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
