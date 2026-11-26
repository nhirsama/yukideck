use crate::config::{CollectorConfig, ProjectPrivacy};
use crate::tools::ToolSidecar;
use anyhow::{anyhow, Result};
use chrono::{DateTime, Duration, Timelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::pin::pin;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
use tokscale_core::{CostSource, LocalParseOptions, UnifiedMessage};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestSlice {
    pub agent: String,
    pub session_id: String,
    pub hour_bucket: DateTime<Utc>,
    pub model: String,
    pub is_subagent: bool,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub parent_session_id: String,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub provider: String,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub project: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cache_write_1h_tokens: i64,
    pub reasoning_tokens: i64,
    pub max_context_tokens: i64,
    pub reported_cost_usd: f64,
    pub request_count: i32,
    pub tool_call_count: i32,
    #[serde(skip_serializing_if = "BTreeMap::is_empty", default)]
    pub tool_calls: BTreeMap<String, i32>,
    pub first_event_at: DateTime<Utc>,
    pub last_event_at: DateTime<Utc>,
}

impl IngestSlice {
    pub fn slice_key(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.agent,
            self.session_id,
            self.hour_bucket.to_rfc3339(),
            self.model,
            if self.is_subagent { "1" } else { "0" }
        )
    }

    pub fn content_hash(&self) -> String {
        let json = serde_json::to_vec(self).unwrap_or_default();
        let mut h = Sha256::new();
        h.update(&json);
        hex::encode(h.finalize())
    }
}

#[derive(Debug)]
pub struct CollectSummary {
    pub raw_messages: usize,
    pub client_counts: BTreeMap<String, i32>,
    pub slices_by_agent: BTreeMap<String, usize>,
    pub dropped_invalid_ts: usize,
    pub dropped_cutoff: usize,
    pub dropped_missing_fields: usize,
    pub earliest_bucket: Option<DateTime<Utc>>,
    pub latest_bucket: Option<DateTime<Utc>>,
    pub slices: Vec<IngestSlice>,
}

#[derive(Debug, Default)]
pub struct AggregateStats {
    pub dropped_invalid_ts: usize,
    pub dropped_cutoff: usize,
    pub dropped_missing_fields: usize,
}

/// Polls a synchronous future that completes immediately (such as
/// `tokscale_core::parse_local_unified_messages_with_pricing` which contains no `.await` points)
/// without spinning up a Tokio runtime.
fn block_on_ready<F: Future>(fut: F) -> Result<F::Output> {
    fn clone_noop(_: *const ()) -> RawWaker {
        RawWaker::new(std::ptr::null(), &VTABLE)
    }
    fn noop(_: *const ()) {}
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone_noop, noop, noop, noop);

    let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
    let mut cx = Context::from_waker(&waker);
    let mut pinned = pin!(fut);
    match pinned.as_mut().poll(&mut cx) {
        Poll::Ready(val) => Ok(val),
        Poll::Pending => Err(anyhow!(
            "unexpected async pending state from tokscale-core cached parser"
        )),
    }
}

