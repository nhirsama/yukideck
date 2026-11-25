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
	apiKeys  APIKeyStore
	permReg  *PermissionRegistry
	logger   *slog.Logger
	provider *oidc.Provider
	oauthCfg *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

func Migrations() fs.FS {
	return migrationsFS
}

func NewService(
	ctx context.Context,
	cfg *config.Config,
	box *crypto.Box,
	store UserStore,
	apiKeys APIKeyStore,
	logger *slog.Logger,
) (*Service, error) {
	provider, err := oidc.NewProvider(ctx, cfg.OIDCIssuer)
	if err != nil {
		return nil, fmt.Errorf("discover oidc provider %q: %w", cfg.OIDCIssuer, err)
	}

	var scopes []string
	for _, raw := range cfg.OIDCScopes {
		for _, part := range strings.Fields(raw) {
			if part != "" {
				scopes = append(scopes, part)
			}
		}
	}
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
		apiKeys:  apiKeys,
		permReg:  NewPermissionRegistry(),
		logger:   logger,
		provider: provider,
		oauthCfg: oauthCfg,
		verifier: verifier,
	}, nil
}

// NewTestService creates a Service without performing OIDC network discovery (for unit tests).
func NewTestService(cfg *config.Config, box *crypto.Box, store UserStore, apiKeys APIKeyStore, logger *slog.Logger) *Service {
	return &Service{
		cfg:     cfg,
		box:     box,
		store:   store,
		apiKeys: apiKeys,
		permReg: NewPermissionRegistry(),
		logger:  logger,
	}
}

func (s *Service) Permissions() *PermissionRegistry {
	return s.permReg
}

func (s *Service) RegisterRoutes(r chi.Router) {
	r.Get("/login", httpx.Handle(s.logger, s.handleLogin))
	r.Get("/callback", httpx.Handle(s.logger, s.handleCallback))
	r.Post("/logout", httpx.Handle(s.logger, s.handleLogout))

	// Session-only identity & API Key management endpoints (never accessible via API Key).
	r.Group(func(sess chi.Router) {
		sess.Use(s.RequireSession)
		sess.Get("/me", httpx.Handle(s.logger, s.handleMe))

		sess.Get("/api-keys/schema", httpx.Handle(s.logger, s.handleAPIKeySchema))
		sess.Get("/api-keys", httpx.Handle(s.logger, s.handleListAPIKeys))
		sess.Post("/api-keys", httpx.Handle(s.logger, s.handleCreateAPIKey))
		sess.Put("/api-keys/{id}", httpx.Handle(s.logger, s.handleUpdateAPIKey))
		sess.Post("/api-keys/{id}/rotate", httpx.Handle(s.logger, s.handleRotateAPIKey))
		sess.Delete("/api-keys/{id}", httpx.Handle(s.logger, s.handleDeleteAPIKey))
	})
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

	var claims oidcUserClaims
	if err := idToken.Claims(&claims); err != nil || claims.Sub == "" {
		return httpx.Unauthorized("无法解析 OIDC 用户声明")
	}

	// Many OIDC providers omit profile claims (nickname/name/picture/email) from id_token
	// and only expose them via the standard UserInfo endpoint.
	var userinfoKeys []string
	if s.provider != nil && (claims.resolveDisplayName() == claims.Sub || strings.TrimSpace(claims.Nickname) == "" || claims.resolveAvatarURL() == "" || strings.TrimSpace(claims.Email) == "") {
		if ui, err := s.provider.UserInfo(exchangeCtx, oauth2.StaticTokenSource(token)); err == nil {
			var uiClaims oidcUserClaims
			if err := ui.Claims(&uiClaims); err == nil {
				claims.merge(uiClaims)
			}
			var rawUI map[string]any
			if err := ui.Claims(&rawUI); err == nil {
				for k := range rawUI {
					userinfoKeys = append(userinfoKeys, k)
				}
			}
		} else if s.logger != nil {
			s.logger.Warn("oidc userinfo fetch failed, falling back to id_token claims", "err", err)
		}
	}

	username := claims.resolveDisplayName()
	avatarURL := claims.resolveAvatarURL()

	if s.logger != nil {
		var idKeys []string
		var rawID map[string]any
		if err := idToken.Claims(&rawID); err == nil {
			for k := range rawID {
				idKeys = append(idKeys, k)
			}
		}
		s.logger.Info("oidc login resolved profile",
			"has_avatar", avatarURL != "",
			"fallback_to_sub", username == claims.Sub,
			"id_token_keys", idKeys,
			"userinfo_keys", userinfoKeys,
		)
	}

	user, err := s.store.UpsertByOIDCSub(r.Context(), claims.Sub, username, strings.TrimSpace(claims.Email), avatarURL)
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

func extractBearerToken(r *http.Request) (string, bool) {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if h == "" {
		return "", false
	}
	scheme, token, ok := strings.Cut(h, " ")
	if !ok || !strings.EqualFold(strings.TrimSpace(scheme), "bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", false
	}
	return token, true
}

func (s *Service) authenticateSessionCookie(r *http.Request) (*Principal, error) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return nil, httpx.Unauthorized("请先通过 SSO 登录")
	}
	userID, err := s.ParseSessionToken(cookie.Value)
	if err != nil {
		return nil, httpx.Unauthorized("登录状态无效或已过期")
	}
	user, err := s.store.FindByID(r.Context(), userID)
	if err != nil {
		return nil, httpx.Internal("查询用户失败", err)
	}
	if user == nil {
		return nil, httpx.Unauthorized("用户不存在")
	}
	return &Principal{
		User:       user,
		Kind:       PrincipalSession,
		Authorized: true,
	}, nil
}

