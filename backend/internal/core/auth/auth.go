package auth

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"

	"yukideck/internal/config"
	"yukideck/internal/core/auth/sqlcgen"
	"yukideck/internal/core/crypto"
	"yukideck/internal/core/httpx"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

const (
	sessionCookieName = "yukideck_session"
	stateCookieName   = "yukideck_oidc_state"
	sessionTTL        = 7 * 24 * time.Hour
)

type UserStore interface {
	UpsertByOIDCSub(ctx context.Context, sub, username, email, avatarURL string) (*User, error)
	FindByID(ctx context.Context, id int64) (*User, error)
}

type pgUserStore struct {
	q *sqlcgen.Queries
}

func NewPGUserStore(pool *pgxpool.Pool) UserStore {
	return &pgUserStore{q: sqlcgen.New(pool)}
}

func (s *pgUserStore) UpsertByOIDCSub(ctx context.Context, sub, username, email, avatarURL string) (*User, error) {
	row, err := s.q.UpsertUserByOIDCSub(ctx, sqlcgen.UpsertUserByOIDCSubParams{
		OidcSub:   sub,
		Username:  username,
		Email:     email,
		AvatarUrl: avatarURL,
	})
	if err != nil {
		return nil, fmt.Errorf("upsert oidc user: %w", err)
	}
	return &User{
		ID:        row.ID,
		OIDCSub:   row.OidcSub,
		Username:  row.Username,
		Email:     row.Email,
		AvatarURL: row.AvatarUrl,
	}, nil
}

func (s *pgUserStore) FindByID(ctx context.Context, id int64) (*User, error) {
	row, err := s.q.FindUserByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find user by id: %w", err)
	}
	return &User{
		ID:        row.ID,
		OIDCSub:   row.OidcSub,
		Username:  row.Username,
		Email:     row.Email,
		AvatarURL: row.AvatarUrl,
	}, nil
}

type sessionPayload struct {
	UserID int64 `json:"uid"`
	Exp    int64 `json:"exp"`
}

type statePayload struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	Exp      int64  `json:"exp"`
}

type Service struct {
	cfg      *config.Config
	box      *crypto.Box
	store    UserStore
	logger   *slog.Logger
	oauthCfg *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

func Migrations() fs.FS {
	return migrationsFS
}

func NewService(ctx context.Context, cfg *config.Config, box *crypto.Box, store UserStore, logger *slog.Logger) (*Service, error) {
	provider, err := oidc.NewProvider(ctx, cfg.OIDCIssuer)
	if err != nil {
		return nil, fmt.Errorf("discover oidc provider %q: %w", cfg.OIDCIssuer, err)
	}

	scopes := cfg.OIDCScopes
	if len(scopes) == 0 {
		scopes = []string{oidc.ScopeOpenID, "profile", "email"}
	}
	oauthCfg := &oauth2.Config{
		ClientID:     cfg.OIDCClientID,
		ClientSecret: cfg.OIDCClientSecret,
		RedirectURL:  cfg.OIDCRedirectURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       scopes,
	}
	verifier := provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID})

	return &Service{
		cfg:      cfg,
		box:      box,
		store:    store,
		logger:   logger,
		oauthCfg: oauthCfg,
		verifier: verifier,
	}, nil
}

// NewTestService creates a Service without performing OIDC network discovery (for unit tests).
func NewTestService(cfg *config.Config, box *crypto.Box, store UserStore, logger *slog.Logger) *Service {
	return &Service{
		cfg:    cfg,
		box:    box,
		store:  store,
		logger: logger,
	}
}

func (s *Service) RegisterRoutes(r chi.Router) {
	r.Get("/login", httpx.Handle(s.logger, s.handleLogin))
	r.Get("/callback", httpx.Handle(s.logger, s.handleCallback))
	r.Post("/logout", httpx.Handle(s.logger, s.handleLogout))
	r.With(s.RequireAuth).Get("/me", httpx.Handle(s.logger, s.handleMe))
}

func (s *Service) handleLogin(w http.ResponseWriter, r *http.Request) error {
	if s.oauthCfg == nil {
		return httpx.Internal("OIDC 未初始化", nil)
	}
	state, err := crypto.RandomToken(24)
	if err != nil {
		return httpx.Internal("生成 OIDC state 失败", err)
	}
	verifier := oauth2.GenerateVerifier()

	cookieVal, err := s.encodeSigned(statePayload{
		State:    state,
		Verifier: verifier,
		Exp:      time.Now().Add(10 * time.Minute).Unix(),
	})
	if err != nil {
		return httpx.Internal("签发 state cookie 失败", err)
	}

	http.SetCookie(w, s.buildCookie(stateCookieName, cookieVal, 600))
	authURL := s.oauthCfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
	http.Redirect(w, r, authURL, http.StatusFound)
	return nil
}

