-- Remove legacy non-subagent orphan slices superseded by a subagent slice with an explicit
-- parent_session_id (for example, OpenCode child sessions synced by an older collector before
-- parent_id / tool-call detection was added).
DELETE FROM ai_usage_hourly_sessions old
WHERE old.is_subagent = FALSE
  AND EXISTS (
      SELECT 1
      FROM ai_usage_hourly_sessions sub
      WHERE sub.user_id = old.user_id
        AND sub.device_id = old.device_id
        AND sub.agent = old.agent
        AND sub.session_id = old.session_id
        AND sub.hour_bucket = old.hour_bucket
        AND sub.model = old.model
        AND sub.is_subagent = TRUE
        AND sub.parent_session_id <> ''
        AND sub.parent_session_id <> sub.session_id
  );
