use chrono::{DateTime, Duration, Timelike, Utc};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Default)]
pub struct ToolSidecar {
    /// Key: (agent, session_id, hour_bucket) -> { tool_name: count }
    pub tool_calls: HashMap<(String, String, DateTime<Utc>), BTreeMap<String, i32>>,
    /// Key: (agent, alias_session_id) -> primary_session_id stored in `tool_calls`
    pub session_aliases: HashMap<(String, String), String>,
    /// Key: (agent, session_id) -> (is_subagent, parent_session_id)
    pub subagent_meta: HashMap<(String, String), (bool, String)>,
}

impl ToolSidecar {
    pub fn collect(home_dir: &Path, cutoff: Option<DateTime<Utc>>, enabled_agents: &[String]) -> Self {
        let mut out = Self::default();
        let wants = |name: &str| {
            enabled_agents.is_empty()
                || enabled_agents
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case(name))
        };

        if wants("claude") {
            let claude_root = std::env::var("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home_dir.join(".claude"))
                .join("projects");
            scan_claude_tools(&claude_root, cutoff, &mut out);
        }

        if wants("codex") {
            let codex_home = std::env::var("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home_dir.join(".codex"));
            scan_codex_tools(&codex_home.join("sessions"), cutoff, &mut out);
            scan_codex_tools(&codex_home.join("archived_sessions"), cutoff, &mut out);
        }

        if wants("pi") {
            let pi_root = std::env::var("PI_CODING_AGENT_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home_dir.join(".pi").join("agent"))
                .join("sessions");
            scan_pi_tools(&pi_root, cutoff, &mut out);
        }

        if wants("antigravity") || wants("antigravity-cli") || wants("antigravity-extension") {
            let gemini_dir = home_dir.join(".gemini");
            scan_antigravity_tools(&gemini_dir.join("antigravity-cli").join("brain"), cutoff, &mut out);
            scan_antigravity_tools(&gemini_dir.join("antigravity").join("brain"), cutoff, &mut out);
        }

        out
    }

    pub fn lookup_tool_calls(
        &self,
        agent: &str,
        session_id: &str,
        hour_bucket: DateTime<Utc>,
    ) -> Option<&BTreeMap<String, i32>> {
        let key = (agent.to_string(), session_id.to_string(), hour_bucket);
        if let Some(tools) = self.tool_calls.get(&key) {
            return Some(tools);
        }
        if let Some(canonical_sid) = self
            .session_aliases
            .get(&(agent.to_string(), session_id.to_string()))
        {
            return self
                .tool_calls
                .get(&(agent.to_string(), canonical_sid.clone(), hour_bucket));
        }
        None
    }
}

fn file_recently_modified(path: &Path, cutoff: Option<DateTime<Utc>>) -> bool {
    let Some(min_time) = cutoff else {
        return true;
    };
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return true;
    };
    let dt: DateTime<Utc> = mtime.into();
    // Add 1h margin for safety
    dt >= (min_time - Duration::hours(1))
}

fn truncate_hour(ts: DateTime<Utc>) -> DateTime<Utc> {
    ts.with_minute(0)
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(ts)
}

fn parse_rfc3339_utc(v: &Value) -> Option<DateTime<Utc>> {
    if let Some(s) = v.as_str() {
        return DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.with_timezone(&Utc));
    }
    if let Some(ms) = v.as_i64() {
        if ms > 1_000_000_000_000 {
            return DateTime::from_timestamp_millis(ms);
        }
        return DateTime::from_timestamp(ms, 0);
    }
    None
}

