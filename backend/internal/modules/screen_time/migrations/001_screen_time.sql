CREATE TABLE IF NOT EXISTS screen_time_configs (
    user_id                BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    api_base_url           TEXT NOT NULL DEFAULT 'https://wakatime.com/api/v1',
    api_key_enc            TEXT NOT NULL DEFAULT '',
    api_key_hint           TEXT NOT NULL DEFAULT '',
    wakatime_username      TEXT NOT NULL DEFAULT '',
    last_synced_at         TIMESTAMPTZ,
    last_sync_attempt_at   TIMESTAMPTZ,
    last_synced_date       DATE,
    last_sync_status       TEXT NOT NULL DEFAULT 'idle' CHECK (last_sync_status IN ('idle', 'ok', 'auth_error', 'error')),
    last_sync_error        TEXT NOT NULL DEFAULT '',
    next_scheduled_sync_at TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screen_time_configs_due
    ON screen_time_configs(next_scheduled_sync_at)
    WHERE api_key_enc <> '' AND last_sync_status <> 'auth_error' AND next_scheduled_sync_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS screen_time_daily_totals (
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stat_date     DATE NOT NULL,
    total_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (total_seconds >= 0),
    timezone      TEXT NOT NULL,
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, stat_date)
);

CREATE TABLE IF NOT EXISTS screen_time_daily_dimensions (
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stat_date     DATE NOT NULL,
    dimension     TEXT NOT NULL CHECK (dimension IN ('project', 'language', 'editor', 'os', 'category', 'machine')),
    name          TEXT NOT NULL,
    total_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (total_seconds >= 0),
    PRIMARY KEY (user_id, stat_date, dimension, name)
);

CREATE INDEX IF NOT EXISTS idx_screen_time_daily_dims_lookup
    ON screen_time_daily_dimensions(user_id, dimension, stat_date DESC);

CREATE TABLE IF NOT EXISTS screen_time_durations (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stat_date        DATE NOT NULL,
    started_at       TIMESTAMPTZ NOT NULL,
    duration_seconds DOUBLE PRECISION NOT NULL CHECK (duration_seconds >= 0),
    project          TEXT NOT NULL DEFAULT '',
    color            TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_screen_time_durations_user_date
    ON screen_time_durations(user_id, stat_date, started_at ASC);

CREATE INDEX IF NOT EXISTS idx_screen_time_durations_user_started
    ON screen_time_durations(user_id, started_at DESC);
