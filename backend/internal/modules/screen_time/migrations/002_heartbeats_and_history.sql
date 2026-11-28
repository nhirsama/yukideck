ALTER TABLE screen_time_configs
    ADD COLUMN IF NOT EXISTS timeout_minutes INT NOT NULL DEFAULT 15 CHECK (timeout_minutes BETWEEN 1 AND 120),
    ADD COLUMN IF NOT EXISTS history_imported_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS screen_time_heartbeats (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stat_date    DATE NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL,
    project      TEXT NOT NULL DEFAULT '',
    language     TEXT NOT NULL DEFAULT '',
    editor       TEXT NOT NULL DEFAULT '',
    os           TEXT NOT NULL DEFAULT '',
    category     TEXT NOT NULL DEFAULT '',
    machine      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_screen_time_heartbeats_user_date
    ON screen_time_heartbeats(user_id, stat_date, heartbeat_at ASC);

CREATE INDEX IF NOT EXISTS idx_screen_time_heartbeats_user_time
    ON screen_time_heartbeats(user_id, heartbeat_at DESC);
