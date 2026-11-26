-- User settings

-- name: InsertDefaultUserSettings :exec
INSERT INTO assets_user_settings (user_id)
VALUES ($1)
ON CONFLICT (user_id) DO NOTHING;

-- name: GetUserSettings :one
SELECT user_id, display_currency, cost_period, exclude_retired, hide_amounts, default_view, seeded_categories, updated_at
FROM assets_user_settings
WHERE user_id = $1;

-- name: MarkCategoriesSeeded :exec
UPDATE assets_user_settings
SET seeded_categories = TRUE, updated_at = NOW()
WHERE user_id = $1;

-- name: UpsertUserSettings :one
INSERT INTO assets_user_settings (
    user_id, display_currency, cost_period, exclude_retired, hide_amounts, default_view, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, NOW())
ON CONFLICT (user_id) DO UPDATE SET
    display_currency = EXCLUDED.display_currency,
    cost_period      = EXCLUDED.cost_period,
    exclude_retired  = EXCLUDED.exclude_retired,
    hide_amounts     = EXCLUDED.hide_amounts,
    default_view     = EXCLUDED.default_view,
    updated_at       = NOW()
RETURNING user_id, display_currency, cost_period, exclude_retired, hide_amounts, default_view, seeded_categories, updated_at;

-- Categories

-- name: ListCategories :many
SELECT id, user_id, parent_id, name, icon, sort_order, created_at, updated_at
FROM assets_categories
WHERE user_id = $1
ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC;

-- name: GetCategory :one
SELECT id, user_id, parent_id, name, icon, sort_order, created_at, updated_at
FROM assets_categories
WHERE user_id = $1 AND id = $2;

-- name: CountChildCategories :one
SELECT COUNT(*)
FROM assets_categories
WHERE user_id = $1 AND parent_id = $2;

-- name: MaxCategorySortOrder :one
SELECT COALESCE(MAX(sort_order), -1)::int
FROM assets_categories
WHERE user_id = $1
  AND ((parent_id IS NULL AND sqlc.narg('parent_id')::bigint IS NULL) OR parent_id = sqlc.narg('parent_id')::bigint);

-- name: CreateCategory :one
INSERT INTO assets_categories (user_id, parent_id, name, icon, sort_order)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, user_id, parent_id, name, icon, sort_order, created_at, updated_at;

-- name: UpdateCategory :one
UPDATE assets_categories
SET parent_id = $3, name = $4, icon = $5, updated_at = NOW()
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, parent_id, name, icon, sort_order, created_at, updated_at;

-- name: UpdateCategorySortOrder :exec
UPDATE assets_categories
SET sort_order = $3, updated_at = NOW()
WHERE user_id = $1 AND id = $2;

-- name: DeleteCategory :execrows
DELETE FROM assets_categories
WHERE user_id = $1 AND id = $2;

-- Tags

-- name: ListTags :many
SELECT id, user_id, name, color, created_at
FROM assets_tags
WHERE user_id = $1
ORDER BY name ASC, id ASC;

-- name: ListTagsByIDs :many
SELECT id, user_id, name, color, created_at
FROM assets_tags
WHERE user_id = $1 AND id = ANY($2::bigint[]);

-- name: CreateTag :one
INSERT INTO assets_tags (user_id, name, color)
VALUES ($1, $2, $3)
RETURNING id, user_id, name, color, created_at;

-- name: UpdateTag :one
UPDATE assets_tags
SET name = $3, color = $4
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, name, color, created_at;

-- name: DeleteTag :execrows
DELETE FROM assets_tags
WHERE user_id = $1 AND id = $2;

-- Channels

-- name: ListChannels :many
SELECT id, user_id, name, created_at
FROM assets_channels
WHERE user_id = $1
ORDER BY name ASC, id ASC;

-- name: GetChannel :one
SELECT id, user_id, name, created_at
FROM assets_channels
WHERE user_id = $1 AND id = $2;

-- name: CreateChannel :one
INSERT INTO assets_channels (user_id, name)
VALUES ($1, $2)
RETURNING id, user_id, name, created_at;

-- name: UpdateChannel :one
UPDATE assets_channels
SET name = $3
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, name, created_at;

-- name: DeleteChannel :execrows
DELETE FROM assets_channels
WHERE user_id = $1 AND id = $2;

