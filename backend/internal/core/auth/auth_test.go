package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/config"
	"yukideck/internal/core/crypto"
)

type memUserStore struct {
	users map[int64]*User
}

func (m *memUserStore) UpsertByOIDCSub(_ context.Context, sub, username, email, avatar string) (*User, error) {
	u := &User{ID: 1, OIDCSub: sub, Username: username, Email: email, AvatarURL: avatar}
	m.users[u.ID] = u
	return u, nil
}

func (m *memUserStore) FindByID(_ context.Context, id int64) (*User, error) {
	return m.users[id], nil
}

type memAPIKeyStore struct {
	mu     sync.Mutex
	nextID int64
	keys   map[int64]APIKeyRecord
}

func newMemAPIKeyStore() *memAPIKeyStore {
	return &memAPIKeyStore{keys: make(map[int64]APIKeyRecord)}
}

func (m *memAPIKeyStore) List(_ context.Context, userID int64) ([]APIKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []APIKeyRecord
	for _, r := range m.keys {
		if r.UserID == userID {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *memAPIKeyStore) Get(_ context.Context, userID, id int64) (*APIKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.keys[id]
	if !ok || r.UserID != userID {
		return nil, nil
	}
	return &r, nil
}

func (m *memAPIKeyStore) FindByHash(_ context.Context, keyHash string) (*APIKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.keys {
		if r.KeyHash == keyHash {
			cp := r
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *memAPIKeyStore) Create(_ context.Context, rec APIKeyRecord) (*APIKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	rec.ID = m.nextID
	rec.CreatedAt = time.Now()
	rec.UpdatedAt = rec.CreatedAt
	m.keys[rec.ID] = rec
	return &rec, nil
}

func (m *memAPIKeyStore) Update(_ context.Context, rec APIKeyRecord) (*APIKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.keys[rec.ID]
	if !ok || old.UserID != rec.UserID {
		return nil, nil
	}
	rec.KeyPrefix = old.KeyPrefix
	rec.KeyHash = old.KeyHash
	rec.LastUsedAt = old.LastUsedAt
	rec.CreatedAt = old.CreatedAt
	rec.UpdatedAt = time.Now()
	m.keys[rec.ID] = rec
	return &rec, nil
}

func (m *memAPIKeyStore) Rotate(_ context.Context, userID, id int64, keyPrefix, keyHash string) (*APIKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.keys[id]
	if !ok || old.UserID != userID {
		return nil, nil
	}
	old.KeyPrefix = keyPrefix
	old.KeyHash = keyHash
	old.UpdatedAt = time.Now()
	m.keys[id] = old
	return &old, nil
}

func (m *memAPIKeyStore) TouchUsed(_ context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.keys[id]; ok {
		now := time.Now()
		r.LastUsedAt = &now
		m.keys[id] = r
	}
	return nil
}

func (m *memAPIKeyStore) Delete(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.keys[id]; ok && r.UserID == userID {
		delete(m.keys, id)
	}
	return nil
}

func TestSessionCookieMiddleware(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x11}, 32))
	store := &memUserStore{users: map[int64]*User{
		42: {ID: 42, Username: "yuki", Email: "yuki@example.com"},
	}}
	svc := NewTestService(&config.Config{}, box, store, newMemAPIKeyStore(), nil)

	protected := svc.RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, ok := UserID(r.Context())
		if !ok || uid != 42 {
			t.Errorf("expected user ID 42, got %d (%v)", uid, ok)
		}
		w.WriteHeader(http.StatusOK)
	}))

	// 1. Missing cookie -> 401
	rec := httptest.NewRecorder()
	protected.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/test", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without cookie, got %d", rec.Code)
	}

	// 2. Valid signed cookie -> 200
	tok, err := svc.IssueSessionToken(42)
	if err != nil {
		t.Fatalf("IssueSessionToken: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: tok})
	rec2 := httptest.NewRecorder()
	protected.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200 with valid cookie, got %d", rec2.Code)
	}

	// 3. Tampered cookie -> 401
	req3 := httptest.NewRequest(http.MethodGet, "/test", nil)
	req3.AddCookie(&http.Cookie{Name: sessionCookieName, Value: tok + "tampered"})
	rec3 := httptest.NewRecorder()
	protected.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with tampered cookie, got %d", rec3.Code)
	}
}

