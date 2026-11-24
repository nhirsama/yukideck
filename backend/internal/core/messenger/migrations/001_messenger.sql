CREATE TABLE IF NOT EXISTS user_channels (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                TEXT NOT NULL,
    name                TEXT NOT NULL,
    enable_outbound     BOOLEAN NOT NULL DEFAULT TRUE,
    enable_inbound      BOOLEAN NOT NULL DEFAULT FALSE,
    is_default_outbound BOOLEAN NOT NULL DEFAULT FALSE,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    webhook_secret      TEXT NOT NULL DEFAULT '',
    config_enc          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_channels_user_id ON user_channels(user_id);

CREATE TABLE IF NOT EXISTS push_endpoints (
    id                 BIGSERIAL PRIMARY KEY,
    user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    token_hash         TEXT NOT NULL UNIQUE,
    token_enc          TEXT NOT NULL,
    target_mode        TEXT NOT NULL DEFAULT 'default',
    target_channel_ids BIGINT[] NOT NULL DEFAULT '{}',
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    last_called_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_endpoints_user_id ON push_endpoints(user_id);