pub fn collect_slices(
    cfg: &CollectorConfig,
    all_history: bool,
    lookback_override: Option<u64>,
    tool_cache_path: Option<&Path>,
) -> Result<CollectSummary> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("cannot determine home directory"))?;
    let lookback_hours = lookback_override.unwrap_or(cfg.lookback_hours);

    let cutoff = if all_history {
        None
    } else {
        Some(Utc::now() - Duration::hours(lookback_hours as i64))
    };

    let since = cutoff.map(|dt| (dt - Duration::days(1)).format("%Y-%m-%d").to_string());
    let clients = if cfg.agents.is_empty() {
        None
    } else {
        Some(cfg.agents.clone())
    };

    // Use tokscale-core's persistent sharded source-message-cache-v2 + incremental SQLite/JSONL
    // checkpoint rescanning instead of the uncached `parse_local_clients` full-scan entry point.
    // Pass `pricing = None` so no external pricing network requests are made (YukiDeck computes
    // pricing server-side while preserving `ProviderReported` costs).
    let messages = block_on_ready(tokscale_core::parse_local_unified_messages_with_pricing(
        LocalParseOptions {
            home_dir: Some(home.to_string_lossy().to_string()),
            use_env_roots: true,
            clients,
            since,
            until: None,
            year: None,
            scanner_settings: Default::default(),
        },
        None,
    ))?
    .map_err(|e| anyhow!("tokscale-core parse failed: {e}"))?;

    let mut client_counts: BTreeMap<String, i32> = BTreeMap::new();
    for msg in &messages {
        let n = msg.message_count.max(1);
        *client_counts.entry(msg.client.to_string()).or_insert(0) += n;
    }

    let sidecar = ToolSidecar::collect_cached(&home, cutoff, &cfg.agents, tool_cache_path);
    let (slices, stats) =
        aggregate_messages_with_stats(&messages, cutoff, cfg.project_privacy, &sidecar);

    let mut slices_by_agent = BTreeMap::new();
    let mut earliest_bucket: Option<DateTime<Utc>> = None;
    let mut latest_bucket: Option<DateTime<Utc>> = None;
    for sl in &slices {
        *slices_by_agent.entry(sl.agent.clone()).or_insert(0) += 1;
        earliest_bucket = Some(match earliest_bucket {
            Some(cur) if cur <= sl.hour_bucket => cur,
            _ => sl.hour_bucket,
        });
        latest_bucket = Some(match latest_bucket {
            Some(cur) if cur >= sl.hour_bucket => cur,
            _ => sl.hour_bucket,
        });
    }

    Ok(CollectSummary {
        raw_messages: messages.len(),
        client_counts,
        slices_by_agent,
        dropped_invalid_ts: stats.dropped_invalid_ts,
        dropped_cutoff: stats.dropped_cutoff,
        dropped_missing_fields: stats.dropped_missing_fields,
        earliest_bucket,
        latest_bucket,
        slices,
    })
}

#[cfg(test)]
pub fn aggregate_messages(
    messages: &[UnifiedMessage],
    cutoff: Option<DateTime<Utc>>,
    privacy: ProjectPrivacy,
    sidecar: &ToolSidecar,
) -> Vec<IngestSlice> {
    aggregate_messages_with_stats(messages, cutoff, privacy, sidecar).0
}

