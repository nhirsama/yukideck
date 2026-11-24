package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestWebUIHandlerDualMode(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":        &fstest.MapFile{Data: []byte("<html><body>YukiDeck</body></html>")},
		"assets/app-123.js": &fstest.MapFile{Data: []byte("console.log('ok');")},
	}

	// 1. Embedded mode enabled
	h := NewHandler(fsys, true)

	// Static asset gets immutable cache header
	recAsset := httptest.NewRecorder()
	h.ServeHTTP(recAsset, httptest.NewRequest(http.MethodGet, "/assets/app-123.js", nil))
	if recAsset.Code != http.StatusOK {
		t.Fatalf("expected 200 for static asset, got %d", recAsset.Code)
	}
	if !strings.Contains(recAsset.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("expected immutable cache control, got %q", recAsset.Header().Get("Cache-Control"))
	}

	// Client route falls back to index.html with no-cache
	recSPA := httptest.NewRecorder()
	h.ServeHTTP(recSPA, httptest.NewRequest(http.MethodGet, "/messenger/push-urls", nil))
	if recSPA.Code != http.StatusOK || !strings.Contains(recSPA.Body.String(), "YukiDeck") {
		t.Fatalf("expected SPA fallback HTML, got %d %q", recSPA.Code, recSPA.Body.String())
	}
	if recSPA.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("expected no-cache for index.html, got %q", recSPA.Header().Get("Cache-Control"))
	}

	// /api/* must NEVER fall back to HTML
	recAPI := httptest.NewRecorder()
	h.ServeHTTP(recAPI, httptest.NewRequest(http.MethodGet, "/api/v1/unknown", nil))
	if recAPI.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for /api/* path, got %d", recAPI.Code)
	}

	// 2. Separated deployment mode (UI_ENABLED=false)
	hDisabled := NewHandler(fsys, false)
	recOff := httptest.NewRecorder()
	hDisabled.ServeHTTP(recOff, httptest.NewRequest(http.MethodGet, "/", nil))
	if recOff.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when UI is disabled, got %d", recOff.Code)
	}
}
