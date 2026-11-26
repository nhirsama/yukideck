ALTER TABLE planner_items
    ADD COLUMN IF NOT EXISTS overdue_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retry_state JSONB;

ALTER TABLE planner_logs
    ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'reminder',
    ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_planner_logs_dedup;

CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_logs_settled
    ON planner_logs(item_id, trigger_key)
    WHERE item_id IS NOT NULL AND status IN ('ok', 'failed', 'skipped');

DROP INDEX IF EXISTS idx_planner_logs_user_sent;

CREATE INDEX IF NOT EXISTS idx_planner_logs_user_sent
    ON planner_logs(user_id, sent_at DESC, id DESC);