pub fn aggregate_messages_with_stats(
    messages: &[UnifiedMessage],
    cutoff: Option<DateTime<Utc>>,
    privacy: ProjectPrivacy,
    sidecar: &ToolSidecar,
) -> (Vec<IngestSlice>, AggregateStats) {
    type Key = (String, String, DateTime<Utc>, String, bool);
    let mut map: BTreeMap<Key, IngestSlice> = BTreeMap::new();
    let mut attached_tools = std::collections::HashSet::<(String, String, DateTime<Utc>)>::new();
    let mut stats = AggregateStats::default();

    for msg in messages {
        let Some(ts) = timestamp_to_utc(msg.timestamp) else {
            stats.dropped_invalid_ts += 1;
            continue;
        };
        if let Some(min_ts) = cutoff {
            if ts < min_ts {
                stats.dropped_cutoff += 1;
                continue;
            }
        }
        let hour_bucket = ts
            .with_minute(0)
            .and_then(|t| t.with_second(0))
            .and_then(|t| t.with_nanosecond(0))
            .unwrap_or(ts);

        let agent = normalize_agent_id(msg.client.as_str());
        let session_id = msg.session_id.trim().to_string();
        let model = msg.model_id.trim().to_string();
        if agent.is_empty() || session_id.is_empty() || model.is_empty() {
            stats.dropped_missing_fields += 1;
            continue;
        }

        let (sidecar_sub, sidecar_parent) = sidecar
            .subagent_meta
            .get(&(agent.clone(), session_id.clone()))
            .cloned()
            .unwrap_or((false, String::new()));
        let msg_parent = msg
            .parent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != session_id.as_str())
            .unwrap_or("")
            .to_string();
        let parent_session_id = if !sidecar_parent.is_empty() {
            sidecar_parent
        } else {
            msg_parent
        };
        let is_subagent = sidecar_sub
            || !parent_session_id.is_empty()
            || msg
                .agent
                .as_deref()
                .map(|a| a.to_ascii_lowercase().contains("subagent"))
                .unwrap_or(false);

        let provider = msg.provider_id.trim().to_ascii_lowercase();
        let project = sanitize_project(
            msg.workspace_label
                .as_deref()
                .or(msg.workspace_key.as_deref()),
            privacy,
        );

        let input = msg.tokens.input.max(0);
        let output = msg.tokens.output.max(0);
        let cache_read = msg.tokens.cache_read.max(0);
        // tokscale-core's cache_write INCLUDES cache_write_1h; split without double counting.
        let cache_write_1h = msg.tokens.cache_write_1h.max(0).min(msg.tokens.cache_write.max(0));
        let cache_write_5m = msg.tokens.cache_write.max(0).saturating_sub(cache_write_1h);
        let reasoning = msg.tokens.reasoning.max(0);
        let turn_context = input
            .saturating_add(cache_read)
            .saturating_add(cache_write_5m)
            .saturating_add(cache_write_1h);
        let reqs = msg.message_count.max(1);
        let reported_cost = if msg.cost_source == CostSource::ProviderReported && msg.cost > 0.0 {
            msg.cost
        } else {
            0.0
        };

        let key: Key = (
            agent.clone(),
            session_id.clone(),
            hour_bucket,
            model.clone(),
            is_subagent,
        );
        let entry = map.entry(key).or_insert_with(|| IngestSlice {
            agent: agent.clone(),
            session_id: session_id.clone(),
            hour_bucket,
            model: model.clone(),
            is_subagent,
            parent_session_id: parent_session_id.clone(),
            provider: provider.clone(),
            project: project.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cache_write_1h_tokens: 0,
            reasoning_tokens: 0,
            max_context_tokens: 0,
            reported_cost_usd: 0.0,
            request_count: 0,
            tool_call_count: 0,
            tool_calls: BTreeMap::new(),
            first_event_at: ts,
            last_event_at: ts,
        });

        entry.input_tokens = entry.input_tokens.saturating_add(input);
        entry.output_tokens = entry.output_tokens.saturating_add(output);
        entry.cache_read_tokens = entry.cache_read_tokens.saturating_add(cache_read);
        entry.cache_write_tokens = entry.cache_write_tokens.saturating_add(cache_write_5m);
        entry.cache_write_1h_tokens = entry.cache_write_1h_tokens.saturating_add(cache_write_1h);
        entry.reasoning_tokens = entry.reasoning_tokens.saturating_add(reasoning);
        if turn_context > entry.max_context_tokens {
            entry.max_context_tokens = turn_context;
        }
        entry.reported_cost_usd += reported_cost;
        entry.request_count = entry.request_count.saturating_add(reqs);
        if ts < entry.first_event_at {
            entry.first_event_at = ts;
        }
        if ts > entry.last_event_at {
            entry.last_event_at = ts;
        }
        if entry.provider.is_empty() && !provider.is_empty() {
            entry.provider = provider;
        }
        if entry.project.is_empty() && !project.is_empty() {
            entry.project = project;
        }
        if entry.parent_session_id.is_empty() && !parent_session_id.is_empty() {
            entry.parent_session_id = parent_session_id;
        }
    }

    // Attach tool_calls once per (agent, session_id, hour_bucket) to the primary slice in that bucket
    // (the one with the highest request_count) so tool counts are never duplicated across models.
    let mut slices: Vec<IngestSlice> = map.into_values().collect();
    slices.sort_by(|a, b| {
        a.hour_bucket
            .cmp(&b.hour_bucket)
            .then_with(|| b.request_count.cmp(&a.request_count))
    });
    for sl in &mut slices {
        let tk = (sl.agent.clone(), sl.session_id.clone(), sl.hour_bucket);
        if attached_tools.contains(&tk) {
            continue;
        }
        if let Some(tools) = sidecar.lookup_tool_calls(&sl.agent, &sl.session_id, sl.hour_bucket) {
            let sum: i32 = tools.values().copied().sum();
            sl.tool_calls = tools.clone();
            sl.tool_call_count = sum;
            attached_tools.insert(tk);
        }
    }

    (slices, stats)
}