fn scan_claude_tools(root: &Path, cutoff: Option<DateTime<Utc>>, out: &mut ToolSidecar) {
    if !root.exists() {
        return;
    }
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if !file_recently_modified(path, cutoff) {
            continue;
        }

        // Detect subagent files living under `<project>/<parent_session>/subagents/*.jsonl`
        let path_str = path.to_string_lossy();
        let path_is_subagent = path_str.contains("/subagents/") || path_str.contains("\\subagents\\");
        let inferred_parent = if path_is_subagent {
            path.parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string()
        } else {
            String::new()
        };
        let fallback_sid = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        let Ok(file) = File::open(path) else {
            continue;
        };
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if !line.contains("\"tool_use\"") && !line.contains("\"isSidechain\"") && !path_is_subagent {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let entry_sid = v
                .get("sessionId")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .trim();
            let is_sidechain = v
                .get("isSidechain")
                .and_then(|b| b.as_bool())
                .unwrap_or(false)
                || path_is_subagent;
            // Match tokscale-core: main sessions are keyed by file_stem, sidechains by parent sessionId.
            let sid = if is_sidechain && !entry_sid.is_empty() {
                entry_sid.to_string()
            } else if !fallback_sid.is_empty() {
                fallback_sid.clone()
            } else {
                entry_sid.to_string()
            };
            if sid.is_empty() {
                continue;
            }
            if !entry_sid.is_empty() && entry_sid != sid {
                out.session_aliases
                    .entry(("claude".to_string(), entry_sid.to_string()))
                    .or_insert_with(|| sid.clone());
            }
            if !fallback_sid.is_empty() && fallback_sid != sid {
                out.session_aliases
                    .entry(("claude".to_string(), fallback_sid.clone()))
                    .or_insert_with(|| sid.clone());
            }
            if is_sidechain {
                let parent = if !inferred_parent.is_empty() && inferred_parent != sid {
                    inferred_parent.clone()
                } else {
                    String::new()
                };
                out.subagent_meta
                    .entry(("claude".to_string(), sid.clone()))
                    .or_insert((true, parent));
            }

            if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            let Some(ts) = v.get("timestamp").and_then(parse_rfc3339_utc) else {
                continue;
            };
            if let Some(min_ts) = cutoff {
                if ts < min_ts {
                    continue;
                }
            }
            let Some(blocks) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            else {
                continue;
            };
            let bucket = truncate_hour(ts);
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                        let clean = name.trim();
                        if !clean.is_empty() {
                            *out.tool_calls
                                .entry(("claude".to_string(), sid.clone(), bucket))
                                .or_default()
                                .entry(clean.to_string())
                                .or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }
}

fn scan_codex_tools(root: &Path, cutoff: Option<DateTime<Utc>>, out: &mut ToolSidecar) {
    if !root.exists() {
        return;
    }
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if !file_recently_modified(path, cutoff) {
            continue;
        }
        // tokscale-core keys Codex sessions by `session_id_from_path(path)` (file_stem, e.g.
        // `rollout-2026-11-25T10-00-00-<uuid>`), NOT `session_meta.payload.id`. Keep file_stem
        // as primary key and record payload.id only as a fallback alias.
        let file_sid = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if file_sid.is_empty() {
            continue;
        }

        let Ok(file) = File::open(path) else {
            continue;
        };
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if !line.contains("\"session_meta\"")
                && !line.contains("\"function_call\"")
                && !line.contains("\"custom_tool_call\"")
                && !line.contains("\"local_shell_call\"")
                && !line.contains("\"web_search_call\"")
                && !line.contains("\"mcp_call\"")
            {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if kind == "session_meta" {
                if let Some(id) = v
                    .get("payload")
                    .and_then(|p| p.get("id"))
                    .and_then(|s| s.as_str())
                {
                    let trimmed = id.trim();
                    if !trimmed.is_empty() && trimmed != file_sid {
                        out.session_aliases
                            .entry(("codex".to_string(), trimmed.to_string()))
                            .or_insert_with(|| file_sid.clone());
                    }
                }
                continue;
            }
            if kind == "response_item" {
                let Some(payload) = v.get("payload") else {
                    continue;
                };
                let ptype = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let tool_name = match ptype {
                    "function_call" | "custom_tool_call" => payload
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                    "local_shell_call" => Some("local_shell".to_string()),
                    "web_search_call" => Some("web_search".to_string()),
                    "mcp_call" => Some(
                        payload
                            .get("name")
                            .and_then(|n| n.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .unwrap_or("mcp_call")
                            .to_string(),
                    ),
                    _ => None,
                };
                let Some(clean) = tool_name else {
                    continue;
                };
                let Some(ts) = v.get("timestamp").and_then(parse_rfc3339_utc) else {
                    continue;
                };
                if let Some(min_ts) = cutoff {
                    if ts < min_ts {
                        continue;
                    }
                }
                let bucket = truncate_hour(ts);
                *out.tool_calls
                    .entry(("codex".to_string(), file_sid.clone(), bucket))
                    .or_default()
                    .entry(clean)
                    .or_insert(0) += 1;
            }
        }
    }
}

fn scan_pi_tools(root: &Path, cutoff: Option<DateTime<Utc>>, out: &mut ToolSidecar) {
    if !root.exists() {
        return;
    }
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if !file_recently_modified(path, cutoff) {
            continue;
        }
        let mut sid = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        let Ok(file) = File::open(path) else {
            continue;
        };
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if !line.contains("\"toolCall\"") && !line.contains("\"session\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if kind == "session" {
                if let Some(id) = v.get("id").and_then(|s| s.as_str()) {
                    if !id.is_empty() {
                        sid = id.to_string();
                    }
                }
                continue;
            }
            if kind != "message" {
                continue;
            }
            let Some(msg) = v.get("message") else {
                continue;
            };
            if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
                continue;
            }
            let Some(ts) = v
                .get("timestamp")
                .and_then(parse_rfc3339_utc)
                .or_else(|| msg.get("timestamp").and_then(parse_rfc3339_utc))
            else {
                continue;
            };
            if let Some(min_ts) = cutoff {
                if ts < min_ts {
                    continue;
                }
            }
            let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) else {
                continue;
            };
            let bucket = truncate_hour(ts);
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                    if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                        let clean = name.trim();
                        if !clean.is_empty() && !sid.is_empty() {
                            *out.tool_calls
                                .entry(("pi".to_string(), sid.clone(), bucket))
                                .or_default()
                                .entry(clean.to_string())
                                .or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }
}

