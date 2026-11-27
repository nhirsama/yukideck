CREATE TABLE IF NOT EXISTS clipboard_items (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content     TEXT NOT NULL DEFAULT '',
    byte_size   INT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
    starred     BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INT NOT NULL DEFAULT 0,
    version     BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clipboard_items_user_updated
    ON clipboard_items(user_id, starred DESC, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_clipboard_items_user_sort
    ON clipboard_items(user_id, starred DESC, sort_order ASC, id DESC);
CREATE INDEX IF NOT EXISTS idx_clipboard_items_expires
    ON clipboard_items(expires_at);