pub fn timestamp_to_utc(raw: i64) -> Option<DateTime<Utc>> {
    if raw <= 0 {
        return None;
    }
    if raw > 1_000_000_000_000 {
        DateTime::from_timestamp_millis(raw)
    } else {
        DateTime::from_timestamp(raw, 0)
    }
}

pub fn normalize_agent_id(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    match lower.as_str() {
        "antigravity-cli" | "antigravity-extension" => "antigravity".to_string(),
        _ => lower,
    }
}

pub fn sanitize_project(raw: Option<&str>, privacy: ProjectPrivacy) -> String {
    let Some(val) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    match privacy {
        ProjectPrivacy::None => String::new(),
        ProjectPrivacy::Name => {
            let p = Path::new(val);
            p.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(val)
                .trim()
                .to_string()
        }
        ProjectPrivacy::Hash => {
            let mut h = Sha256::new();
            h.update(val.as_bytes());
            let hex = hex::encode(h.finalize());
            format!("proj-{}", &hex[..8])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokscale_core::{TokenBreakdown, UnifiedMessage};

    fn dummy_msg(ts_ms: i64, cache_write: i64, cache_write_1h: i64) -> UnifiedMessage {
        let mut msg = UnifiedMessage::new(
            "claude",
            "claude-sonnet-4-6-20260514",
            "anthropic",
            "sess-1",
            ts_ms,
            TokenBreakdown {
                input: 1000,
                output: 200,
                cache_read: 5000,
                cache_write,
                cache_write_1h,
                reasoning: 0,
            },
            0.0,
        );
        msg.set_workspace(
            Some("/home/alice/code/yukideck".to_string()),
            Some("yukideck".to_string()),
        );
        msg
    }

    #[test]
    fn test_aggregate_splits_cross_hour_and_cache_write_1h() {
        let t1 = DateTime::parse_from_rfc3339("2026-11-24T15:40:00Z")
            .unwrap()
            .timestamp_millis();
        let t2 = DateTime::parse_from_rfc3339("2026-11-24T15:50:00Z")
            .unwrap()
            .timestamp_millis();
        let t3 = DateTime::parse_from_rfc3339("2026-11-24T16:10:00Z")
            .unwrap()
            .timestamp_millis();

        let msgs = vec![
            dummy_msg(t1, 1000, 300),
            dummy_msg(t2, 500, 0),
            dummy_msg(t3, 200, 200),
        ];
        let slices = aggregate_messages(&msgs, None, ProjectPrivacy::Name, &ToolSidecar::default());
        assert_eq!(slices.len(), 2);

        let h1 = &slices[0];
        assert_eq!(h1.hour_bucket.to_rfc3339(), "2026-11-24T15:00:00+00:00");
        assert_eq!(h1.request_count, 2);
        // 5m = (1000-300) + 500 = 1200, 1h = 300 -> total cache_write remains 1500 (no double counting!)
        assert_eq!(h1.cache_write_tokens, 1200);
        assert_eq!(h1.cache_write_1h_tokens, 300);
        assert_eq!(h1.max_context_tokens, 1000 + 5000 + 1000);
        assert_eq!(h1.project, "yukideck");

        let h2 = &slices[1];
        assert_eq!(h2.hour_bucket.to_rfc3339(), "2026-11-24T16:00:00+00:00");
        assert_eq!(h2.cache_write_tokens, 0);
        assert_eq!(h2.cache_write_1h_tokens, 200);
    }

    #[test]
    fn test_project_privacy_modes() {
        assert_eq!(
            sanitize_project(Some("/home/user/secret/my-repo"), ProjectPrivacy::Name),
            "my-repo"
        );
        assert_eq!(
            sanitize_project(Some("/home/user/secret/my-repo"), ProjectPrivacy::None),
            ""
        );
        let hashed = sanitize_project(Some("/home/user/secret/my-repo"), ProjectPrivacy::Hash);
        assert!(hashed.starts_with("proj-"));
        assert_eq!(hashed.len(), 13);
    }
}
