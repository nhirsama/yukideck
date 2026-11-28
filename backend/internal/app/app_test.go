package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
	return &auth.User{ID: 1, OIDCSub: sub, Username: u, Email: e, AvatarURL: a, Timezone: auth.DefaultTimezone, DisabledModules: []string{}}, nil
}
func (stubUserStore) FindByID(_ context.Context, id int64) (*auth.User, error) {
	return &auth.User{ID: id, Username: "yuki", Timezone: auth.DefaultTimezone, DisabledModules: []string{}}, nil
}
func (stubUserStore) UpdatePreferences(_ context.Context, id int64, tz string, disabled []string) (*auth.User, error) {
	return &auth.User{ID: id, Username: "yuki", Timezone: tz, DisabledModules: disabled}, nil
}

type stubAPIKeyStore struct {
	mu     sync.Mutex
	nextID int64
	keys   map[int64]auth.APIKeyRecord
}

func (s *stubAPIKeyStore) List(_ context.Context, _ int64) ([]auth.APIKeyRecord, error) { return nil, nil }
func (s *stubAPIKeyStore) Get(_ context.Context, _, _ int64) (*auth.APIKeyRecord, error) {
	return nil, nil
}
func (s *stubAPIKeyStore) FindByHash(_ context.Context, hash string) (*auth.APIKeyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.keys {
		if r.KeyHash == hash {
			cp := r
			return &cp, nil
		}
	}
	return nil, nil
}
func (s *stubAPIKeyStore) Create(_ context.Context, rec auth.APIKeyRecord) (*auth.APIKeyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	rec.ID = s.nextID
	s.keys[rec.ID] = rec
	return &rec, nil
}
func (s *stubAPIKeyStore) Update(_ context.Context, rec auth.APIKeyRecord) (*auth.APIKeyRecord, error) {
	return &rec, nil
}
func (s *stubAPIKeyStore) Rotate(_ context.Context, _, _ int64, _, _ string) (*auth.APIKeyRecord, error) {
	return nil, nil
}
func (s *stubAPIKeyStore) TouchUsed(_ context.Context, _ int64) error   { return nil }
func (s *stubAPIKeyStore) Delete(_ context.Context, _, _ int64) error   { return nil }

type stubModule struct {
	module.BaseModule
	id string
}

func (m stubModule) Meta() module.Meta {
	return module.Meta{ID: m.id, Name: "Stub " + m.id, Description: "test module"}
}

func (m stubModule) RegisterPermissions(reg *auth.PermissionRegistry) {
	reg.Register(auth.PermissionDef{
		Key:        m.id + ":read",
		ModuleID:   m.id,
		ModuleName: "Stub " + m.id,
		Label:      "读取",
	}, nil)
}

func (m stubModule) RegisterRoutes(r chi.Router) {
	r.With(auth.RequirePermission(m.id+":read", nil)).Get("/ping", func(w http.ResponseWriter, _ *http.Request) {
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

	apiKeyStore := &stubAPIKeyStore{keys: map[int64]auth.APIKeyRecord{}}
	authSvc := auth.NewTestService(cfg, box, stubUserStore{}, apiKeyStore, nil)
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

	// 3. Unknown /api/* and legacy /api/v1/push/* return JSON 404 (never SPA HTML)
	for _, path := range []string{"/api/v1/does-not-exist", "/api/v1/push/legacy-token"} {
		rec404 := httptest.NewRecorder()
		a.Handler().ServeHTTP(rec404, httptest.NewRequest(http.MethodGet, path, nil))
		if rec404.Code != http.StatusNotFound || !strings.Contains(rec404.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("expected JSON 404 for %s, got %d %q %s", path, rec404.Code, rec404.Header().Get("Content-Type"), rec404.Body.String())
		}
	}

	// 4. Module route is protected by RequireAuth
	recUnauth := httptest.NewRecorder()
	a.Handler().ServeHTTP(recUnauth, httptest.NewRequest(http.MethodGet, "/api/v1/demo/ping", nil))
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on unauthenticated module route, got %d", recUnauth.Code)
	}

	// Authenticated OIDC session reaches plugged-in module
	tok, _ := authSvc.IssueSessionToken(1)
	reqAuth := httptest.NewRequest(http.MethodGet, "/api/v1/demo/ping", nil)
	reqAuth.AddCookie(&http.Cookie{Name: "yukideck_session", Value: tok})
	recAuth := httptest.NewRecorder()
	a.Handler().ServeHTTP(recAuth, reqAuth)
	if recAuth.Code != http.StatusOK || !strings.Contains(recAuth.Body.String(), `"demo"`) {
		t.Fatalf("expected 200 from demo module, got %d %s", recAuth.Code, recAuth.Body.String())
	}

	// 5. Scoped API Key reaches permitted RESTful module route via Bearer, blocked on ?key= and on management routes
	keyResp, err := authSvc.CreateAPIKey(context.Background(), 1, auth.UpsertAPIKeyInput{
		Name:     "Demo Reader",
		Enabled:  true,
		Policies: []auth.PolicyRule{{Permission: "demo:read", Resources: []string{"*"}}},
	})
	if err != nil {
		t.Fatalf("CreateAPIKey: %v", err)
	}

	reqKeyOK := httptest.NewRequest(http.MethodGet, "/api/v1/demo/ping", nil)
	reqKeyOK.Header.Set("Authorization", "Bearer "+keyResp.PlainKey)
	recKeyOK := httptest.NewRecorder()
	a.Handler().ServeHTTP(recKeyOK, reqKeyOK)
	if recKeyOK.Code != http.StatusOK {
		t.Fatalf("expected 200 with permitted API key Bearer, got %d %s", recKeyOK.Code, recKeyOK.Body.String())
	}

	reqKeyQuery := httptest.NewRequest(http.MethodGet, "/api/v1/demo/ping?key="+keyResp.PlainKey, nil)
	recKeyQuery := httptest.NewRecorder()
	a.Handler().ServeHTTP(recKeyQuery, reqKeyQuery)
	if recKeyQuery.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 when using ?key= on standard module route, got %d", recKeyQuery.Code)
	}

	reqKeyMgmt := httptest.NewRequest(http.MethodGet, "/api/v1/messenger/channels", nil)
	reqKeyMgmt.Header.Set("Authorization", "Bearer "+keyResp.PlainKey)
	recKeyMgmt := httptest.NewRecorder()
	a.Handler().ServeHTTP(recKeyMgmt, reqKeyMgmt)
	if recKeyMgmt.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for API key on session-only messenger management route, got %d", recKeyMgmt.Code)
	}

	// 6. Embedded SPA route serves index.html
	recUI := httptest.NewRecorder()
	a.Handler().ServeHTTP(recUI, httptest.NewRequest(http.MethodGet, "/demo/anything", nil))
	if recUI.Code != http.StatusOK || !strings.Contains(recUI.Body.String(), "YukiDeck UI") {
		t.Fatalf("expected embedded SPA HTML, got %d %s", recUI.Code, recUI.Body.String())
	}
}