func TestAPIKeyCloudflarePoliciesAndBoundaries(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x22}, 32))
	users := &memUserStore{users: map[int64]*User{
		7: {ID: 7, Username: "alice"},
	}}
	keyStore := newMemAPIKeyStore()
	svc := NewTestService(&config.Config{RequestMaxBodyBytes: 1 << 20}, box, users, keyStore, nil)

	svc.Permissions().Register(PermissionDef{
		Key:          "messenger:push",
		ModuleID:     "messenger",
		ModuleName:   "消息中枢",
		Label:        "自定义终结点推送",
		ResourceType: "push_endpoint",
		AllowQueryKey: true,
	}, func(_ context.Context, _ int64) ([]ResourceOption, error) {
		return []ResourceOption{{ID: "alert", Name: "告警 (alert)"}, {ID: "nas", Name: "NAS (nas)"}}, nil
	})
	svc.Permissions().Register(PermissionDef{
		Key:        "demo:read",
		ModuleID:   "demo",
		ModuleName: "Demo",
		Label:      "读取",
	}, nil)

	ctx := context.Background()

	// 1. Dynamic schema resolution
	schema, err := svc.Permissions().SchemaForUser(ctx, 7)
	if err != nil || len(schema) != 2 || len(schema[0].Resources) != 2 {
		t.Fatalf("unexpected permission schema: %+v (err=%v)", schema, err)
	}

	// 2. Create API Key scoped to messenger:push -> ["alert"] only
	created, err := svc.CreateAPIKey(ctx, 7, UpsertAPIKeyInput{
		Name:    "Alert Key",
		Enabled: true,
		Policies: []PolicyRule{
			{Permission: "messenger:push", Resources: []string{"alert"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateAPIKey: %v", err)
	}
	if created.PlainKey == "" || created.APIKey.KeyPrefix == "" {
		t.Fatalf("expected generated key, got %+v", created)
	}

	r := chi.NewRouter()
	r.Route("/auth", svc.RegisterRoutes)
	r.Group(func(std chi.Router) {
		std.Use(svc.RequireAuth)
		std.With(RequirePermission("demo:read", nil)).Get("/demo", func(w http.ResponseWriter, r *http.Request) {
			uid, ok := UserID(r.Context())
			if !ok || uid != 7 {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.WriteHeader(http.StatusOK)
		})
		// Fail-closed test: route without RequirePermission must not expose UserID to API Key
		std.Get("/unannotated", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := UserID(r.Context()); !ok {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusOK)
		})
	})
	r.Group(func(push chi.Router) {
		push.Use(svc.RequireAuthWithQueryKey)
		push.With(RequirePermission("messenger:push", ParamResource("endpoint"))).Post("/push/{endpoint}", func(w http.ResponseWriter, r *http.Request) {
			uid, ok := UserID(r.Context())
			if !ok || uid != 7 {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.WriteHeader(http.StatusOK)
		})
	})

	// 3. API Key rejected on session-only management routes (403)
	reqMgmt := httptest.NewRequest(http.MethodGet, "/auth/api-keys", nil)
	reqMgmt.Header.Set("Authorization", "Bearer "+created.PlainKey)
	recMgmt := httptest.NewRecorder()
	r.ServeHTTP(recMgmt, reqMgmt)
	if recMgmt.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for API key on /auth/api-keys, got %d", recMgmt.Code)
	}

	// 4. API Key rejected on unpermitted module route (403)
	reqDemo := httptest.NewRequest(http.MethodGet, "/demo", nil)
	reqDemo.Header.Set("Authorization", "Bearer "+created.PlainKey)
	recDemo := httptest.NewRecorder()
	r.ServeHTTP(recDemo, reqDemo)
	if recDemo.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on unpermitted /demo, got %d", recDemo.Code)
	}

	// 5. Standard route ignores ?key= query param (401)
	reqQueryStd := httptest.NewRequest(http.MethodGet, "/demo?key="+created.PlainKey, nil)
	recQueryStd := httptest.NewRecorder()
	r.ServeHTTP(recQueryStd, reqQueryStd)
	if recQueryStd.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 when passing ?key= to standard route, got %d", recQueryStd.Code)
	}

	// 6. Fail-closed check: unannotated route cannot obtain UserID with API Key
	reqUnann := httptest.NewRequest(http.MethodGet, "/unannotated", nil)
	reqUnann.Header.Set("Authorization", "Bearer "+created.PlainKey)
	recUnann := httptest.NewRecorder()
	r.ServeHTTP(recUnann, reqUnann)
	if recUnann.Code != http.StatusForbidden {
		t.Fatalf("expected fail-closed 403 on unannotated route, got %d", recUnann.Code)
	}

	// 7. Push route allows resource "alert" via Bearer AND ?key=, rejects "nas" with 403
	reqPushOK := httptest.NewRequest(http.MethodPost, "/push/alert?key="+created.PlainKey, nil)
	recPushOK := httptest.NewRecorder()
	r.ServeHTTP(recPushOK, reqPushOK)
	if recPushOK.Code != http.StatusOK {
		t.Fatalf("expected 200 on allowed push resource via ?key=, got %d", recPushOK.Code)
	}

	reqPushDenied := httptest.NewRequest(http.MethodPost, "/push/nas", nil)
	reqPushDenied.Header.Set("Authorization", "Bearer "+created.PlainKey)
	recPushDenied := httptest.NewRecorder()
	r.ServeHTTP(recPushDenied, reqPushDenied)
	if recPushDenied.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on disallowed push resource 'nas', got %d", recPushDenied.Code)
	}

	// 8. Rotate invalidates old key and activates new key
	rotated, err := svc.RotateAPIKey(ctx, 7, created.APIKey.ID)
	if err != nil {
		t.Fatalf("RotateAPIKey: %v", err)
	}
	reqOld := httptest.NewRequest(http.MethodPost, "/push/alert?key="+created.PlainKey, nil)
	recOld := httptest.NewRecorder()
	r.ServeHTTP(recOld, reqOld)
	if recOld.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for rotated-out old key, got %d", recOld.Code)
	}
	reqNew := httptest.NewRequest(http.MethodPost, "/push/alert?key="+rotated.PlainKey, nil)
	recNew := httptest.NewRecorder()
	r.ServeHTTP(recNew, reqNew)
	if recNew.Code != http.StatusOK {
		t.Fatalf("expected 200 for rotated new key, got %d", recNew.Code)
	}

	// 9. Expired key returns 401
	past := time.Now().Add(-time.Minute)
	if _, err := svc.UpdateAPIKey(ctx, 7, created.APIKey.ID, UpsertAPIKeyInput{
		Name:      "Expired",
		Enabled:   true,
		ExpiresAt: &past,
		Policies:  []PolicyRule{{Permission: "messenger:push", Resources: []string{"*"}}},
	}); err != nil {
		t.Fatalf("UpdateAPIKey: %v", err)
	}
	reqExp := httptest.NewRequest(http.MethodPost, "/push/alert?key="+rotated.PlainKey, nil)
	recExp := httptest.NewRecorder()
	r.ServeHTTP(recExp, reqExp)
	if recExp.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for expired key, got %d", recExp.Code)
	}

	// 10. OIDC session can fetch /auth/api-keys/schema
	sessTok, _ := svc.IssueSessionToken(7)
	reqSchema := httptest.NewRequest(http.MethodGet, "/auth/api-keys/schema", nil)
	reqSchema.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessTok})
	recSchema := httptest.NewRecorder()
	r.ServeHTTP(recSchema, reqSchema)
	if recSchema.Code != http.StatusOK {
		t.Fatalf("expected 200 for session on /auth/api-keys/schema, got %d %s", recSchema.Code, recSchema.Body.String())
	}
	var payload struct {
		Permissions []PermissionSchemaItem `json:"permissions"`
	}
	if err := json.Unmarshal(recSchema.Body.Bytes(), &payload); err != nil || len(payload.Permissions) != 2 {
		t.Fatalf("unexpected schema response: %s", recSchema.Body.String())
	}
}

func TestOIDCUserClaimsResolution(t *testing.T) {
	idClaims := oidcUserClaims{
		Sub: "usr_12345",
	}
	idClaims.merge(oidcUserClaims{
		Nickname: "小雪",
		Name:     "Yuki",
		Email:    "yuki@example.com",
		Picture:  "https://cdn.example.com/avatar.png",
	})
	if got := idClaims.resolveDisplayName(); got != "小雪" {
		t.Fatalf("expected nickname 小雪, got %q", got)
	}
	if got := idClaims.resolveAvatarURL(); got != "https://cdn.example.com/avatar.png" {
		t.Fatalf("expected picture url, got %q", got)
	}

	emailFallback := oidcUserClaims{
		Sub:               "usr_999",
		PreferredUsername: "usr_999",
		Email:             "alice@example.com",
		Avatar:            "https://cdn.example.com/a.jpg",
	}
	if got := emailFallback.resolveDisplayName(); got != "alice" {
		t.Fatalf("expected email local part alice, got %q", got)
	}
	if got := emailFallback.resolveAvatarURL(); got != "https://cdn.example.com/a.jpg" {
		t.Fatalf("expected avatar fallback, got %q", got)
	}
}
