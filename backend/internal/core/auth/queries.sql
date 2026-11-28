-- name: UpsertUserByOIDCSub :one
INSERT INTO users (oidc_sub, username, email, avatar_url)
VALUES ($1, $2, $3, $4)
ON CONFLICT (oidc_sub) DO UPDATE
SET username = EXCLUDED.username,
    email = EXCLUDED.email,
    avatar_url = EXCLUDED.avatar_url,
    updated_at = NOW()
RETURNING id, oidc_sub, username, email, avatar_url, timezone, disabled_modules;

-- name: FindUserByID :one
SELECT id, oidc_sub, username, email, avatar_url, timezone, disabled_modules
FROM users
WHERE id = $1;

-- name: UpdateUserPreferences :one
UPDATE users
SET timezone = $2,
    disabled_modules = $3,
    updated_at = NOW()
WHERE id = $1
RETURNING id, oidc_sub, username, email, avatar_url, timezone, disabled_modules;

-- name: ListAPIKeys :many
SELECT id, user_id, name, key_prefix, key_hash, policies, enabled, expires_at, last_used_at, created_at, updated_at
FROM api_keys
WHERE user_id = $1
ORDER BY id DESC;

-- name: GetAPIKey :one
SELECT id, user_id, name, key_prefix, key_hash, policies, enabled, expires_at, last_used_at, created_at, updated_at
FROM api_keys
WHERE user_id = $1 AND id = $2;

-- name: FindAPIKeyByHash :one
SELECT id, user_id, name, key_prefix, key_hash, policies, enabled, expires_at, last_used_at, created_at, updated_at
FROM api_keys
WHERE key_hash = $1;

-- name: CreateAPIKey :one
INSERT INTO api_keys (user_id, name, key_prefix, key_hash, policies, enabled, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, user_id, name, key_prefix, key_hash, policies, enabled, expires_at, last_used_at, created_at, updated_at;

-- name: UpdateAPIKey :one
UPDATE api_keys
SET name = $3,
    policies = $4,
    enabled = $5,
    expires_at = $6,
    updated_at = NOW()
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, name, key_prefix, key_hash, policies, enabled, expires_at, last_used_at, created_at, updated_at;

-- name: RotateAPIKey :one
UPDATE api_keys
SET key_prefix = $3,
    key_hash = $4,
    updated_at = NOW()
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, name, key_prefix, key_hash, policies, enabled, expires_at, last_used_at, created_at, updated_at;

-- name: TouchAPIKeyUsed :exec
UPDATE api_keys
SET last_used_at = NOW()
WHERE id = $1;

-- name: DeleteAPIKey :exec
DELETE FROM api_keys
WHERE user_id = $1 AND id = $2;