-- Locations

-- name: ListLocations :many
SELECT id, user_id, name, created_at
FROM assets_locations
WHERE user_id = $1
ORDER BY name ASC, id ASC;

-- name: GetLocation :one
SELECT id, user_id, name, created_at
FROM assets_locations
WHERE user_id = $1 AND id = $2;

-- name: CreateLocation :one
INSERT INTO assets_locations (user_id, name)
VALUES ($1, $2)
RETURNING id, user_id, name, created_at;

-- name: UpdateLocation :one
UPDATE assets_locations
SET name = $3
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, name, created_at;

-- name: DeleteLocation :execrows
DELETE FROM assets_locations
WHERE user_id = $1 AND id = $2;

-- Items

-- name: ListItems :many
SELECT
    id, user_id, parent_id, category_id, channel_id, location_id,
    name, icon, image_url, price_cents, currency, purchased_at,
    pricing_mode, status, expected_retire_at, warranty_until, usage_count,
    retired_at, retire_reason, sold_price_cents, sold_currency, retire_note,
    note, sort_order, created_at, updated_at
FROM assets_items
WHERE user_id = $1
ORDER BY sort_order ASC, id ASC;

-- name: GetItem :one
SELECT
    id, user_id, parent_id, category_id, channel_id, location_id,
    name, icon, image_url, price_cents, currency, purchased_at,
    pricing_mode, status, expected_retire_at, warranty_until, usage_count,
    retired_at, retire_reason, sold_price_cents, sold_currency, retire_note,
    note, sort_order, created_at, updated_at
FROM assets_items
WHERE user_id = $1 AND id = $2;

-- name: MaxItemSortOrder :one
SELECT COALESCE(MAX(sort_order), -1)::int
FROM assets_items
WHERE user_id = $1;

-- name: CreateItem :one
INSERT INTO assets_items (
    user_id, parent_id, category_id, channel_id, location_id,
    name, icon, image_url, price_cents, currency, purchased_at,
    pricing_mode, status, expected_retire_at, warranty_until, usage_count,
    note, sort_order
) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9, $10, $11,
    $12, $13, $14, $15, $16,
    $17, $18
)
RETURNING
    id, user_id, parent_id, category_id, channel_id, location_id,
    name, icon, image_url, price_cents, currency, purchased_at,
    pricing_mode, status, expected_retire_at, warranty_until, usage_count,
    retired_at, retire_reason, sold_price_cents, sold_currency, retire_note,
    note, sort_order, created_at, updated_at;

-- name: UpdateItem :one
UPDATE assets_items
SET
    parent_id          = $3,
    category_id        = $4,
    channel_id         = $5,
    location_id        = $6,
    name               = $7,
    icon               = $8,
    image_url          = $9,
    price_cents        = $10,
    currency           = $11,
    purchased_at       = $12,
    pricing_mode       = $13,
    status             = $14,
    expected_retire_at = $15,
    warranty_until     = $16,
    usage_count        = $17,
    note               = $18,
    updated_at         = NOW()
WHERE user_id = $1 AND id = $2
RETURNING
    id, user_id, parent_id, category_id, channel_id, location_id,
    name, icon, image_url, price_cents, currency, purchased_at,
    pricing_mode, status, expected_retire_at, warranty_until, usage_count,
    retired_at, retire_reason, sold_price_cents, sold_currency, retire_note,
    note, sort_order, created_at, updated_at;

-- name: DeleteItem :execrows
DELETE FROM assets_items
WHERE user_id = $1 AND id = $2;

-- name: AdjustItemUsageCount :one
UPDATE assets_items
SET usage_count = GREATEST(0, usage_count + $3), updated_at = NOW()
WHERE user_id = $1 AND id = $2
RETURNING
    id, user_id, parent_id, category_id, channel_id, location_id,
    name, icon, image_url, price_cents, currency, purchased_at,
    pricing_mode, status, expected_retire_at, warranty_until, usage_count,
    retired_at, retire_reason, sold_price_cents, sold_currency, retire_note,
    note, sort_order, created_at, updated_at;

-- name: RetireItem :one
UPDATE assets_items
SET
    status           = 'retired',
    retired_at       = $3,
    retire_reason    = $4,
    sold_price_cents = $5,
    sold_currency    = $6,
    retire_note      = $7,
    updated_at       = NOW()
