package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDecodeJSONSizeGuardrail(t *testing.T) {
	body := append(append([]byte(`{"data":"`), bytes.Repeat([]byte("a"), 200)...), []byte(`"}`)...)
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.ContentLength = -1 // simulate chunked streaming body to test MaxBytesReader path
	rec := httptest.NewRecorder()

	var dst map[string]any
	err := DecodeJSON(rec, req, 64, &dst)
	if err == nil {
		t.Fatalf("expected payload too large error")
	}
	appErr, ok := err.(*AppError)
	if !ok || appErr.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 AppError, got %#v", err)
	}
}

func TestCORSMiddleware(t *testing.T) {
	mw := CORSMiddleware([]string{"https://deck.example.com"})
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		JSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	// Allowed origin preflight
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/meta", nil)
	req.Header.Set("Origin", "https://deck.example.com")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://deck.example.com" {
		t.Fatalf("unexpected ACAO header: %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("expected credentials=true, got %q", got)
	}

	// Disallowed origin must not receive ACAO
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/meta", nil)
	req2.Header.Set("Origin", "https://evil.example.com")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if got := rec2.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected empty ACAO for disallowed origin, got %q", got)
	}

	var out map[string]bool
	if err := json.Unmarshal(rec2.Body.Bytes(), &out); err != nil || !out["ok"] {
		t.Fatalf("expected valid JSON response, got %q", rec2.Body.String())
	}
}
