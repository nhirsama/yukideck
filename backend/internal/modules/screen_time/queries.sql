-- name: GetConfig :one
SELECT user_id, api_base_url, api_key_enc, api_key_hint, wakatime_username,
       last_synced_at, last_sync_attempt_at, last_synced_date, last_sync_status, last_sync_error,
       next_scheduled_sync_at, created_at, updated_at, timeout_minutes, history_imported_at
FROM screen_time_configs
WHERE user_id = $1;

-- name: UpsertConfig :one
INSERT INTO screen_time_configs (
    user_id, api_base_url, api_key_enc, api_key_hint, wakatime_username,
    timeout_minutes, last_sync_status, last_sync_error, next_scheduled_sync_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (user_id) DO UPDATE
SET api_base_url = EXCLUDED.api_base_url,
    api_key_enc = EXCLUDED.api_key_enc,
    api_key_hint = EXCLUDED.api_key_hint,
    wakatime_username = EXCLUDED.wakatime_username,
    timeout_minutes = EXCLUDED.timeout_minutes,
    last_sync_status = EXCLUDED.last_sync_status,
    last_sync_error = EXCLUDED.last_sync_error,
    next_scheduled_sync_at = EXCLUDED.next_scheduled_sync_at,
    updated_at = NOW()
RETURNING user_id, api_base_url, api_key_enc, api_key_hint, wakatime_username,
          last_synced_at, last_sync_attempt_at, last_synced_date, last_sync_status, last_sync_error,
          next_scheduled_sync_at, created_at, updated_at, timeout_minutes, history_imported_at;

-- name: UpdateSyncOutcome :one
UPDATE screen_time_configs
SET wakatime_username = $2,
    timeout_minutes = $3,
    last_synced_at = $4,
    last_sync_attempt_at = $5,
    last_synced_date = $6,
    last_sync_status = $7,
    last_sync_error = $8,
    next_scheduled_sync_at = $9,
    updated_at = NOW()
WHERE user_id = $1
RETURNING user_id, api_base_url, api_key_enc, api_key_hint, wakatime_username,
          last_synced_at, last_sync_attempt_at, last_synced_date, last_sync_status, last_sync_error,
          next_scheduled_sync_at, created_at, updated_at, timeout_minutes, history_imported_at;

-- name: MarkHistoryImported :exec
UPDATE screen_time_configs
SET history_imported_at = $2,
    updated_at = NOW()
WHERE user_id = $1;

-- name: ListDueScheduledConfigs :many
SELECT c.user_id, c.api_base_url, c.api_key_enc, c.api_key_hint, c.wakatime_username,
       c.timeout_minutes, c.history_imported_at,
       c.last_synced_at, c.last_sync_attempt_at, c.last_synced_date, c.last_sync_status, c.last_sync_error,
       c.next_scheduled_sync_at, c.created_at, c.updated_at,
       u.timezone AS user_timezone
FROM screen_time_configs c
JOIN users u ON u.id = c.user_id
WHERE c.api_key_enc <> ''
  AND c.last_sync_status <> 'auth_error'
  AND c.next_scheduled_sync_at IS NOT NULL
  AND c.next_scheduled_sync_at <= $1
  AND NOT ('screen-time' = ANY(u.disabled_modules))
ORDER BY c.next_scheduled_sync_at ASC;

-- name: UpsertDailyTotal :exec
INSERT INTO screen_time_daily_totals (user_id, stat_date, total_seconds, timezone, synced_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (user_id, stat_date) DO UPDATE
SET total_seconds = EXCLUDED.total_seconds,
    timezone = EXCLUDED.timezone,
    synced_at = NOW();

-- name: UpsertDailyTotalsBatch :batchexec
INSERT INTO screen_time_daily_totals (user_id, stat_date, total_seconds, timezone, synced_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (user_id, stat_date) DO UPDATE
SET total_seconds = EXCLUDED.total_seconds,
    timezone = EXCLUDED.timezone,
    synced_at = NOW();

-- name: GetDailyTotal :one
SELECT user_id, stat_date, total_seconds, timezone, synced_at
FROM screen_time_daily_totals
WHERE user_id = $1 AND stat_date = $2;

-- name: ListDailyTotals :many
SELECT user_id, stat_date, total_seconds, timezone, synced_at
FROM screen_time_daily_totals
WHERE user_id = $1
  AND stat_date >= $2
  AND stat_date <= $3
ORDER BY stat_date ASC;

-- name: ListAllDailyTotals :many
SELECT user_id, stat_date, total_seconds, timezone, synced_at
FROM screen_time_daily_totals
WHERE user_id = $1
ORDER BY stat_date ASC;

-- name: DeleteDailyDimensionsByDate :exec
DELETE FROM screen_time_daily_dimensions
WHERE user_id = $1 AND stat_date = $2;

-- name: DeleteDailyDimensionsByDates :exec
DELETE FROM screen_time_daily_dimensions
WHERE user_id = $1 AND stat_date = ANY($2::date[]);

-- name: InsertDailyDimension :exec
INSERT INTO screen_time_daily_dimensions (user_id, stat_date, dimension, name, total_seconds)
VALUES ($1, $2, $3, $4, $5);

-- name: CopyDailyDimensions :copyfrom
INSERT INTO screen_time_daily_dimensions (user_id, stat_date, dimension, name, total_seconds)
VALUES ($1, $2, $3, $4, $5);

-- name: ListDailyDimensions :many
SELECT user_id, stat_date, dimension, name, total_seconds
FROM screen_time_daily_dimensions
WHERE user_id = $1
  AND stat_date >= $2
  AND stat_date <= $3
ORDER BY stat_date ASC, total_seconds DESC;

-- name: ListDailyDimensionsByDim :many
SELECT user_id, stat_date, dimension, name, total_seconds
FROM screen_time_daily_dimensions
WHERE user_id = $1
  AND dimension = $2
  AND stat_date >= $3
  AND stat_date <= $4
ORDER BY stat_date ASC, total_seconds DESC;

-- name: DeleteDurationsByDate :exec
DELETE FROM screen_time_durations
WHERE user_id = $1 AND stat_date = $2;

-- name: DeleteDurationsByDates :exec
DELETE FROM screen_time_durations
WHERE user_id = $1 AND stat_date = ANY($2::date[]);

-- name: InsertDuration :exec
INSERT INTO screen_time_durations (user_id, stat_date, started_at, duration_seconds, project, color)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: CopyDurations :copyfrom
INSERT INTO screen_time_durations (user_id, stat_date, started_at, duration_seconds, project, color)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: HasDurationsOnDate :one
SELECT EXISTS (
    SELECT 1
    FROM screen_time_durations
    WHERE user_id = $1 AND stat_date = $2
) AS has_durations;

-- name: ListDurationsByDateRange :many
SELECT id, user_id, stat_date, started_at, duration_seconds, project, color
FROM screen_time_durations
WHERE user_id = $1
  AND stat_date >= $2
  AND stat_date <= $3
ORDER BY started_at ASC;

-- name: ListDurationsByDate :many
SELECT id, user_id, stat_date, started_at, duration_seconds, project, color
FROM screen_time_durations
WHERE user_id = $1
  AND stat_date = $2
ORDER BY started_at ASC;

-- name: DeleteHeartbeatsByDate :exec
DELETE FROM screen_time_heartbeats
WHERE user_id = $1 AND stat_date = $2;

-- name: DeleteHeartbeatsByDates :exec
DELETE FROM screen_time_heartbeats
WHERE user_id = $1 AND stat_date = ANY($2::date[]);

-- name: InsertHeartbeat :exec
INSERT INTO screen_time_heartbeats (user_id, stat_date, heartbeat_at, project, language, editor, os, category, machine)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: CopyHeartbeats :copyfrom
INSERT INTO screen_time_heartbeats (user_id, stat_date, heartbeat_at, project, language, editor, os, category, machine)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: HasHeartbeatsOnDate :one
SELECT EXISTS (
    SELECT 1
    FROM screen_time_heartbeats
    WHERE user_id = $1 AND stat_date = $2
) AS has_heartbeats;

-- name: CountHeartbeats :one
SELECT COUNT(*)::BIGINT AS total
FROM screen_time_heartbeats
WHERE user_id = $1;
