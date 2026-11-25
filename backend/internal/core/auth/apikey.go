package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/core/auth/sqlcgen"
	"yukideck/internal/core/crypto"
	"yukideck/internal/core/httpx"
)

const apiKeyPrefix = "ydk_"

type APIKeyRecord struct {
	ID         int64
	UserID     int64
	Name       string
	KeyPrefix  string
	KeyHash    string
	Policies   []PolicyRule
	Enabled    bool
	ExpiresAt  *time.Time
	LastUsedAt *time.Time
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type APIKeyStore interface {
	List(ctx context.Context, userID int64) ([]APIKeyRecord, error)
	Get(ctx context.Context, userID, id int64) (*APIKeyRecord, error)
	FindByHash(ctx context.Context, keyHash string) (*APIKeyRecord, error)
	Create(ctx context.Context, rec APIKeyRecord) (*APIKeyRecord, error)
	Update(ctx context.Context, rec APIKeyRecord) (*APIKeyRecord, error)
	Rotate(ctx context.Context, userID, id int64, keyPrefix, keyHash string) (*APIKeyRecord, error)
	TouchUsed(ctx context.Context, id int64) error
	Delete(ctx context.Context, userID, id int64) error
}

type pgAPIKeyStore struct {
	q *sqlcgen.Queries
}

func NewPGAPIKeyStore(pool *pgxpool.Pool) APIKeyStore {
	return &pgAPIKeyStore{q: sqlcgen.New(pool)}
}

func toAPIKeyRecord(row sqlcgen.ApiKey) (APIKeyRecord, error) {
	policies := []PolicyRule{}
	if len(row.Policies) > 0 {
		if err := json.Unmarshal(row.Policies, &policies); err != nil {
			return APIKeyRecord{}, fmt.Errorf("unmarshal api key policies: %w", err)
		}
	}
	return APIKeyRecord{
		ID:         row.ID,
		UserID:     row.UserID,
		Name:       row.Name,
		KeyPrefix:  row.KeyPrefix,
		KeyHash:    row.KeyHash,
		Policies:   policies,
		Enabled:    row.Enabled,
		ExpiresAt:  row.ExpiresAt,
		LastUsedAt: row.LastUsedAt,
		CreatedAt:  row.CreatedAt,
		UpdatedAt:  row.UpdatedAt,
	}, nil
}

func (s *pgAPIKeyStore) List(ctx context.Context, userID int64) ([]APIKeyRecord, error) {
	rows, err := s.q.ListAPIKeys(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]APIKeyRecord, 0, len(rows))
	for _, row := range rows {
		rec, err := toAPIKeyRecord(row)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, nil
}

func (s *pgAPIKeyStore) Get(ctx context.Context, userID, id int64) (*APIKeyRecord, error) {
	row, err := s.q.GetAPIKey(ctx, sqlcgen.GetAPIKeyParams{UserID: userID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec, err := toAPIKeyRecord(row)
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (s *pgAPIKeyStore) FindByHash(ctx context.Context, keyHash string) (*APIKeyRecord, error) {
	row, err := s.q.FindAPIKeyByHash(ctx, keyHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec, err := toAPIKeyRecord(row)
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (s *pgAPIKeyStore) Create(ctx context.Context, rec APIKeyRecord) (*APIKeyRecord, error) {
	rawPolicies, err := json.Marshal(rec.Policies)
	if err != nil {
		return nil, err
	}
	row, err := s.q.CreateAPIKey(ctx, sqlcgen.CreateAPIKeyParams{
		UserID:    rec.UserID,
		Name:      rec.Name,
		KeyPrefix: rec.KeyPrefix,
		KeyHash:   rec.KeyHash,
		Policies:  rawPolicies,
		Enabled:   rec.Enabled,
		ExpiresAt: rec.ExpiresAt,
	})
	if err != nil {
		return nil, err
	}
	out, err := toAPIKeyRecord(row)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *pgAPIKeyStore) Update(ctx context.Context, rec APIKeyRecord) (*APIKeyRecord, error) {
	rawPolicies, err := json.Marshal(rec.Policies)
	if err != nil {
		return nil, err
	}
	row, err := s.q.UpdateAPIKey(ctx, sqlcgen.UpdateAPIKeyParams{
		UserID:    rec.UserID,
		ID:        rec.ID,
		Name:      rec.Name,
		Policies:  rawPolicies,
		Enabled:   rec.Enabled,
		ExpiresAt: rec.ExpiresAt,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out, err := toAPIKeyRecord(row)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *pgAPIKeyStore) Rotate(ctx context.Context, userID, id int64, keyPrefix, keyHash string) (*APIKeyRecord, error) {
	row, err := s.q.RotateAPIKey(ctx, sqlcgen.RotateAPIKeyParams{
		UserID:    userID,
		ID:        id,
		KeyPrefix: keyPrefix,
		KeyHash:   keyHash,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out, err := toAPIKeyRecord(row)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *pgAPIKeyStore) TouchUsed(ctx context.Context, id int64) error {
	return s.q.TouchAPIKeyUsed(ctx, id)
}

func (s *pgAPIKeyStore) Delete(ctx context.Context, userID, id int64) error {
	return s.q.DeleteAPIKey(ctx, sqlcgen.DeleteAPIKeyParams{UserID: userID, ID: id})
}

// --- Service Methods ---

func generatePlainAPIKey() (plain string, prefix string, hash string, err error) {
	suffix, err := crypto.RandomToken(24)
	if err != nil {
		return "", "", "", err
	}
	plain = apiKeyPrefix + suffix
	prefix = plain
	if len(prefix) > 12 {
		prefix = prefix[:12]
	}
	return plain, prefix, crypto.SHA256Hex(plain), nil
}

func toAPIKeyView(rec APIKeyRecord) APIKeyView {
	policies := rec.Policies
	if policies == nil {
		policies = []PolicyRule{}
	}
	return APIKeyView{
		ID:         rec.ID,
		Name:       rec.Name,
		KeyPrefix:  rec.KeyPrefix,
		Policies:   policies,
		Enabled:    rec.Enabled,
		ExpiresAt:  rec.ExpiresAt,
		LastUsedAt: rec.LastUsedAt,
		CreatedAt:  rec.CreatedAt,
		UpdatedAt:  rec.UpdatedAt,
	}
}

func (s *Service) validateAPIKeyInput(in UpsertAPIKeyInput) (string, []PolicyRule, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return "", nil, httpx.BadRequest("API Key 名称不能为空")
	}
	if len([]rune(name)) > 100 {
		return "", nil, httpx.BadRequest("API Key 名称不能超过 100 个字符")
	}
	if len(in.Policies) == 0 {
		return "", nil, httpx.BadRequest("至少需要配置一条权限策略")
	}

	mergedOrder := make([]string, 0, len(in.Policies))
	mergedRes := make(map[string][]string, len(in.Policies))

	for _, rule := range in.Policies {
		permKey := strings.TrimSpace(rule.Permission)
		def, ok := s.permReg.Get(permKey)
		if !ok {
			return "", nil, httpx.BadRequest("未知的权限标识: " + permKey)
		}

		var normalized []string
		if def.ResourceType == "" {
			normalized = []string{"*"}
		} else {
			if len(rule.Resources) == 0 {
				return "", nil, httpx.BadRequest(fmt.Sprintf("权限 %q 需要选择「全部资源 (*)」或至少一个指定资源", permKey))
			}
			hasWildcard := false
			seen := make(map[string]struct{}, len(rule.Resources))
			for _, rawRes := range rule.Resources {
				res := strings.TrimSpace(rawRes)
				if res == "" {
					continue
				}
				if res == "*" {
					hasWildcard = true
					break
				}
				if _, dup := seen[res]; !dup {
					seen[res] = struct{}{}
					normalized = append(normalized, res)
				}
			}
			if hasWildcard {
				normalized = []string{"*"}
			} else if len(normalized) == 0 {
				return "", nil, httpx.BadRequest(fmt.Sprintf("权限 %q 的资源范围不能为空", permKey))
			}
		}

		if existing, exists := mergedRes[permKey]; exists {
			if len(existing) == 1 && existing[0] == "*" {
				continue
			}
			if len(normalized) == 1 && normalized[0] == "*" {
				mergedRes[permKey] = []string{"*"}
				continue
			}
			seen := make(map[string]struct{}, len(existing)+len(normalized))
			combined := make([]string, 0, len(existing)+len(normalized))
			for _, item := range append(existing, normalized...) {
				if _, dup := seen[item]; !dup {
					seen[item] = struct{}{}
					combined = append(combined, item)
				}
			}
			mergedRes[permKey] = combined
		} else {
			mergedOrder = append(mergedOrder, permKey)
			mergedRes[permKey] = normalized
		}
	}

	out := make([]PolicyRule, 0, len(mergedOrder))
	for _, permKey := range mergedOrder {
		out = append(out, PolicyRule{
			Permission: permKey,
			Resources:  mergedRes[permKey],
		})
	}
	return name, out, nil
}

func (s *Service) ListAPIKeys(ctx context.Context, userID int64) ([]APIKeyView, error) {
	if s.apiKeys == nil {
		return []APIKeyView{}, nil
	}
	recs, err := s.apiKeys.List(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询 API Key 列表失败", err)
	}
	out := make([]APIKeyView, 0, len(recs))
	for _, rec := range recs {
		out = append(out, toAPIKeyView(rec))
	}
	return out, nil
}

func (s *Service) CreateAPIKey(ctx context.Context, userID int64, in UpsertAPIKeyInput) (*CreateAPIKeyResponse, error) {
	if s.apiKeys == nil {
		return nil, httpx.Internal("API Key 存储未初始化", nil)
	}
	name, policies, err := s.validateAPIKeyInput(in)
	if err != nil {
		return nil, err
	}
	plain, prefix, hash, err := generatePlainAPIKey()
	if err != nil {
		return nil, httpx.Internal("生成 API Key 失败", err)
	}
	created, err := s.apiKeys.Create(ctx, APIKeyRecord{
		UserID:    userID,
		Name:      name,
		KeyPrefix: prefix,
		KeyHash:   hash,
		Policies:  policies,
		Enabled:   in.Enabled,
		ExpiresAt: in.ExpiresAt,
	})
	if err != nil {
		return nil, httpx.Internal("创建 API Key 失败", err)
	}
	return &CreateAPIKeyResponse{
		APIKey:   toAPIKeyView(*created),
		PlainKey: plain,
	}, nil
}

func (s *Service) UpdateAPIKey(ctx context.Context, userID, id int64, in UpsertAPIKeyInput) (*APIKeyView, error) {
	if s.apiKeys == nil {
		return nil, httpx.Internal("API Key 存储未初始化", nil)
	}
	name, policies, err := s.validateAPIKeyInput(in)
	if err != nil {
		return nil, err
	}
	updated, err := s.apiKeys.Update(ctx, APIKeyRecord{
		ID:        id,
		UserID:    userID,
		Name:      name,
		Policies:  policies,
		Enabled:   in.Enabled,
		ExpiresAt: in.ExpiresAt,
	})
	if err != nil {
		return nil, httpx.Internal("更新 API Key 失败", err)
	}
	if updated == nil {
		return nil, httpx.NotFound("API Key 不存在")
	}
	view := toAPIKeyView(*updated)
	return &view, nil
}

func (s *Service) RotateAPIKey(ctx context.Context, userID, id int64) (*CreateAPIKeyResponse, error) {
	if s.apiKeys == nil {
		return nil, httpx.Internal("API Key 存储未初始化", nil)
	}
	plain, prefix, hash, err := generatePlainAPIKey()
	if err != nil {
		return nil, httpx.Internal("生成新 API Key 失败", err)
	}
	updated, err := s.apiKeys.Rotate(ctx, userID, id, prefix, hash)
	if err != nil {
		return nil, httpx.Internal("轮换 API Key 失败", err)
	}
	if updated == nil {
		return nil, httpx.NotFound("API Key 不存在")
	}
	return &CreateAPIKeyResponse{
		APIKey:   toAPIKeyView(*updated),
		PlainKey: plain,
	}, nil
}

func (s *Service) DeleteAPIKey(ctx context.Context, userID, id int64) error {
	if s.apiKeys == nil {
		return httpx.Internal("API Key 存储未初始化", nil)
	}
	if err := s.apiKeys.Delete(ctx, userID, id); err != nil {
		return httpx.Internal("删除 API Key 失败", err)
	}
	return nil
}

func (s *Service) authenticateAPIKey(ctx context.Context, rawKey string) (*Principal, error) {
	rawKey = strings.TrimSpace(rawKey)
	if rawKey == "" || !strings.HasPrefix(rawKey, apiKeyPrefix) || s.apiKeys == nil {
		return nil, httpx.Unauthorized("API Key 无效")
	}
	rec, err := s.apiKeys.FindByHash(ctx, crypto.SHA256Hex(rawKey))
	if err != nil {
		return nil, httpx.Internal("校验 API Key 失败", err)
	}
	if rec == nil || !rec.Enabled {
		return nil, httpx.Unauthorized("API Key 无效或已停用")
	}
	if rec.ExpiresAt != nil && !rec.ExpiresAt.After(time.Now()) {
		return nil, httpx.Unauthorized("API Key 已过期")
	}
	user, err := s.store.FindByID(ctx, rec.UserID)
	if err != nil {
		return nil, httpx.Internal("查询用户失败", err)
	}
	if user == nil {
		return nil, httpx.Unauthorized("用户不存在")
	}
	_ = s.apiKeys.TouchUsed(ctx, rec.ID)
	return &Principal{
		User:       user,
		Kind:       PrincipalAPIKey,
		APIKeyID:   rec.ID,
		Policies:   rec.Policies,
		Authorized: false, // fail-closed until route's RequirePermission approves it
	}, nil
}

// --- HTTP Handlers (OIDC Session Only) ---

func (s *Service) maxBodyBytes() int64 {
	if s.cfg != nil && s.cfg.RequestMaxBodyBytes > 0 {
		return s.cfg.RequestMaxBodyBytes
	}
	return 1 << 20
}

func (s *Service) handleAPIKeySchema(w http.ResponseWriter, r *http.Request) error {
	userID, ok := UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	items, err := s.permReg.SchemaForUser(r.Context(), userID)
	if err != nil {
		return httpx.Internal("加载权限定义失败", err)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"permissions": items})
	return nil
}

func (s *Service) handleListAPIKeys(w http.ResponseWriter, r *http.Request) error {
	userID, ok := UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	items, err := s.ListAPIKeys(r.Context(), userID)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"api_keys": items})
	return nil
}

func (s *Service) handleCreateAPIKey(w http.ResponseWriter, r *http.Request) error {
	userID, ok := UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertAPIKeyInput
	if err := httpx.DecodeJSON(w, r, s.maxBodyBytes(), &in); err != nil {
		return err
	}
	resp, err := s.CreateAPIKey(r.Context(), userID, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, resp)
	return nil
}

func (s *Service) handleUpdateAPIKey(w http.ResponseWriter, r *http.Request) error {
	userID, ok := UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseAPIKeyID(r)
	if err != nil {
		return err
	}
	var in UpsertAPIKeyInput
	if err := httpx.DecodeJSON(w, r, s.maxBodyBytes(), &in); err != nil {
		return err
	}
	view, err := s.UpdateAPIKey(r.Context(), userID, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"api_key": view})
	return nil
}

func (s *Service) handleRotateAPIKey(w http.ResponseWriter, r *http.Request) error {
	userID, ok := UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseAPIKeyID(r)
	if err != nil {
		return err
	}
	resp, err := s.RotateAPIKey(r.Context(), userID, id)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, resp)
	return nil
}

func (s *Service) handleDeleteAPIKey(w http.ResponseWriter, r *http.Request) error {
	userID, ok := UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseAPIKeyID(r)
	if err != nil {
		return err
	}
	if err := s.DeleteAPIKey(r.Context(), userID, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func parseAPIKeyID(r *http.Request) (int64, error) {
	raw := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, httpx.BadRequest("无效的 API Key ID")
	}
	return id, nil
}
