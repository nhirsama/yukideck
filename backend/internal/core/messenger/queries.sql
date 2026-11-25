-- name: ListChannels :many
SELECT id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
       enabled, webhook_secret, config_enc, created_at, updated_at
FROM user_channels
WHERE user_id = $1
ORDER BY id ASC;

-- name: GetChannel :one
SELECT id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
       enabled, webhook_secret, config_enc, created_at, updated_at
FROM user_channels
WHERE user_id = $1 AND id = $2;

-- name: GetChannelByID :one
SELECT id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
       enabled, webhook_secret, config_enc, created_at, updated_at
FROM user_channels
WHERE id = $1;

-- name: CreateChannel :one
INSERT INTO user_channels (
    user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
    enabled, webhook_secret, config_enc
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
          enabled, webhook_secret, config_enc, created_at, updated_at;

-- name: UpdateChannel :one
UPDATE user_channels
SET name = $3,
    enable_outbound = $4,
    enable_inbound = $5,
    is_default_outbound = $6,
    enabled = $7,
    webhook_secret = $8,
    config_enc = $9,
    updated_at = NOW()
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
          enabled, webhook_secret, config_enc, created_at, updated_at;

-- name: DeleteChannel :exec
DELETE FROM user_channels
WHERE user_id = $1 AND id = $2;

-- name: ListPushEndpoints :many
SELECT id, user_id, name, target_mode, target_channel_ids,
       enabled, last_called_at, created_at, updated_at, slug
FROM push_endpoints
WHERE user_id = $1
ORDER BY id ASC;

-- name: GetPushEndpoint :one
SELECT id, user_id, name, target_mode, target_channel_ids,
       enabled, last_called_at, created_at, updated_at, slug
FROM push_endpoints
WHERE user_id = $1 AND id = $2;

-- name: GetPushEndpointBySlug :one
SELECT id, user_id, name, target_mode, target_channel_ids,
       enabled, last_called_at, created_at, updated_at, slug
FROM push_endpoints
WHERE user_id = $1 AND slug = $2;

-- name: CreatePushEndpoint :one
INSERT INTO push_endpoints (
    user_id, name, slug, target_mode, target_channel_ids, enabled
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, user_id, name, target_mode, target_channel_ids,
          enabled, last_called_at, created_at, updated_at, slug;

-- name: UpdatePushEndpoint :one
UPDATE push_endpoints
SET name = $3,
    slug = $4,
    target_mode = $5,
    target_channel_ids = $6,
    enabled = $7,
    updated_at = NOW()
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, name, target_mode, target_channel_ids,
          enabled, last_called_at, created_at, updated_at, slug;

-- name: TouchPushEndpointCalled :exec
UPDATE push_endpoints
SET last_called_at = NOW()
WHERE id = $1;

-- name: DeletePushEndpoint :exec
DELETE FROM push_endpoints
WHERE user_id = $1 AND id = $2;