fn scan_antigravity_tools(brain_root: &Path, cutoff: Option<DateTime<Utc>>, out: &mut ToolSidecar) {
    if !brain_root.exists() {
        return;
    }
    let Ok(entries) = fs::read_dir(brain_root) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let conv_id = entry.file_name().to_string_lossy().trim().to_string();
        if conv_id.is_empty() {
            continue;
        }
        let transcript = entry
            .path()
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        if !transcript.is_file() || !file_recently_modified(&transcript, cutoff) {
            continue;
        }
        let Ok(file) = File::open(&transcript) else {
            continue;
        };
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if !line.contains("\"tool_calls\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(calls) = v.get("tool_calls").and_then(|c| c.as_array()) else {
                continue;
            };
            if calls.is_empty() {
                continue;
            }
            let Some(ts) = v.get("created_at").and_then(parse_rfc3339_utc) else {
                continue;
            };
            if let Some(min_ts) = cutoff {
                if ts < min_ts {
                    continue;
                }
            }
            let bucket = truncate_hour(ts);
            for call in calls {
                if let Some(name) = call.get("name").and_then(|n| n.as_str()) {
                    let clean = name.trim();
                    if !clean.is_empty() {
                        *out.tool_calls
                            .entry(("antigravity".to_string(), conv_id.clone(), bucket))
                            .or_default()
                            .entry(clean.to_string())
                            .or_insert(0) += 1;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("yukideck-tools-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_codex_tools_keeps_file_stem_and_reads_all_call_types() {
        let dir = unique_tmp_dir("codex");
        let stem = "rollout-2026-11-25T10-00-00-019a1111-2222-3333-4444-555566667777";
        let path = dir.join(format!("{stem}.jsonl"));
        let content = concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"019a1111-2222-3333-4444-555566667777\"}}\n",
            "{\"type\":\"response_item\",\"timestamp\":\"2026-11-25T10:15:00Z\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\"}}\n",
            "{\"type\":\"response_item\",\"timestamp\":\"2026-11-25T10:16:00Z\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"apply_patch\"}}\n",
            "{\"type\":\"response_item\",\"timestamp\":\"2026-11-25T10:17:00Z\",\"payload\":{\"type\":\"local_shell_call\"}}\n",
            "{\"type\":\"response_item\",\"timestamp\":\"2026-11-25T10:18:00Z\",\"payload\":{\"type\":\"web_search_call\"}}\n",
            "{\"type\":\"response_item\",\"timestamp\":\"2026-11-25T10:19:00Z\",\"payload\":{\"type\":\"mcp_call\",\"name\":\"github_search\"}}\n",
        );
        fs::write(&path, content).unwrap();

        let mut sidecar = ToolSidecar::default();
        scan_codex_tools(&dir, None, &mut sidecar);

        let bucket = DateTime::parse_from_rfc3339("2026-11-25T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let tools = sidecar
            .lookup_tool_calls("codex", stem, bucket)
            .expect("should match codex file_stem session_id");
        assert_eq!(tools.get("exec_command"), Some(&1));
        assert_eq!(tools.get("apply_patch"), Some(&1));
        assert_eq!(tools.get("local_shell"), Some(&1));
        assert_eq!(tools.get("web_search"), Some(&1));
        assert_eq!(tools.get("github_search"), Some(&1));

        // Alias lookup by session_meta.payload.id also succeeds
        assert!(sidecar
            .lookup_tool_calls("codex", "019a1111-2222-3333-4444-555566667777", bucket)
            .is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_antigravity_transcript_tools_scan() {
        let dir = unique_tmp_dir("antigravity");
        let conv_id = "4f5b4a8f-9c30-4da9-aa66-99b9144c1dbf";
        let log_dir = dir.join(conv_id).join(".system_generated").join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        let content = concat!(
            "{\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-11-25T13:51:36Z\",\"tool_calls\":[{\"name\":\"read_file\"},{\"name\":\"run_command\"}]}\n",
            "{\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-11-25T13:55:00Z\",\"tool_calls\":[{\"name\":\"read_file\"}]}\n",
        );
        fs::write(log_dir.join("transcript.jsonl"), content).unwrap();

        let mut sidecar = ToolSidecar::default();
        scan_antigravity_tools(&dir, None, &mut sidecar);

        let bucket = DateTime::parse_from_rfc3339("2026-11-25T13:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let tools = sidecar
            .lookup_tool_calls("antigravity", conv_id, bucket)
            .expect("should extract antigravity tool_calls from transcript.jsonl");
        assert_eq!(tools.get("read_file"), Some(&2));
        assert_eq!(tools.get("run_command"), Some(&1));

        let _ = fs::remove_dir_all(&dir);
    }
}
