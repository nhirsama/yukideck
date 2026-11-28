package auth

import "time"

type User struct {
	ID              int64    `json:"id"`
	OIDCSub         string   `json:"-"`
	Username        string   `json:"username"`
	Email           string   `json:"email"`
	AvatarURL       string   `json:"avatar_url"`
	Timezone        string   `json:"timezone"`
	DisabledModules []string `json:"disabled_modules"`
}

// UpdateUserPreferencesInput updates user-scoped platform preferences (global default timezone & module toggles).
type UpdateUserPreferencesInput struct {
	Timezone        *string   `json:"timezone,omitempty"`
	DisabledModules *[]string `json:"disabled_modules,omitempty"`
}

// ResourceOption represents a selectable module-owned resource exposed for fine-grained API Key policies.
type ResourceOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// PermissionDef describes a single fine-grained capability exposed by a platform service or module.
type PermissionDef struct {
	Key           string `json:"key"`
	ModuleID      string `json:"module_id"`
	ModuleName    string `json:"module_name"`
	Label         string `json:"label"`
	Description   string `json:"description"`
	ResourceType  string `json:"resource_type,omitempty"`
	AllowQueryKey bool   `json:"allow_query_key"`
}

// PermissionSchemaItem combines a PermissionDef with user-scoped resource options for the UI policy editor.
type PermissionSchemaItem struct {
	Key           string           `json:"key"`
	ModuleID      string           `json:"module_id"`
	ModuleName    string           `json:"module_name"`
	Label         string           `json:"label"`
	Description   string           `json:"description"`
	ResourceType  string           `json:"resource_type,omitempty"`
	AllowQueryKey bool             `json:"allow_query_key"`
	Resources     []ResourceOption `json:"resources"`
}

// PolicyRule is a Cloudflare-style permission statement attached to an API Key.
type PolicyRule struct {
	Permission string   `json:"permission"`
	Resources  []string `json:"resources"`
}

type APIKeyView struct {
	ID         int64        `json:"id"`
	Name       string       `json:"name"`
	KeyPrefix  string       `json:"key_prefix"`
	Policies   []PolicyRule `json:"policies"`
	Enabled    bool         `json:"enabled"`
	ExpiresAt  *time.Time   `json:"expires_at,omitempty"`
	LastUsedAt *time.Time   `json:"last_used_at,omitempty"`
	CreatedAt  time.Time    `json:"created_at"`
	UpdatedAt  time.Time    `json:"updated_at"`
}

type CreateAPIKeyResponse struct {
	APIKey   APIKeyView `json:"api_key"`
	PlainKey string     `json:"plain_key"`
}

type UpsertAPIKeyInput struct {
	Name      string       `json:"name"`
	Policies  []PolicyRule `json:"policies"`
	Enabled   bool         `json:"enabled"`
	ExpiresAt *time.Time   `json:"expires_at,omitempty"`
}
