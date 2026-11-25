package auth

import (
	"context"
	"net/http"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/httpx"
)

// ResourceLister dynamically enumerates selectable module resources for a user (used by the API Key UI).
type ResourceLister func(ctx context.Context, userID int64) ([]ResourceOption, error)

type registeredPermission struct {
	def    PermissionDef
	lister ResourceLister
}

// PermissionRegistry holds fine-grained permissions self-declared by core services and business modules.
type PermissionRegistry struct {
	mu    sync.RWMutex
	order []string
	items map[string]registeredPermission
}

func NewPermissionRegistry() *PermissionRegistry {
	return &PermissionRegistry{
		items: make(map[string]registeredPermission),
	}
}

func (r *PermissionRegistry) Register(def PermissionDef, lister ResourceLister) {
	def.Key = strings.TrimSpace(def.Key)
	if def.Key == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.items[def.Key]; !exists {
		r.order = append(r.order, def.Key)
	}
	r.items[def.Key] = registeredPermission{def: def, lister: lister}
}

func (r *PermissionRegistry) Get(key string) (PermissionDef, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	item, ok := r.items[key]
	if !ok {
		return PermissionDef{}, false
	}
	return item.def, true
}

func (r *PermissionRegistry) List() []PermissionDef {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]PermissionDef, 0, len(r.order))
	for _, k := range r.order {
		out = append(out, r.items[k].def)
	}
	return out
}

func (r *PermissionRegistry) SchemaForUser(ctx context.Context, userID int64) ([]PermissionSchemaItem, error) {
	r.mu.RLock()
	snapshot := make([]registeredPermission, 0, len(r.order))
	for _, k := range r.order {
		snapshot = append(snapshot, r.items[k])
	}
	r.mu.RUnlock()

	out := make([]PermissionSchemaItem, 0, len(snapshot))
	for _, item := range snapshot {
		resources := []ResourceOption{}
		if item.lister != nil {
			listed, err := item.lister(ctx, userID)
			if err != nil {
				return nil, err
			}
			if listed != nil {
				resources = listed
			}
		}
		out = append(out, PermissionSchemaItem{
			Key:           item.def.Key,
			ModuleID:      item.def.ModuleID,
			ModuleName:    item.def.ModuleName,
			Label:         item.def.Label,
			Description:   item.def.Description,
			ResourceType:  item.def.ResourceType,
			AllowQueryKey: item.def.AllowQueryKey,
			Resources:     resources,
		})
	}
	return out, nil
}

// PrincipalKind distinguishes browser OIDC sessions from scoped API Keys.
type PrincipalKind string

const (
	PrincipalSession PrincipalKind = "session"
	PrincipalAPIKey  PrincipalKind = "api_key"
)

// Principal represents the authenticated caller bound to request context.
// API Key principals start with Authorized=false (fail-closed) until a route's RequirePermission middleware approves them.
type Principal struct {
	User       *User
	Kind       PrincipalKind
	APIKeyID   int64
	Policies   []PolicyRule
	Authorized bool
}

type principalContextKey struct{}

func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalContextKey{}, p)
}

func PrincipalFromContext(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalContextKey{}).(*Principal)
	return p, ok && p != nil && p.User != nil
}

// WithUser binds an OIDC session user to context (preserving full backwards compatibility with unit tests).
func WithUser(ctx context.Context, u *User) context.Context {
	if u == nil {
		return ctx
	}
	return WithPrincipal(ctx, &Principal{
		User:       u,
		Kind:       PrincipalSession,
		Authorized: true,
	})
}

func UserFromContext(ctx context.Context) (*User, bool) {
	p, ok := PrincipalFromContext(ctx)
	if !ok || !p.Authorized {
		return nil, false
	}
	return p.User, true
}

func UserID(ctx context.Context) (int64, bool) {
	u, ok := UserFromContext(ctx)
	if !ok {
		return 0, false
	}
	return u.ID, true
}

// MatchPolicies evaluates Cloudflare-style Permission × Resource policy rules.
func MatchPolicies(policies []PolicyRule, perm string, resource string) bool {
	perm = strings.TrimSpace(perm)
	resource = strings.TrimSpace(resource)
	if perm == "" {
		return false
	}
	for _, rule := range policies {
		if rule.Permission != perm || len(rule.Resources) == 0 {
			continue
		}
		if resource == "" {
			return true
		}
		for _, r := range rule.Resources {
			if r == "*" || r == resource {
				return true
			}
		}
	}
	return false
}

// ParamResource extracts a chi URL parameter as the target resource identifier for RequirePermission.
func ParamResource(paramName string) func(*http.Request) string {
	return func(r *http.Request) string {
		return strings.TrimSpace(chi.URLParam(r, paramName))
	}
}

// RequireSession enforces that the caller authenticated via browser OIDC session cookie (rejects API Keys with 403).
func RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFromContext(r.Context())
		if !ok {
			httpx.WriteError(w, r, nil, httpx.Unauthorized("请先通过 SSO 登录"))
			return
		}
		if p.Kind != PrincipalSession {
			httpx.WriteError(w, r, nil, httpx.Forbidden("此接口仅支持浏览器会话访问，不允许使用 API Key"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequirePermission allows OIDC sessions unconditionally, and enforces Cloudflare-style policy matching for API Keys.
func RequirePermission(perm string, resourceFn func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := PrincipalFromContext(r.Context())
			if !ok {
				httpx.WriteError(w, r, nil, httpx.Unauthorized("请先登录或提供有效的 API Key"))
				return
			}
			if p.Kind == PrincipalSession {
				next.ServeHTTP(w, r)
				return
			}
			resource := ""
			if resourceFn != nil {
				resource = resourceFn(r)
			}
			if !MatchPolicies(p.Policies, perm, resource) {
				msg := "API Key 缺少所需权限: " + perm
				if resource != "" {
					msg += " (资源: " + resource + ")"
				}
				httpx.WriteError(w, r, nil, httpx.Forbidden(msg))
				return
			}
			approved := *p
			approved.Authorized = true
			next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), &approved)))
		})
	}
}
