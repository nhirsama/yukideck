CREATE TABLE IF NOT EXISTS planner_items (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    note            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending',

    target_at       TIMESTAMPTZ,
    timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    calendar_type   TEXT NOT NULL DEFAULT 'solar',

    repeat_type     TEXT NOT NULL DEFAULT 'none',
    repeat_config   JSONB NOT NULL DEFAULT '{}'::jsonb,
    auto_advance    BOOLEAN NOT NULL DEFAULT TRUE,

    remind_offsets  JSONB NOT NULL DEFAULT '[]'::jsonb,
    channel_ids     BIGINT[] NOT NULL DEFAULT '{}',

    next_trigger_at TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_items_user_id ON planner_items(user_id);

-- Partial B-Tree index excludes all pure todos (next_trigger_at IS NULL) and completed items.
CREATE INDEX IF NOT EXISTS idx_planner_items_due ON planner_items(next_trigger_at)
    WHERE status = 'pending' AND next_trigger_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS planner_logs (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id       BIGINT REFERENCES planner_items(id) ON DELETE SET NULL,
    item_title    TEXT NOT NULL,
    trigger_key   TEXT NOT NULL,
    trigger_label TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    error         TEXT NOT NULL DEFAULT '',
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_logs_user_sent ON planner_logs(user_id, sent_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_logs_dedup ON planner_logs(item_id, trigger_key)
    WHERE item_id IS NOT NULL;