func (s *Service) handleCallback(w http.ResponseWriter, r *http.Request) error {
	if s.oauthCfg == nil || s.verifier == nil {
		return httpx.Internal("OIDC 未初始化", nil)
	}
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		return httpx.Unauthorized("OIDC 授权失败: " + errParam)
	}
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		return httpx.BadRequest("缺少 OIDC code 或 state 参数")
	}

	stateCookie, err := r.Cookie(stateCookieName)
	if err != nil {
		return httpx.Unauthorized("缺少或过期的 OIDC state cookie")
	}
	var sp statePayload
	if err := s.decodeSigned(stateCookie.Value, &sp); err != nil || sp.Exp < time.Now().Unix() || !crypto.ConstantTimeEqual(sp.State, state) {
		return httpx.Unauthorized("OIDC state 校验失败")
	}
	// Clear one-time state cookie
	http.SetCookie(w, s.buildCookie(stateCookieName, "", -1))

	exchangeCtx, cancel := context.WithTimeout(r.Context(), s.cfg.ExternalHTTPTimeout)
	defer cancel()
	token, err := s.oauthCfg.Exchange(exchangeCtx, code, oauth2.VerifierOption(sp.Verifier))
	if err != nil {
		return httpx.Unauthorized("OIDC 换取 Token 失败")
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return httpx.Unauthorized("OIDC 响应中缺少 id_token")
	}
	idToken, err := s.verifier.Verify(exchangeCtx, rawIDToken)
	if err != nil {
		return httpx.Unauthorized("OIDC id_token 验签失败")
	}

	var claims struct {
		Sub               string `json:"sub"`
		PreferredUsername string `json:"preferred_username"`
		Name              string `json:"name"`
		Email             string `json:"email"`
		Picture           string `json:"picture"`
	}
	if err := idToken.Claims(&claims); err != nil || claims.Sub == "" {
		return httpx.Unauthorized("无法解析 OIDC 用户声明")
	}
	username := strings.TrimSpace(claims.PreferredUsername)
	if username == "" {
		username = strings.TrimSpace(claims.Name)
	}
	if username == "" {
		username = strings.TrimSpace(claims.Email)
	}
	if username == "" {
		username = claims.Sub
	}

	user, err := s.store.UpsertByOIDCSub(r.Context(), claims.Sub, username, claims.Email, claims.Picture)
	if err != nil {
		return httpx.Internal("保存用户信息失败", err)
	}

	sessToken, err := s.IssueSessionToken(user.ID)
	if err != nil {
		return httpx.Internal("签发登录会话失败", err)
	}
	http.SetCookie(w, s.buildCookie(sessionCookieName, sessToken, int(sessionTTL.Seconds())))
	http.Redirect(w, r, s.cfg.FrontendBaseURL, http.StatusFound)
	return nil
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request) error {
	user, ok := UserFromContext(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"user": user})
	return nil
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) error {
	http.SetCookie(w, s.buildCookie(sessionCookieName, "", -1))
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (s *Service) IssueSessionToken(userID int64) (string, error) {
	return s.encodeSigned(sessionPayload{
		UserID: userID,
		Exp:    time.Now().Add(sessionTTL).Unix(),
	})
}

func (s *Service) ParseSessionToken(token string) (int64, error) {
	var sp sessionPayload
	if err := s.decodeSigned(token, &sp); err != nil {
		return 0, err
	}
	if sp.Exp < time.Now().Unix() || sp.UserID <= 0 {
		return 0, errors.New("session expired")
	}
	return sp.UserID, nil
}

// RequireAuth validates the signed session cookie and binds User to request context.
func (s *Service) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil || cookie.Value == "" {
			httpx.WriteError(w, r, s.logger, httpx.Unauthorized("请先通过 SSO 登录"))
			return
		}
		userID, err := s.ParseSessionToken(cookie.Value)
		if err != nil {
			httpx.WriteError(w, r, s.logger, httpx.Unauthorized("登录状态无效或已过期"))
			return
		}
		user, err := s.store.FindByID(r.Context(), userID)
		if err != nil {
			httpx.WriteError(w, r, s.logger, httpx.Internal("查询用户失败", err))
			return
		}
		if user == nil {
			httpx.WriteError(w, r, s.logger, httpx.Unauthorized("用户不存在"))
			return
		}
		ctx := WithUser(r.Context(), user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Service) encodeSigned(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	sig := s.box.Sign([]byte(encoded))
	return encoded + "." + sig, nil
}

func (s *Service) decodeSigned(token string, dst any) error {
	encoded, sig, ok := strings.Cut(token, ".")
	if !ok || encoded == "" || sig == "" {
		return errors.New("malformed token")
	}
	if !s.box.Verify([]byte(encoded), sig) {
		return errors.New("invalid signature")
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, dst)
}

func (s *Service) buildCookie(name, value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		Domain:   s.cfg.CookieDomain,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: s.cfg.SameSiteMode(),
	}
}

type userContextKey struct{}

func WithUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, userContextKey{}, u)
}

func UserFromContext(ctx context.Context) (*User, bool) {
	u, ok := ctx.Value(userContextKey{}).(*User)
	return u, ok && u != nil
}

func UserID(ctx context.Context) (int64, bool) {
	u, ok := UserFromContext(ctx)
	if !ok {
		return 0, false
	}
	return u.ID, true
}
