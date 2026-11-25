-- name: UpsertHourlySession :batchexec
INSERT INTO ai_usage_hourly_sessions (
    user_id, device_id, agent, session_id, hour_bucket, model, is_subagent,
    parent_session_id, provider, project,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
    reasoning_tokens, max_context_tokens, reported_cost_usd,
    request_count, tool_call_count, tool_calls,
    first_event_at, last_event_at, updated_at
)
VALUES (
    $1, $2, $3, $4, $5, $6, $7,
    $8, $9, $10,
    $11, $12, $13, $14, $15,
    $16, $17, $18,
    $19, $20, $21,
    $22, $23, NOW()
)
ON CONFLICT (user_id, device_id, agent, session_id, hour_bucket, model, is_subagent)
DO UPDATE SET
    parent_session_id     = COALESCE(NULLIF(EXCLUDED.parent_session_id, ''), ai_usage_hourly_sessions.parent_session_id),
    provider              = COALESCE(NULLIF(EXCLUDED.provider, ''), ai_usage_hourly_sessions.provider),
    project               = COALESCE(NULLIF(EXCLUDED.project, ''), ai_usage_hourly_sessions.project),
    input_tokens          = EXCLUDED.input_tokens,
    output_tokens         = EXCLUDED.output_tokens,
    cache_read_tokens     = EXCLUDED.cache_read_tokens,
    cache_write_tokens    = EXCLUDED.cache_write_tokens,
    cache_write_1h_tokens = EXCLUDED.cache_write_1h_tokens,
    reasoning_tokens      = EXCLUDED.reasoning_tokens,
    max_context_tokens    = EXCLUDED.max_context_tokens,
    reported_cost_usd     = EXCLUDED.reported_cost_usd,
    request_count         = EXCLUDED.request_count,
    tool_call_count       = EXCLUDED.tool_call_count,
    tool_calls            = EXCLUDED.tool_calls,
    first_event_at        = LEAST(ai_usage_hourly_sessions.first_event_at, EXCLUDED.first_event_at),
    last_event_at         = EXCLUDED.last_event_at,
    updated_at            = NOW()
WHERE
    ($24::boolean OR EXCLUDED.last_event_at >= ai_usage_hourly_sessions.last_event_at)
    AND (
        ai_usage_hourly_sessions.parent_session_id     IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.parent_session_id, ''), ai_usage_hourly_sessions.parent_session_id)
        OR ai_usage_hourly_sessions.provider           IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.provider, ''), ai_usage_hourly_sessions.provider)
        OR ai_usage_hourly_sessions.project            IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.project, ''), ai_usage_hourly_sessions.project)
        OR ai_usage_hourly_sessions.input_tokens       IS DISTINCT FROM EXCLUDED.input_tokens
        OR ai_usage_hourly_sessions.output_tokens      IS DISTINCT FROM EXCLUDED.output_tokens
        OR ai_usage_hourly_sessions.cache_read_tokens  IS DISTINCT FROM EXCLUDED.cache_read_tokens
        OR ai_usage_hourly_sessions.cache_write_tokens IS DISTINCT FROM EXCLUDED.cache_write_tokens
        OR ai_usage_hourly_sessions.cache_write_1h_tokens IS DISTINCT FROM EXCLUDED.cache_write_1h_tokens
        OR ai_usage_hourly_sessions.reasoning_tokens   IS DISTINCT FROM EXCLUDED.reasoning_tokens
        OR ai_usage_hourly_sessions.max_context_tokens IS DISTINCT FROM EXCLUDED.max_context_tokens
        OR ai_usage_hourly_sessions.reported_cost_usd  IS DISTINCT FROM EXCLUDED.reported_cost_usd
        OR ai_usage_hourly_sessions.request_count      IS DISTINCT FROM EXCLUDED.request_count
        OR ai_usage_hourly_sessions.tool_call_count    IS DISTINCT FROM EXCLUDED.tool_call_count
        OR ai_usage_hourly_sessions.tool_calls         IS DISTINCT FROM EXCLUDED.tool_calls
        OR ai_usage_hourly_sessions.first_event_at     IS DISTINCT FROM LEAST(ai_usage_hourly_sessions.first_event_at, EXCLUDED.first_event_at)
        OR ai_usage_hourly_sessions.last_event_at      IS DISTINCT FROM EXCLUDED.last_event_at
    );

-- name: ListHourlySessions :many
SELECT
    id, user_id, device_id, agent, session_id, hour_bucket, model, is_subagent,
    parent_session_id, provider, project,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
    reasoning_tokens, max_context_tokens, reported_cost_usd,
    request_count, tool_call_count, tool_calls,
    first_event_at, last_event_at, updated_at
