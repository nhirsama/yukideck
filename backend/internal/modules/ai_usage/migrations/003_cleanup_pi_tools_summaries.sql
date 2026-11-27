-- Clean up legacy Pi synthetic `tools/summaries` rows emitted by older collectors
-- (tokscale-core uses `tools/summaries` as a synthetic bucket for model-less Pi compactions,
-- branch summaries, and toolResult usage).
--
-- Step 1: Merge same-hour `tools/summaries` rows into the primary real-model row of the same
-- (user_id, device_id, agent, session_id, hour_bucket, is_subagent) bucket.
WITH targets AS (
    SELECT
        s.id AS src_id,
        (
            SELECT t.id
            FROM ai_usage_hourly_sessions t
            WHERE t.user_id = s.user_id
              AND t.device_id = s.device_id
              AND t.agent = s.agent
              AND t.session_id = s.session_id
              AND t.hour_bucket = s.hour_bucket
              AND t.is_subagent = s.is_subagent
              AND LOWER(TRIM(t.model)) <> 'tools/summaries'
            ORDER BY t.request_count DESC, (t.input_tokens + t.output_tokens) DESC, t.id ASC
            LIMIT 1
        ) AS dst_id
    FROM ai_usage_hourly_sessions s
    WHERE LOWER(TRIM(s.model)) = 'tools/summaries'
),
agg_src AS (
    SELECT
        dst_id,
        SUM(s.input_tokens)          AS input_tokens,
        SUM(s.output_tokens)         AS output_tokens,
        SUM(s.cache_read_tokens)     AS cache_read_tokens,
        SUM(s.cache_write_tokens)    AS cache_write_tokens,
        SUM(s.cache_write_1h_tokens) AS cache_write_1h_tokens,
        SUM(s.reasoning_tokens)      AS reasoning_tokens,
        MAX(s.max_context_tokens)    AS max_context_tokens,
        SUM(s.reported_cost_usd)     AS reported_cost_usd,
        SUM(s.request_count)         AS request_count,
        SUM(s.tool_call_count)       AS tool_call_count,
        MIN(s.first_event_at)        AS first_event_at,
        MAX(s.last_event_at)         AS last_event_at
    FROM targets tg
    JOIN ai_usage_hourly_sessions s ON s.id = tg.src_id
    WHERE tg.dst_id IS NOT NULL
    GROUP BY dst_id
),
agg_tools AS (
    SELECT
        tg.dst_id,
        jsonb_object_agg(k, v) AS merged_tools
    FROM (
        SELECT
            tg.dst_id,
            kv.key AS k,
            SUM(kv.value::int) AS v
        FROM (
            SELECT dst_id, src_id AS row_id FROM targets WHERE dst_id IS NOT NULL
            UNION
            SELECT DISTINCT dst_id, dst_id AS row_id FROM targets WHERE dst_id IS NOT NULL
        ) tg
        JOIN ai_usage_hourly_sessions r ON r.id = tg.row_id
        CROSS JOIN LATERAL jsonb_each_text(r.tool_calls) kv
        GROUP BY tg.dst_id, kv.key
    ) tg
    GROUP BY tg.dst_id
)
UPDATE ai_usage_hourly_sessions dst
SET
    input_tokens          = dst.input_tokens + a.input_tokens,
    output_tokens         = dst.output_tokens + a.output_tokens,
    cache_read_tokens     = dst.cache_read_tokens + a.cache_read_tokens,
    cache_write_tokens    = dst.cache_write_tokens + a.cache_write_tokens,
    cache_write_1h_tokens = dst.cache_write_1h_tokens + a.cache_write_1h_tokens,
    reasoning_tokens      = dst.reasoning_tokens + a.reasoning_tokens,
    max_context_tokens    = GREATEST(dst.max_context_tokens, a.max_context_tokens),
    reported_cost_usd     = dst.reported_cost_usd + a.reported_cost_usd,
    request_count         = dst.request_count + a.request_count,
    tool_call_count       = dst.tool_call_count + a.tool_call_count,
    tool_calls            = COALESCE(at.merged_tools, dst.tool_calls),
    first_event_at        = LEAST(dst.first_event_at, a.first_event_at),
    last_event_at         = GREATEST(dst.last_event_at, a.last_event_at),
    updated_at            = NOW()
FROM agg_src a
LEFT JOIN agg_tools at ON at.dst_id = a.dst_id
WHERE dst.id = a.dst_id;

DELETE FROM ai_usage_hourly_sessions s
WHERE LOWER(TRIM(s.model)) = 'tools/summaries'
  AND EXISTS (
      SELECT 1
      FROM ai_usage_hourly_sessions t
      WHERE t.user_id = s.user_id
        AND t.device_id = s.device_id
        AND t.agent = s.agent
        AND t.session_id = s.session_id
        AND t.hour_bucket = s.hour_bucket
        AND t.is_subagent = s.is_subagent
        AND LOWER(TRIM(t.model)) <> 'tools/summaries'
  );

-- Step 2: Re-label cross-hour `tools/summaries` rows (e.g. compaction in a later hour) to the
-- session's active real model when one exists in another hour.
WITH candidates AS (
    SELECT DISTINCT ON (s.user_id, s.device_id, s.agent, s.session_id, s.hour_bucket, s.is_subagent)
        s.id AS src_id,
        rm.model AS target_model,
        rm.provider AS target_provider
    FROM ai_usage_hourly_sessions s
    CROSS JOIN LATERAL (
        SELECT t.model, t.provider
        FROM ai_usage_hourly_sessions t
        WHERE t.user_id = s.user_id
          AND t.device_id = s.device_id
          AND t.agent = s.agent
          AND t.session_id = s.session_id
          AND t.is_subagent = s.is_subagent
          AND LOWER(TRIM(t.model)) <> 'tools/summaries'
        ORDER BY
            CASE WHEN t.hour_bucket <= s.hour_bucket THEN 0 ELSE 1 END ASC,
            CASE WHEN t.hour_bucket <= s.hour_bucket THEN -EXTRACT(EPOCH FROM t.hour_bucket) ELSE EXTRACT(EPOCH FROM t.hour_bucket) END ASC,
            t.request_count DESC,
            t.id ASC
        LIMIT 1
    ) rm
    WHERE LOWER(TRIM(s.model)) = 'tools/summaries'
    ORDER BY s.user_id, s.device_id, s.agent, s.session_id, s.hour_bucket, s.is_subagent, s.id ASC
)
UPDATE ai_usage_hourly_sessions s
SET
    model      = c.target_model,
    provider   = CASE WHEN s.provider = '' OR LOWER(s.provider) = LOWER(s.agent) THEN c.target_provider ELSE s.provider END,
    updated_at = NOW()
FROM candidates c
WHERE s.id = c.src_id;

-- Step 3: Remove any remaining orphan `tools/summaries` rows that have no real model in the session.
DELETE FROM ai_usage_hourly_sessions
WHERE LOWER(TRIM(model)) = 'tools/summaries';
