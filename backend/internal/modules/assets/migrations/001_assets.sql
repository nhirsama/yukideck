-- 1. 用户模块偏好表（每用户一行）
CREATE TABLE IF NOT EXISTS assets_user_settings (
    user_id            BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_currency   TEXT NOT NULL DEFAULT 'CNY' CHECK (display_currency IN ('CNY', 'USD', 'EUR')),
    cost_period        TEXT NOT NULL DEFAULT 'daily' CHECK (cost_period IN ('daily', 'monthly', 'yearly')),
    exclude_retired    BOOLEAN NOT NULL DEFAULT FALSE,
    hide_amounts       BOOLEAN NOT NULL DEFAULT FALSE,
    default_view       TEXT NOT NULL DEFAULT 'card' CHECK (default_view IN ('card', 'list', 'folder')),
    seeded_categories  BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 两级分类表
CREATE TABLE IF NOT EXISTS assets_categories (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id   BIGINT REFERENCES assets_categories(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT 'folder',
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assets_categories_user_sort
    ON assets_categories(user_id, parent_id, sort_order, id);

-- 3. 标签表（扁平多对多）
CREATE TABLE IF NOT EXISTS assets_tags (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- 4. 购买渠道表
CREATE TABLE IF NOT EXISTS assets_channels (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- 5. 存放位置表
CREATE TABLE IF NOT EXISTS assets_locations (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- 6. 物品主表（统一承载顶级物品与子物品）
CREATE TABLE IF NOT EXISTS assets_items (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id           BIGINT REFERENCES assets_items(id) ON DELETE SET NULL,
    category_id         BIGINT REFERENCES assets_categories(id) ON DELETE SET NULL,
    channel_id          BIGINT REFERENCES assets_channels(id) ON DELETE SET NULL,
    location_id         BIGINT REFERENCES assets_locations(id) ON DELETE SET NULL,

    name                TEXT NOT NULL,
    icon                TEXT NOT NULL DEFAULT 'package',
    image_url           TEXT NOT NULL DEFAULT '',

    price_cents         BIGINT NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
    currency            TEXT NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY', 'USD', 'EUR')),
    purchased_at        DATE NOT NULL DEFAULT CURRENT_DATE,

    pricing_mode        TEXT NOT NULL DEFAULT 'time' CHECK (pricing_mode IN ('time', 'usage', 'none')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'favorite', 'retired')),

    expected_retire_at  DATE,
    warranty_until      DATE,
    usage_count         INT NOT NULL DEFAULT 0 CHECK (usage_count >= 0),

    -- 退役处置信息（仅 status = 'retired' 时有效）
    retired_at          DATE,
    retire_reason       TEXT NOT NULL DEFAULT '' CHECK (retire_reason IN ('', 'sold', 'gifted', 'lost', 'expired', 'discarded', 'other')),
    sold_price_cents    BIGINT NOT NULL DEFAULT 0 CHECK (sold_price_cents >= 0),
    sold_currency       TEXT NOT NULL DEFAULT 'CNY' CHECK (sold_currency IN ('CNY', 'USD', 'EUR')),
    retire_note         TEXT NOT NULL DEFAULT '',

    note                TEXT NOT NULL DEFAULT '',
    sort_order          INT NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assets_items_user_sort ON assets_items(user_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_assets_items_user_category ON assets_items(user_id, category_id);
CREATE INDEX IF NOT EXISTS idx_assets_items_user_status ON assets_items(user_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_items_user_parent ON assets_items(user_id, parent_id)
    WHERE parent_id IS NOT NULL;

-- 7. 物品-标签多对多关联表
CREATE TABLE IF NOT EXISTS assets_item_tags (
    item_id  BIGINT NOT NULL REFERENCES assets_items(id) ON DELETE CASCADE,
    tag_id   BIGINT NOT NULL REFERENCES assets_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_assets_item_tags_tag ON assets_item_tags(tag_id);

-- 8. 附加收支明细表
CREATE TABLE IF NOT EXISTS assets_transactions (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id          BIGINT NOT NULL REFERENCES assets_items(id) ON DELETE CASCADE,
    type             TEXT NOT NULL CHECK (type IN ('expense', 'income')),
    amount_cents     BIGINT NOT NULL CHECK (amount_cents >= 0),
    currency         TEXT NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY', 'USD', 'EUR')),
    occurred_at      DATE NOT NULL DEFAULT CURRENT_DATE,
    include_in_cost  BOOLEAN NOT NULL DEFAULT TRUE,
    note             TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assets_transactions_item
    ON assets_transactions(user_id, item_id, occurred_at DESC, id DESC);

-- 9. 全局汇率缓存表（公共市场数据，不按用户隔离）
CREATE TABLE IF NOT EXISTS assets_exchange_rates (
    base_currency   TEXT NOT NULL CHECK (base_currency IN ('CNY', 'USD', 'EUR')),
    quote_currency  TEXT NOT NULL CHECK (quote_currency IN ('CNY', 'USD', 'EUR')),
    rate            DOUBLE PRECISION NOT NULL CHECK (rate > 0),
    source          TEXT NOT NULL DEFAULT 'live',
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (base_currency, quote_currency)
);
