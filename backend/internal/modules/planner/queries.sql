-- name: ListItems :many
SELECT id, user_id, title, note, status,
       target_at, timezone, calendar_type,
       repeat_type, repeat_config, auto_advance,
       remind_offsets, channel_ids, next_trigger_at,
       created_at, updated_at,
       overdue_config, paused, paused_until, retry_state
FROM planner_items
WHERE user_id = $1
ORDER BY
    CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC,
    target_at ASC NULLS LAST,
    id DESC;

-- name: GetItem :one
SELECT id, user_id, title, note, status,
       target_at, timezone, calendar_type,
       repeat_type, repeat_config, auto_advance,
       remind_offsets, channel_ids, next_trigger_at,
       created_at, updated_at,
       overdue_config, paused, paused_until, retry_state
FROM planner_items
WHERE user_id = $1 AND id = $2;

-- name: CreateItem :one
INSERT INTO planner_items (
    user_id, title, note, status,
    target_at, timezone, calendar_type,
    repeat_type, repeat_config, auto_advance,
    remind_offsets, overdue_config, paused, paused_until, retry_state,
    channel_ids, next_trigger_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
RETURNING id, user_id, title, note, status,
          target_at, timezone, calendar_type,
          repeat_type, repeat_config, auto_advance,
          remind_offsets, channel_ids, next_trigger_at,
          created_at, updated_at,
          overdue_config, paused, paused_until, retry_state;

-- name: UpdateItem :one
UPDATE planner_items
SET title = $3,
    note = $4,
    status = $5,
    target_at = $6,
    timezone = $7,
    calendar_type = $8,
    repeat_type = $9,
    repeat_config = $10,
    auto_advance = $11,
    remind_offsets = $12,
    overdue_config = $13,
    paused = $14,
    paused_until = $15,
    retry_state = $16,
    channel_ids = $17,
    next_trigger_at = $18,
    updated_at = NOW()
WHERE user_id = $1 AND id = $2
RETURNING id, user_id, title, note, status,
          target_at, timezone, calendar_type,
          repeat_type, repeat_config, auto_advance,
          remind_offsets, channel_ids, next_trigger_at,
          created_at, updated_at,
          overdue_config, paused, paused_until, retry_state;

-- name: DeleteItem :exec
DELETE FROM planner_items
WHERE user_id = $1 AND id = $2;

-- name: ListDueItems :many
SELECT id, user_id, title, note, status,
       target_at, timezone, calendar_type,
       repeat_type, repeat_config, auto_advance,
       remind_offsets, channel_ids, next_trigger_at,
       created_at, updated_at,
       overdue_config, paused, paused_until, retry_state
FROM planner_items
WHERE status = 'pending'
  AND next_trigger_at IS NOT NULL
  AND next_trigger_at <= $1
ORDER BY next_trigger_at ASC
LIMIT 200;

-- name: MinNextTriggerAt :one
SELECT next_trigger_at
FROM planner_items
WHERE status = 'pending'
  AND next_trigger_at IS NOT NULL
ORDER BY next_trigger_at ASC
LIMIT 1;

-- name: ListSettledTriggerKeys :many
SELECT trigger_key
FROM planner_logs
WHERE item_id = $1
  AND status IN ('ok', 'failed', 'skipped');

-- name: InsertSettledLog :execrows
INSERT INTO planner_logs (
    user_id, item_id, item_title, trigger_key, trigger_label,
    event_type, status, reason, attempt, next_retry_at, error
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (item_id, trigger_key)
    WHERE item_id IS NOT NULL AND status IN ('ok', 'failed', 'skipped')
    DO NOTHING;

-- name: InsertAttemptLog :one
INSERT INTO planner_logs (
    user_id, item_id, item_title, trigger_key, trigger_label,
    event_type, status, reason, attempt, next_retry_at, error
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id;

-- name: PruneUserLogs :exec
DELETE FROM planner_logs l
WHERE l.user_id = $1
  AND l.id NOT IN (
      SELECT p.id
      FROM planner_logs p
      WHERE p.user_id = $1
      ORDER BY p.sent_at DESC, p.id DESC
      LIMIT $2
  );

-- name: ListLogs :many
SELECT id, user_id, item_id, item_title, trigger_key, trigger_label,
       status, error, sent_at,
       event_type, reason, attempt, next_retry_at
FROM planner_logs
WHERE user_id = $1
  AND (sqlc.arg(status)::text = '' OR status = sqlc.arg(status)::text)
ORDER BY sent_at DESC, id DESC
LIMIT $2;