WHERE user_id = $1 AND id = $2
RETURNING
    id, user_id, parent_id, category_id, channel_id, location_id,
    name, icon, image_url, price_cents, currency, purchased_at,
    pricing_mode, status, expected_retire_at, warranty_until, usage_count,
    retired_at, retire_reason, sold_price_cents, sold_currency, retire_note,
    note, sort_order, created_at, updated_at;

-- name: UnretireItem :one
UPDATE assets_items
SET
    status           = 'active',
    retired_at       = NULL,
    retire_reason    = '',
    sold_price_cents = 0,
    sold_currency    = 'CNY',
    retire_note      = '',
    updated_at       = NOW()
WHERE user_id = $1 AND id = $2
RETURNING
    id, user_id, parent_id, category_id, channel_id, location_id,
    name, icon, image_url, price_cents, currency, purchased_at,
    pricing_mode, status, expected_retire_at, warranty_until, usage_count,
    retired_at, retire_reason, sold_price_cents, sold_currency, retire_note,
    note, sort_order, created_at, updated_at;

-- name: UpdateItemSortOrder :exec
UPDATE assets_items
SET sort_order = $3, updated_at = NOW()
WHERE user_id = $1 AND id = $2;

-- name: BatchSetItemCategory :execrows
UPDATE assets_items
SET category_id = $2, updated_at = NOW()
WHERE user_id = $1 AND id = ANY($3::bigint[]);

-- name: BatchRetireItems :execrows
UPDATE assets_items
SET
    status        = 'retired',
    retired_at    = $2,
    retire_reason = $3,
    retire_note   = $4,
    updated_at    = NOW()
WHERE user_id = $1 AND id = ANY($5::bigint[]);

-- name: BatchDeleteItems :execrows
DELETE FROM assets_items
WHERE user_id = $1 AND id = ANY($2::bigint[]);

-- Item Tags

-- name: ListItemTagsByUser :many
SELECT it.item_id, it.tag_id
FROM assets_item_tags it
JOIN assets_items i ON i.id = it.item_id
WHERE i.user_id = $1;

-- name: ListItemTagIDs :many
SELECT tag_id
FROM assets_item_tags
WHERE item_id = $1;

-- name: DeleteItemTags :exec
DELETE FROM assets_item_tags
WHERE item_id = $1;

-- name: InsertItemTag :exec
INSERT INTO assets_item_tags (item_id, tag_id)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- Transactions

-- name: ListTransactionsByUser :many
SELECT id, user_id, item_id, type, amount_cents, currency, occurred_at, include_in_cost, note, created_at
FROM assets_transactions
WHERE user_id = $1
ORDER BY occurred_at DESC, id DESC;

-- name: ListTransactionsByItem :many
SELECT id, user_id, item_id, type, amount_cents, currency, occurred_at, include_in_cost, note, created_at
FROM assets_transactions
WHERE user_id = $1 AND item_id = $2
ORDER BY occurred_at DESC, id DESC;

-- name: CreateTransaction :one
INSERT INTO assets_transactions (user_id, item_id, type, amount_cents, currency, occurred_at, include_in_cost, note)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, user_id, item_id, type, amount_cents, currency, occurred_at, include_in_cost, note, created_at;

-- name: UpdateTransaction :one
UPDATE assets_transactions
SET type = $4, amount_cents = $5, currency = $6, occurred_at = $7, include_in_cost = $8, note = $9
WHERE user_id = $1 AND item_id = $2 AND id = $3
RETURNING id, user_id, item_id, type, amount_cents, currency, occurred_at, include_in_cost, note, created_at;

-- name: DeleteTransaction :execrows
DELETE FROM assets_transactions
WHERE user_id = $1 AND item_id = $2 AND id = $3;

-- Exchange Rates

-- name: ListExchangeRates :many
SELECT base_currency, quote_currency, rate, source, fetched_at
FROM assets_exchange_rates
WHERE base_currency = $1;

-- name: UpsertExchangeRate :exec
INSERT INTO assets_exchange_rates (base_currency, quote_currency, rate, source, fetched_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (base_currency, quote_currency) DO UPDATE SET
    rate       = EXCLUDED.rate,
    source     = EXCLUDED.source,
    fetched_at = EXCLUDED.fetched_at;
