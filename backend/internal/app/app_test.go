package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/config"
	"yukideck/internal/core/auth"
	"yukideck/internal/core/crypto"
	"yukideck/internal/core/httpx"
	"yukideck/internal/core/messenger"
	"yukideck/internal/core/module"
	"yukideck/internal/core/scheduler"
)

type stubUserStore struct{}

func (stubUserStore) UpsertByOIDCSub(_ context.Context, sub, u, e, a string) (*auth.User, error) {
	return &auth.User{ID: 1, OIDCSub: sub, Username: u, Email: e, AvatarURL: a}, nil
}
func (stubUserStore) FindByID(_ context.Context, id int64) (*auth.User, error) {
	return &auth.User{ID: id, Username: "yuki"}, nil
}

type stubModule struct {
	module.BaseModule
	id string
}

func (m stubModule) Meta() module.Meta {
	return module.Meta{ID: m.id, Name: "Stub " + m.id, Description: "test module"}
}

func (m stubModule) RegisterRoutes(r chi.Router) {
	r.Get("/ping", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"module": m.id})
	})
}

func TestAppRoutingMetaAndDualDeployment(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x33}, 32))
	cfg := &config.Config{
		UIEnabled:           true,
		CORSAllowedOrigins:  []string{"https://deck.example.com"},
		DisabledModules:     []string{"disabled_mod"},
		RequestMaxBodyBytes: 1 << 20,
		ExternalHTTPTimeout: 5 * time.Second,
	}

	authSvc := auth.NewTestService(cfg, box, stubUserStore{}, nil)
	msgSvc := messenger.NewService(nil, messenger.NewRegistry(), messenger.NewCommandBus(), box, "https://deck.example.com", 5*time.Second, nil)
	sched := scheduler.New(5*time.Second, nil)

	fakeUI := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>YukiDeck UI</html>")},
	}

	a := newWithDeps(cfg, nil, nil, authSvc, msgSvc, sched, []module.Module{
		stubModule{id: "demo"},
		stubModule{id: "disabled_mod"},
	}, fakeUI)

	// 1. /healthz returns runtime Version
	recHealth := httptest.NewRecorder()
	a.Handler().ServeHTTP(recHealth, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if recHealth.Code != http.StatusOK {
		t.Fatalf("expected 200 on /healthz, got %d", recHealth.Code)
	}
	var healthResp HealthResponse
	if err := json.Unmarshal(recHealth.Body.Bytes(), &healthResp); err != nil {
		t.Fatalf("decode healthz: %v", err)
	}
	if healthResp.Status != "ok" || healthResp.Version != Version {
		t.Fatalf("unexpected healthz payload: %+v (want version %q)", healthResp, Version)
	}

	// 2. /api/v1/meta lists only enabled modules and Version
	recMeta := httptest.NewRecorder()
	a.Handler().ServeHTTP(recMeta, httptest.NewRequest(http.MethodGet, "/api/v1/meta", nil))
	if recMeta.Code != http.StatusOK {
		t.Fatalf("expected 200 on /api/v1/meta, got %d", recMeta.Code)
	}
	var metaResp AppMeta
	if err := json.Unmarshal(recMeta.Body.Bytes(), &metaResp); err != nil {
		t.Fatalf("decode meta: %v", err)
	}
	if metaResp.Version != Version || len(metaResp.Modules) != 1 || metaResp.Modules[0].ID != "demo" {
		t.Fatalf("expected version %q and only 'demo' enabled, got %+v", Version, metaResp)
	}

	// 3. Unknown /api/* returns JSON 404 (never SPA HTML)
	recAPI404 := httptest.NewRecorder()
	a.Handler().ServeHTTP(recAPI404, httptest.NewRequest(http.MethodGet, "/api/v1/does-not-exist", nil))
	if recAPI404.Code != http.StatusNotFound || !strings.Contains(recAPI404.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("expected JSON 404, got %d %q %s", recAPI404.Code, recAPI404.Header().Get("Content-Type"), recAPI404.Body.String())
	}

	// 4. Module route is protected by RequireAuth
	recUnauth := httptest.NewRecorder()
	a.Handler().ServeHTTP(recUnauth, httptest.NewRequest(http.MethodGet, "/api/v1/demo/ping", nil))
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on unauthenticated module route, got %d", recUnauth.Code)
	}

	// Authenticated request reaches plugged-in module
	tok, _ := authSvc.IssueSessionToken(1)
	reqAuth := httptest.NewRequest(http.MethodGet, "/api/v1/demo/ping", nil)
	reqAuth.AddCookie(&http.Cookie{Name: "yukideck_session", Value: tok})
	recAuth := httptest.NewRecorder()
	a.Handler().ServeHTTP(recAuth, reqAuth)
	if recAuth.Code != http.StatusOK || !strings.Contains(recAuth.Body.String(), `"demo"`) {
		t.Fatalf("expected 200 from demo module, got %d %s", recAuth.Code, recAuth.Body.String())
	}

	// 5. Embedded SPA route serves index.html
	recUI := httptest.NewRecorder()
	a.Handler().ServeHTTP(recUI, httptest.NewRequest(http.MethodGet, "/demo/anything", nil))
	if recUI.Code != http.StatusOK || !strings.Contains(recUI.Body.String(), "YukiDeck UI") {
		t.Fatalf("expected embedded SPA HTML, got %d %s", recUI.Code, recUI.Body.String())
	}
}
