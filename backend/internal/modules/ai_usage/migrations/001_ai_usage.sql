CREATE TABLE IF NOT EXISTS ai_usage_hourly_sessions (
    id                    BIGSERIAL PRIMARY KEY,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id             TEXT NOT NULL,
    agent                 TEXT NOT NULL,
    session_id            TEXT NOT NULL,
    hour_bucket           TIMESTAMPTZ NOT NULL,
    model                 TEXT NOT NULL,
    is_subagent           BOOLEAN NOT NULL DEFAULT FALSE,
    parent_session_id     TEXT NOT NULL DEFAULT '',
    provider              TEXT NOT NULL DEFAULT '',
    project               TEXT NOT NULL DEFAULT '',
    input_tokens          BIGINT NOT NULL DEFAULT 0,
    output_tokens         BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens    BIGINT NOT NULL DEFAULT 0,
    cache_write_1h_tokens BIGINT NOT NULL DEFAULT 0,
    reasoning_tokens      BIGINT NOT NULL DEFAULT 0,
    max_context_tokens    BIGINT NOT NULL DEFAULT 0,
    reported_cost_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
    request_count         INT NOT NULL DEFAULT 0,
    tool_call_count       INT NOT NULL DEFAULT 0,
    tool_calls            JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_event_at        TIMESTAMPTZ NOT NULL,
    last_event_at         TIMESTAMPTZ NOT NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, device_id, agent, session_id, hour_bucket, model, is_subagent)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_hourly_user_bucket
    ON ai_usage_hourly_sessions (user_id, hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_hourly_user_agent_bucket
    ON ai_usage_hourly_sessions (user_id, agent, hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_hourly_user_session
    ON ai_usage_hourly_sessions (user_id, device_id, session_id);

CREATE INDEX IF NOT EXISTS idx_ai_usage_hourly_user_parent
    ON ai_usage_hourly_sessions (user_id, device_id, parent_session_id)
    WHERE parent_session_id <> '';

CREATE TABLE IF NOT EXISTS ai_usage_devices (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id         TEXT NOT NULL,
    name              TEXT NOT NULL DEFAULT '',
    os                TEXT NOT NULL DEFAULT '',
    arch              TEXT NOT NULL DEFAULT '',
    hostname          TEXT NOT NULL DEFAULT '',
    collector_version TEXT NOT NULL DEFAULT '',
    last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    hidden            BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_devices_user
    ON ai_usage_devices (user_id, hidden, last_synced_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage_model_aliases (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_pattern   TEXT NOT NULL,
    canonical_model TEXT NOT NULL,
    priority        INT NOT NULL DEFAULT 100,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, match_pattern)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_model_aliases_user
    ON ai_usage_model_aliases (user_id, priority ASC, id ASC);

CREATE TABLE IF NOT EXISTS ai_usage_model_prices (
    id                 BIGSERIAL PRIMARY KEY,
    user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_pattern      TEXT NOT NULL,
    input_per_m        DOUBLE PRECISION NOT NULL DEFAULT 0,
    output_per_m       DOUBLE PRECISION NOT NULL DEFAULT 0,
    cache_read_per_m   DOUBLE PRECISION NOT NULL DEFAULT 0,
    cache_write_per_m  DOUBLE PRECISION NOT NULL DEFAULT 0,
    cache_write_1h_per_m DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, model_pattern)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_model_prices_user
    ON ai_usage_model_prices (user_id, model_pattern);
