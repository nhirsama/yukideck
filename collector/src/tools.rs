use chrono::{DateTime, Duration, Timelike, Utc};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Default)]
pub struct ToolSidecar {
    /// Key: (agent, session_id, hour_bucket_rfc3339) -> { tool_name: count }
    pub tool_calls: HashMap<(String, String, DateTime<Utc>), BTreeMap<String, i32>>,
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
            let codex_root = std::env::var("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home_dir.join(".codex"))
                .join("sessions");
            scan_codex_tools(&codex_root, cutoff, &mut out);
        }

        if wants("pi") {
            let pi_root = home_dir.join(".pi").join("agent").join("sessions");
            scan_pi_tools(&pi_root, cutoff, &mut out);
        }

        out
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
            let sid = v
                .get("sessionId")
                .and_then(|s| s.as_str())
                .unwrap_or(&fallback_sid)
                .to_string();
            if sid.is_empty() {
                continue;
            }
            let is_sidechain = v
                .get("isSidechain")
                .and_then(|b| b.as_bool())
                .unwrap_or(false)
                || path_is_subagent;
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
            if !line.contains("\"session_meta\"")
                && !line.contains("\"function_call\"")
                && !line.contains("\"custom_tool_call\"")
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
                    if !id.is_empty() {
                        sid = id.to_string();
                    }
                }
                continue;
            }
            if kind == "response_item" {
                let Some(payload) = v.get("payload") else {
                    continue;
                };
                let ptype = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if ptype != "function_call" && ptype != "custom_tool_call" {
                    continue;
                }
                let Some(name) = payload.get("name").and_then(|n| n.as_str()) else {
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
                let clean = name.trim();
                if !clean.is_empty() && !sid.is_empty() {
                    let bucket = truncate_hour(ts);
                    *out.tool_calls
                        .entry(("codex".to_string(), sid.clone(), bucket))
                        .or_default()
                        .entry(clean.to_string())
                        .or_insert(0) += 1;
                }
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