FROM ai_usage_hourly_sessions
WHERE user_id = $1
  AND hour_bucket >= $2
  AND hour_bucket < $3
ORDER BY hour_bucket ASC, id ASC;

-- name: ListHourlySessionsBySession :many
SELECT
    id, user_id, device_id, agent, session_id, hour_bucket, model, is_subagent,
    parent_session_id, provider, project,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
    reasoning_tokens, max_context_tokens, reported_cost_usd,
    request_count, tool_call_count, tool_calls,
    first_event_at, last_event_at, updated_at
FROM ai_usage_hourly_sessions
WHERE user_id = $1
  AND (session_id = $2 OR parent_session_id = $2)
  AND ($3::text = '' OR device_id = $3)
ORDER BY hour_bucket ASC, id ASC;

-- name: UpsertDeviceFromIngest :one
INSERT INTO ai_usage_devices (
    user_id, device_id, name, os, arch, hostname, collector_version, last_synced_at, updated_at
)
VALUES (
    $1, $2, $3, $4, $5, $6, $7, NOW(), NOW()
)
ON CONFLICT (user_id, device_id)
DO UPDATE SET
    name              = CASE WHEN ai_usage_devices.name = '' THEN EXCLUDED.name ELSE ai_usage_devices.name END,
    os                = COALESCE(NULLIF(EXCLUDED.os, ''), ai_usage_devices.os),
    arch              = COALESCE(NULLIF(EXCLUDED.arch, ''), ai_usage_devices.arch),
    hostname          = COALESCE(NULLIF(EXCLUDED.hostname, ''), ai_usage_devices.hostname),
    collector_version = COALESCE(NULLIF(EXCLUDED.collector_version, ''), ai_usage_devices.collector_version),
    last_synced_at    = NOW(),
    updated_at        = NOW()
RETURNING id, user_id, device_id, name, os, arch, hostname, collector_version, last_synced_at, hidden, created_at, updated_at;

-- name: ListDevices :many
SELECT id, user_id, device_id, name, os, arch, hostname, collector_version, last_synced_at, hidden, created_at, updated_at
FROM ai_usage_devices
WHERE user_id = $1
ORDER BY hidden ASC, last_synced_at DESC, id ASC;

-- name: UpdateDevice :one
UPDATE ai_usage_devices
SET name = $3,
    hidden = $4,
    updated_at = NOW()
WHERE user_id = $1 AND device_id = $2
RETURNING id, user_id, device_id, name, os, arch, hostname, collector_version, last_synced_at, hidden, created_at, updated_at;

-- name: DeleteDevice :execrows
DELETE FROM ai_usage_devices
WHERE user_id = $1 AND device_id = $2;

-- name: ListModelAliases :many
SELECT id, user_id, match_pattern, canonical_model, priority, created_at, updated_at
FROM ai_usage_model_aliases
WHERE user_id = $1
ORDER BY priority ASC, id ASC;

-- name: UpsertModelAlias :one
INSERT INTO ai_usage_model_aliases (user_id, match_pattern, canonical_model, priority, updated_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (user_id, match_pattern)
DO UPDATE SET
    canonical_model = EXCLUDED.canonical_model,
    priority        = EXCLUDED.priority,
    updated_at      = NOW()
RETURNING id, user_id, match_pattern, canonical_model, priority, created_at, updated_at;

-- name: DeleteModelAlias :execrows
DELETE FROM ai_usage_model_aliases
WHERE user_id = $1 AND id = $2;

-- name: ListModelPrices :many
SELECT id, user_id, model_pattern, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, cache_write_1h_per_m, created_at, updated_at
FROM ai_usage_model_prices
WHERE user_id = $1
ORDER BY model_pattern ASC, id ASC;

-- name: UpsertModelPrice :one
INSERT INTO ai_usage_model_prices (
    user_id, model_pattern, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, cache_write_1h_per_m, updated_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
ON CONFLICT (user_id, model_pattern)
DO UPDATE SET
    input_per_m          = EXCLUDED.input_per_m,
    output_per_m         = EXCLUDED.output_per_m,
    cache_read_per_m     = EXCLUDED.cache_read_per_m,
    cache_write_per_m    = EXCLUDED.cache_write_per_m,
    cache_write_1h_per_m = EXCLUDED.cache_write_1h_per_m,
    updated_at           = NOW()
RETURNING id, user_id, model_pattern, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, cache_write_1h_per_m, created_at, updated_at;

-- name: DeleteModelPrice :execrows
DELETE FROM ai_usage_model_prices
WHERE user_id = $1 AND id = $2;
