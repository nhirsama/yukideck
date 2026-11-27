-- name: ListActiveItems :many
SELECT id, user_id, content, byte_size, starred, sort_order, version, expires_at, created_at, updated_at
FROM clipboard_items
WHERE user_id = $1
  AND expires_at > $2
ORDER BY starred DESC, updated_at DESC, id DESC;

-- name: GetActiveItem :one
SELECT id, user_id, content, byte_size, starred, sort_order, version, expires_at, created_at, updated_at
FROM clipboard_items
WHERE id = $1
  AND user_id = $2
  AND expires_at > $3;

-- name: GetMinSortOrder :one
SELECT COALESCE(MIN(sort_order), 0)::INT AS min_sort
FROM clipboard_items
WHERE user_id = $1
  AND expires_at > $2;

-- name: CreateItem :one
INSERT INTO clipboard_items (
    user_id, content, byte_size, starred, sort_order, version, expires_at, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $7)
RETURNING id, user_id, content, byte_size, starred, sort_order, version, expires_at, created_at, updated_at;

-- name: UpdateItemContentWithVersion :one
UPDATE clipboard_items
SET content    = $4,
    byte_size  = $5,
    starred    = $6,
    expires_at = $7,
    version    = version + 1,
    updated_at = $8
WHERE id = $1
  AND user_id = $2
  AND version = $3
  AND expires_at > $8
RETURNING id, user_id, content, byte_size, starred, sort_order, version, expires_at, created_at, updated_at;

-- name: UpdateItemContentForce :one
UPDATE clipboard_items
SET content    = $3,
    byte_size  = $4,
    starred    = $5,
    expires_at = $6,
    version    = version + 1,
    updated_at = $7
WHERE id = $1
  AND user_id = $2
  AND expires_at > $7
RETURNING id, user_id, content, byte_size, starred, sort_order, version, expires_at, created_at, updated_at;

-- name: UpdateItemMeta :one
UPDATE clipboard_items
SET starred    = $3,
    expires_at = $4,
    updated_at = $5
WHERE id = $1
  AND user_id = $2
  AND expires_at > $5
RETURNING id, user_id, content, byte_size, starred, sort_order, version, expires_at, created_at, updated_at;

-- name: DeleteItem :execrows
DELETE FROM clipboard_items
WHERE id = $1
  AND user_id = $2;

-- name: UpdateItemSortOrder :exec
UPDATE clipboard_items
SET sort_order = $3
WHERE id = $1
  AND user_id = $2
  AND expires_at > $4;

-- name: PurgeExpiredItems :execrows
DELETE FROM clipboard_items
WHERE expires_at <= $1;
