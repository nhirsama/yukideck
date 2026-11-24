package auth

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

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

func TestSessionCookieMiddleware(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x11}, 32))
	store := &memUserStore{users: map[int64]*User{
		42: {ID: 42, Username: "yuki", Email: "yuki@example.com"},
	}}
	svc := NewTestService(&config.Config{}, box, store, nil)

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