// RequireSession validates only the signed OIDC session cookie (rejects API Keys with 403).
func (s *Service) RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, hasBearer := extractBearerToken(r); hasBearer {
			httpx.WriteError(w, r, s.logger, httpx.Forbidden("此接口仅支持浏览器会话访问，不允许使用 API Key"))
			return
		}
		principal, err := s.authenticateSessionCookie(r)
		if err != nil {
			httpx.WriteError(w, r, s.logger, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), principal)))
	})
}

// RequireAuth validates either an Authorization: Bearer API Key or the signed OIDC session cookie.
// Standard RESTful module routes NEVER accept query-parameter keys.
func (s *Service) RequireAuth(next http.Handler) http.Handler {
	return s.requireAuth(false, next)
}

// RequireAuthWithQueryKey validates Authorization: Bearer, ?key=..., or the signed OIDC session cookie.
// Reserved exclusively for custom endpoints whose PermissionDef sets AllowQueryKey=true (e.g. messenger push).
func (s *Service) RequireAuthWithQueryKey(next http.Handler) http.Handler {
	return s.requireAuth(true, next)
}

func (s *Service) requireAuth(allowQueryKey bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if bearer, ok := extractBearerToken(r); ok {
			principal, err := s.authenticateAPIKey(r.Context(), bearer)
			if err != nil {
				httpx.WriteError(w, r, s.logger, err)
				return
			}
			next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), principal)))
			return
		}
		if allowQueryKey {
			if qKey := strings.TrimSpace(r.URL.Query().Get("key")); qKey != "" {
				principal, err := s.authenticateAPIKey(r.Context(), qKey)
				if err != nil {
					httpx.WriteError(w, r, s.logger, err)
					return
				}
				next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), principal)))
				return
			}
		}
		principal, err := s.authenticateSessionCookie(r)
		if err != nil {
			httpx.WriteError(w, r, s.logger, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), principal)))
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

type oidcUserClaims struct {
	Sub               string `json:"sub"`
	Nickname          string `json:"nickname"`
	DisplayName       string `json:"display_name"`
	DisplayNameCamel  string `json:"displayName"`
	Name              string `json:"name"`
	GivenName         string `json:"given_name"`
	FamilyName        string `json:"family_name"`
	PreferredUsername string `json:"preferred_username"`
	Username          string `json:"username"`
	Login             string `json:"login"`
	Email             string `json:"email"`
	Picture           string `json:"picture"`
	Avatar            string `json:"avatar"`
	AvatarURL         string `json:"avatar_url"`
	AvatarURLCamel    string `json:"avatarUrl"`
}

func (c *oidcUserClaims) merge(other oidcUserClaims) {
	fill := func(dst *string, src string) {
		if strings.TrimSpace(*dst) == "" {
			*dst = src
		}
	}
	fill(&c.Nickname, other.Nickname)
	fill(&c.DisplayName, other.DisplayName)
	fill(&c.DisplayNameCamel, other.DisplayNameCamel)
	fill(&c.Name, other.Name)
	fill(&c.GivenName, other.GivenName)
	fill(&c.FamilyName, other.FamilyName)
	fill(&c.PreferredUsername, other.PreferredUsername)
	fill(&c.Username, other.Username)
	fill(&c.Login, other.Login)
	fill(&c.Email, other.Email)
	fill(&c.Picture, other.Picture)
	fill(&c.Avatar, other.Avatar)
	fill(&c.AvatarURL, other.AvatarURL)
	fill(&c.AvatarURLCamel, other.AvatarURLCamel)
}

func (c oidcUserClaims) resolveDisplayName() string {
	fullGiven := strings.TrimSpace(strings.TrimSpace(c.GivenName) + " " + strings.TrimSpace(c.FamilyName))
	for _, candidate := range []string{
		c.Nickname,
		c.DisplayName,
		c.DisplayNameCamel,
		c.Name,
		fullGiven,
		c.PreferredUsername,
		c.Username,
		c.Login,
	} {
		if v := strings.TrimSpace(candidate); v != "" && v != c.Sub {
			return v
		}
	}
	if email := strings.TrimSpace(c.Email); email != "" {
		if local, _, ok := strings.Cut(email, "@"); ok && strings.TrimSpace(local) != "" {
			return strings.TrimSpace(local)
		}
		return email
	}
	return c.Sub
}

func (c oidcUserClaims) resolveAvatarURL() string {
	for _, candidate := range []string{c.Picture, c.Avatar, c.AvatarURL, c.AvatarURLCamel} {
		if v := strings.TrimSpace(candidate); v != "" {
			return v
		}
	}
	return ""
}
