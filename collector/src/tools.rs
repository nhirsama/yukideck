use chrono::{DateTime, Duration, Timelike, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

const TOOL_CACHE_VERSION: u32 = 2;
const MAX_CACHED_FILES: usize = 8_000;

#[derive(Debug, Default)]
pub struct ToolSidecar {
    /// Key: (agent, session_id, hour_bucket) -> { tool_name: count } (model-agnostic)
    pub tool_calls: HashMap<(String, String, DateTime<Utc>), BTreeMap<String, i32>>,
    /// Key: (agent, session_id, hour_bucket, model) -> { tool_name: count } (model-attributed)
    pub model_tool_calls: HashMap<(String, String, DateTime<Utc>, String), BTreeMap<String, i32>>,
    /// Key: (agent, alias_session_id) -> primary_session_id stored in `tool_calls`
    pub session_aliases: HashMap<(String, String), String>,
    /// Key: (agent, session_id) -> (is_subagent, parent_session_id)
    pub subagent_meta: HashMap<(String, String), (bool, String)>,
}

#[derive(Debug, Default)]
struct FileScanResult {
    /// (session_id, hour_bucket_unix_secs) -> { tool_name: count }
    tool_calls: HashMap<(String, i64), BTreeMap<String, i32>>,
    aliases: Vec<(String, String)>,
    subagent_meta: Vec<(String, bool, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedBucketTools {
    session_id: String,
    hour_ts: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    model: String,
    tools: BTreeMap<String, i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedFileEntry {
    size: u64,
    modified_ns: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    buckets: Vec<CachedBucketTools>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    aliases: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    subagent_meta: Vec<(String, bool, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SqliteFileSig {
    db_size: u64,
    db_modified_ns: u64,
    wal_exists: bool,
    wal_size: u64,
    wal_modified_ns: u64,
    #[serde(default)]
    wal_sample: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedOpenCodeDb {
    sig: SqliteFileSig,
    full_history: bool,
    #[serde(default)]
    min_cutoff_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    buckets: Vec<CachedBucketTools>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    subagent_meta: Vec<(String, bool, String)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    covered_sessions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolCache {
    version: u32,
    #[serde(default)]
    files: HashMap<String, CachedFileEntry>,
    #[serde(default)]
    opencode_dbs: HashMap<String, CachedOpenCodeDb>,
    #[serde(skip)]
    dirty: bool,
}

impl Default for ToolCache {
    fn default() -> Self {
        Self {
            version: TOOL_CACHE_VERSION,
            files: HashMap::new(),
            opencode_dbs: HashMap::new(),
            dirty: false,
        }
    }
}

impl ToolCache {
    fn load(path: &Path) -> Self {
        let Ok(raw) = fs::read_to_string(path) else {
            return Self::default();
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(cache) if cache.version == TOOL_CACHE_VERSION => cache,
            _ => Self::default(),
        }
    }

    fn save_if_dirty(&mut self, path: &Path) {
        if !self.dirty {
            return;
        }
        // Bound cache size by dropping oldest entries by modified_ns if needed.
        if self.files.len() > MAX_CACHED_FILES {
            let mut entries: Vec<(String, u64)> = self
                .files
                .iter()
                .map(|(k, v)| (k.clone(), v.modified_ns))
                .collect();
            entries.sort_unstable_by_key(|(_, m)| *m);
            let remove_count = entries.len().saturating_sub(MAX_CACHED_FILES);
            for (k, _) in entries.into_iter().take(remove_count) {
                self.files.remove(&k);
            }
        }
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec(self) {
            if fs::write(&tmp, bytes).is_ok() {
                if fs::rename(&tmp, path).is_ok() {
                    self.dirty = false;
                } else {
                    let _ = fs::remove_file(&tmp);
                }
            }
        }
    }
}

impl ToolSidecar {
    pub fn collect_cached(
        home_dir: &Path,
        cutoff: Option<DateTime<Utc>>,
        enabled_agents: &[String],
        cache_path: Option<&Path>,
    ) -> Self {
        let mut out = Self::default();
        let mut cache = cache_path.map(ToolCache::load).unwrap_or_default();

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
            scan_claude_tools(&claude_root, cutoff, &mut cache, &mut out);
        }

        if wants("codex") {
            let codex_home = std::env::var("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home_dir.join(".codex"));
            scan_codex_tools(&codex_home.join("sessions"), cutoff, &mut cache, &mut out);
            scan_codex_tools(
                &codex_home.join("archived_sessions"),
                cutoff,
                &mut cache,
                &mut out,
            );
        }

        if wants("pi") {
            let pi_root = std::env::var("PI_CODING_AGENT_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home_dir.join(".pi").join("agent"))
                .join("sessions");
            scan_pi_tools(&pi_root, cutoff, &mut cache, &mut out);
        }

        if wants("antigravity") || wants("antigravity-cli") || wants("antigravity-extension") {
            let gemini_dir = home_dir.join(".gemini");
            scan_antigravity_tools(
                &gemini_dir.join("antigravity-cli").join("brain"),
                cutoff,
                &mut cache,
                &mut out,
            );
            scan_antigravity_tools(
                &gemini_dir.join("antigravity").join("brain"),
                cutoff,
                &mut cache,
                &mut out,
            );
        }

        if wants("opencode") {
            scan_opencode_tools(home_dir, cutoff, &mut cache, &mut out);
        }

        if let Some(cp) = cache_path {
            cache.save_if_dirty(cp);
        }

        out
    }

    fn resolve_session_id<'a>(&'a self, agent: &str, session_id: &'a str) -> &'a str {
        self.session_aliases
            .get(&(agent.to_string(), session_id.to_string()))
            .map(String::as_str)
            .unwrap_or(session_id)
    }

    pub fn lookup_model_tool_calls(
        &self,
        agent: &str,
        session_id: &str,
        hour_bucket: DateTime<Utc>,
        model: &str,
    ) -> Option<&BTreeMap<String, i32>> {
        if model.is_empty() {
            return None;
        }
        let key = (
            agent.to_string(),
            session_id.to_string(),
            hour_bucket,
            model.to_string(),
        );
        if let Some(tools) = self.model_tool_calls.get(&key) {
            return Some(tools);
        }
        let canonical = self.resolve_session_id(agent, session_id);
        if canonical != session_id {
            return self.model_tool_calls.get(&(
                agent.to_string(),
                canonical.to_string(),
                hour_bucket,
                model.to_string(),
            ));
        }
        None
    }

    pub fn collect_remaining_tool_calls(
        &self,
        agent: &str,
        session_id: &str,
        hour_bucket: DateTime<Utc>,
        consumed_models: &HashSet<(String, String, DateTime<Utc>, String)>,
    ) -> BTreeMap<String, i32> {
        let mut out = BTreeMap::new();
        let canonical = self.resolve_session_id(agent, session_id);
        let mut sids = vec![session_id];
        if canonical != session_id {
            sids.push(canonical);
        }

        for sid in &sids {
            if let Some(tools) = self
                .tool_calls
                .get(&(agent.to_string(), (*sid).to_string(), hour_bucket))
            {
                for (name, count) in tools {
                    *out.entry(name.clone()).or_insert(0) += *count;
                }
            }
        }

        for ((a, sid, b, model), tools) in &self.model_tool_calls {
            if a != agent || *b != hour_bucket || !sids.contains(&sid.as_str()) {
                continue;
            }
            if consumed_models.contains(&(
                agent.to_string(),
                session_id.to_string(),
                hour_bucket,
                model.clone(),
            )) {
                continue;
            }
            for (name, count) in tools {
                *out.entry(name.clone()).or_insert(0) += *count;
            }
        }

        out
    }

    #[cfg(test)]
    pub fn lookup_tool_calls(
        &self,
        agent: &str,
        session_id: &str,
        hour_bucket: DateTime<Utc>,
    ) -> Option<BTreeMap<String, i32>> {
        let merged = self.collect_remaining_tool_calls(
            agent,
            session_id,
            hour_bucket,
            &HashSet::new(),
        );
        if merged.is_empty() {
            None
        } else {
            Some(merged)
        }
    }

    fn merge_cached_entry_filtered(
        &mut self,
        agent: &str,
        entry: &CachedFileEntry,
        cutoff_bucket_ts: Option<i64>,
        skip_sessions: Option<&HashSet<String>>,
    ) {
        for (alias, primary) in &entry.aliases {
            self.session_aliases
                .entry((agent.to_string(), alias.clone()))
                .or_insert_with(|| primary.clone());
        }
        for (sid, is_sub, parent) in &entry.subagent_meta {
            self.subagent_meta
                .entry((agent.to_string(), sid.clone()))
                .or_insert_with(|| (*is_sub, parent.clone()));
        }
        for b in &entry.buckets {
            if let Some(skip) = skip_sessions {
                if skip.contains(&b.session_id) {
                    continue;
                }
            }
            if let Some(min_ts) = cutoff_bucket_ts {
                if b.hour_ts < min_ts {
                    continue;
                }
            }
            let Some(bucket) = DateTime::from_timestamp(b.hour_ts, 0) else {
                continue;
            };
            let dest = if b.model.is_empty() {
                self.tool_calls
                    .entry((agent.to_string(), b.session_id.clone(), bucket))
                    .or_default()
            } else {
                self.model_tool_calls
                    .entry((
                        agent.to_string(),
                        b.session_id.clone(),
                        bucket,
                        b.model.clone(),
                    ))
                    .or_default()
            };
            for (name, count) in &b.tools {
                *dest.entry(name.clone()).or_insert(0) += *count;
            }
        }
    }
}

fn file_signature(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let modified_ns = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos() as u64;
    Some((meta.len(), modified_ns))
}

fn read_wal_sample(wal_path: &Path, size: u64) -> Vec<u8> {
    if size == 0 {
        return Vec::new();
    }
    let Ok(mut f) = File::open(wal_path) else {
        return Vec::new();
    };
    let mut sample = Vec::with_capacity(64);
    let head_len = size.min(32) as usize;
    let mut head = vec![0u8; head_len];
    if f.read_exact(&mut head).is_ok() {
        sample.extend_from_slice(&head);
    }
    if size > 32 {
        let tail_len = (size - 32).min(32) as usize;
        if f.seek(SeekFrom::End(-(tail_len as i64))).is_ok() {
            let mut tail = vec![0u8; tail_len];
            if f.read_exact(&mut tail).is_ok() {
                sample.extend_from_slice(&tail);
            }
        }
    }
    sample
}

fn sqlite_signature(db_path: &Path) -> Option<SqliteFileSig> {
    let (db_size, db_modified_ns) = file_signature(db_path)?;
    let mut wal_os = db_path.as_os_str().to_os_string();
    wal_os.push("-wal");
    let wal_path = PathBuf::from(wal_os);
    let (wal_exists, wal_size, wal_modified_ns, wal_sample) = match file_signature(&wal_path) {
        Some((s, m)) => (true, s, m, read_wal_sample(&wal_path, s)),
        None => (false, 0, 0, Vec::new()),
    };
    Some(SqliteFileSig {
        db_size,
        db_modified_ns,
        wal_exists,
        wal_size,
        wal_modified_ns,
        wal_sample,
    })
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

fn cutoff_bucket_ts(cutoff: Option<DateTime<Utc>>) -> Option<i64> {
    cutoff.map(|dt| truncate_hour(dt).timestamp())
}

fn parse_epoch_utc(raw: i64) -> Option<DateTime<Utc>> {
    if raw <= 0 {
        return None;
    }
    if raw > 1_000_000_000_000 {
        DateTime::from_timestamp_millis(raw)
    } else {
        DateTime::from_timestamp(raw, 0)
    }
}

fn parse_rfc3339_utc(v: &Value) -> Option<DateTime<Utc>> {
    if let Some(s) = v.as_str() {
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&Utc));
        }
        if let Ok(n) = s.trim().parse::<i64>() {
            return parse_epoch_utc(n);
        }
        return None;
    }
    if let Some(ms) = v.as_i64() {
        return parse_epoch_utc(ms);
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f > 0.0 {
            return parse_epoch_utc(f as i64);
        }
    }
    None
}

fn scan_file_cached<F>(
    agent: &str,
    path: &Path,
    cutoff: Option<DateTime<Utc>>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
    parse_fn: F,
) where
    F: FnOnce(&Path) -> FileScanResult,
{
    scan_file_cached_filtered(agent, path, cutoff, None, cache, out, parse_fn);
}

fn scan_file_cached_filtered<F>(
    agent: &str,
    path: &Path,
    cutoff: Option<DateTime<Utc>>,
    skip_sessions: Option<&HashSet<String>>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
    parse_fn: F,
) where
    F: FnOnce(&Path) -> FileScanResult,
{
    if !file_recently_modified(path, cutoff) {
        return;
    }
    let min_bucket = cutoff_bucket_ts(cutoff);
    let key = path.to_string_lossy().to_string();
    let sig = file_signature(path);

    if let Some((size, modified_ns)) = sig {
        if let Some(cached) = cache.files.get(&key) {
            if cached.size == size && cached.modified_ns == modified_ns {
                out.merge_cached_entry_filtered(agent, cached, min_bucket, skip_sessions);
                return;
            }
        }
    }

    let parsed = parse_fn(path);
    let buckets = parsed
        .tool_calls
        .into_iter()
        .map(|((session_id, hour_ts), tools)| CachedBucketTools {
            session_id,
            hour_ts,
            model: String::new(),
            tools,
        })
        .collect();
    let entry = CachedFileEntry {
        size: sig.map(|s| s.0).unwrap_or(0),
        modified_ns: sig.map(|s| s.1).unwrap_or(0),
        buckets,
        aliases: parsed.aliases,
        subagent_meta: parsed.subagent_meta,
    };
    out.merge_cached_entry_filtered(agent, &entry, min_bucket, skip_sessions);
    if sig.is_some() {
        cache.files.insert(key, entry);
        cache.dirty = true;
    }
}

fn scan_claude_tools(
    root: &Path,
    cutoff: Option<DateTime<Utc>>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
) {
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
        scan_file_cached("claude", path, cutoff, cache, out, parse_claude_tool_file);
    }
}

fn parse_claude_tool_file(path: &Path) -> FileScanResult {
    let mut res = FileScanResult::default();
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
        return res;
    };
    let reader = BufReader::new(file);
    let mut seen_aliases: HashSet<(String, String)> = HashSet::new();
    let mut seen_subagents: HashSet<String> = HashSet::new();

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
        if !entry_sid.is_empty()
            && entry_sid != sid
            && seen_aliases.insert((entry_sid.to_string(), sid.clone()))
        {
            res.aliases.push((entry_sid.to_string(), sid.clone()));
        }
        if !fallback_sid.is_empty()
            && fallback_sid != sid
            && seen_aliases.insert((fallback_sid.clone(), sid.clone()))
        {
            res.aliases.push((fallback_sid.clone(), sid.clone()));
        }
        if is_sidechain && seen_subagents.insert(sid.clone()) {
            let parent = if !inferred_parent.is_empty() && inferred_parent != sid {
                inferred_parent.clone()
            } else {
                String::new()
            };
            res.subagent_meta.push((sid.clone(), true, parent));
        }

        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(ts) = v.get("timestamp").and_then(parse_rfc3339_utc) else {
            continue;
        };
        let Some(blocks) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        let bucket_ts = truncate_hour(ts).timestamp();
        for block in blocks {
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                    let clean = name.trim();
                    if !clean.is_empty() {
                        *res.tool_calls
                            .entry((sid.clone(), bucket_ts))
                            .or_default()
                            .entry(clean.to_string())
                            .or_insert(0) += 1;
                    }
                }
            }
        }
    }
    res
}

fn scan_codex_tools(
    root: &Path,
    cutoff: Option<DateTime<Utc>>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
) {
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
        scan_file_cached("codex", path, cutoff, cache, out, parse_codex_tool_file);
    }
}

fn parse_codex_tool_file(path: &Path) -> FileScanResult {
    let mut res = FileScanResult::default();
    // tokscale-core keys Codex sessions by `session_id_from_path(path)` (file_stem, e.g.
    // `rollout-2026-11-25T10-00-00-<uuid>`), NOT `session_meta.payload.id`. Keep file_stem
    // as primary key and record payload.id only as a fallback alias.
    let file_sid = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if file_sid.is_empty() {
        return res;
    }

    let Ok(file) = File::open(path) else {
        return res;
    };
    let reader = BufReader::new(file);
    let mut seen_aliases: HashSet<String> = HashSet::new();

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
                if !trimmed.is_empty()
                    && trimmed != file_sid
                    && seen_aliases.insert(trimmed.to_string())
                {
                    res.aliases.push((trimmed.to_string(), file_sid.clone()));
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
            let bucket_ts = truncate_hour(ts).timestamp();
            *res.tool_calls
                .entry((file_sid.clone(), bucket_ts))
                .or_default()
                .entry(clean)
                .or_insert(0) += 1;
        }
    }
    res
}

fn scan_pi_tools(
    root: &Path,
    cutoff: Option<DateTime<Utc>>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
) {
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
        scan_file_cached("pi", path, cutoff, cache, out, parse_pi_tool_file);
    }
}

fn parse_pi_tool_file(path: &Path) -> FileScanResult {
    let mut res = FileScanResult::default();
    let mut sid = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let Ok(file) = File::open(path) else {
        return res;
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
        let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        let bucket_ts = truncate_hour(ts).timestamp();
        for block in blocks {
            if block.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                    let clean = name.trim();
                    if !clean.is_empty() && !sid.is_empty() {
                        *res.tool_calls
                            .entry((sid.clone(), bucket_ts))
                            .or_default()
                            .entry(clean.to_string())
                            .or_insert(0) += 1;
                    }
                }
            }
        }
    }
    res
}

fn scan_antigravity_tools(
    brain_root: &Path,
    cutoff: Option<DateTime<Utc>>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
) {
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
        if !transcript.is_file() {
            continue;
        }
        scan_file_cached("antigravity", &transcript, cutoff, cache, out, |p| {
            parse_antigravity_transcript(p, &conv_id)
        });
    }
}

fn parse_antigravity_transcript(path: &Path, conv_id: &str) -> FileScanResult {
    let mut res = FileScanResult::default();
    let Ok(file) = File::open(path) else {
        return res;
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
        let bucket_ts = truncate_hour(ts).timestamp();
        for call in calls {
            if let Some(name) = call.get("name").and_then(|n| n.as_str()) {
                let clean = name.trim();
                if !clean.is_empty() {
                    *res.tool_calls
                        .entry((conv_id.to_string(), bucket_ts))
                        .or_default()
                        .entry(clean.to_string())
                        .or_insert(0) += 1;
                }
            }
        }
    }
    res
}

// =============================================================================
// OpenCode tool usage scanner (SQLite v2 session_message, SQLite v1 part, legacy JSON)
// =============================================================================

fn is_opencode_db_filename(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".db") else {
        return false;
    };
    if stem == "opencode" {
        return true;
    }
    let Some(channel) = stem.strip_prefix("opencode-") else {
        return false;
    };
    !channel.is_empty()
        && channel
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn discover_opencode_dirs_and_dbs(home_dir: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut data_dirs: Vec<PathBuf> = Vec::new();
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();

    let mut push_dir = |p: PathBuf| {
        if !p.is_dir() {
            return;
        }
        let canon = fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
        if seen_dirs.insert(canon) {
            data_dirs.push(p);
        }
    };

    if let Ok(explicit_dir) = std::env::var("OPENCODE_DATA_DIR") {
        let trimmed = explicit_dir.trim();
        if !trimmed.is_empty() {
            push_dir(PathBuf::from(trimmed));
        }
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            push_dir(PathBuf::from(trimmed).join("opencode"));
        }
    }
    push_dir(home_dir.join(".local").join("share").join("opencode"));
    if let Some(local_data) = dirs::data_local_dir() {
        push_dir(local_data.join("opencode"));
    }

    let mut dbs: Vec<PathBuf> = Vec::new();
    let mut seen_dbs: HashSet<PathBuf> = HashSet::new();

    let mut push_db = |path: PathBuf| {
        if !path.is_file() {
            return;
        }
        let canon = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen_dbs.insert(canon) {
            dbs.push(path);
        }
    };

    if let Ok(env_db) = std::env::var("OPENCODE_DB") {
        let trimmed = env_db.trim();
        if !trimmed.is_empty() {
            push_db(PathBuf::from(trimmed));
        }
    }

    for dir in &data_dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        let mut dir_dbs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                let name = p.file_name()?.to_str()?;
                if !is_opencode_db_filename(name) {
                    return None;
                }
                if !p.is_file() {
                    return None;
                }
                Some(p)
            })
            .collect();
        dir_dbs.sort_unstable();
        for p in dir_dbs {
            push_db(p);
        }
    }

    (data_dirs, dbs)
}

fn scan_opencode_tools(
    home_dir: &Path,
    cutoff: Option<DateTime<Utc>>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
) {
    let (data_dirs, dbs) = discover_opencode_dirs_and_dbs(home_dir);
    let mut covered_sessions: HashSet<String> = HashSet::new();

    for db_path in &dbs {
        scan_opencode_sqlite_cached(db_path, cutoff, cache, out, &mut covered_sessions);
    }

    // Legacy JSON parts (<1.2): `<data_dir>/storage/part/<msg_id>/*.json`
    for dir in &data_dirs {
        let part_dir = dir.join("storage").join("part");
        if part_dir.is_dir() {
            scan_opencode_legacy_parts(&part_dir, cutoff, &covered_sessions, cache, out);
        }
    }
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [table],
        |_| Ok(true),
    )
    .unwrap_or(false)
}

fn table_columns(conn: &Connection, table: &str) -> HashSet<String> {
    let mut cols = HashSet::new();
    let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return cols;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return cols;
    };
    for name in rows.flatten() {
        cols.insert(name.to_ascii_lowercase());
    }
    cols
}

fn extract_opencode_model_id(v: &Value) -> String {
    v.get("modelID")
        .and_then(Value::as_str)
        .or_else(|| v.pointer("/model/id").and_then(Value::as_str))
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn extract_opencode_tool_name(item: &Value) -> Option<&str> {
    let kind = item.get("type").and_then(Value::as_str)?;
    let is_tool_part = matches!(
        kind,
        "tool" | "tool-call" | "tool-invocation" | "tool_use" | "tool_call" | "dynamic-tool"
    ) || kind.starts_with("tool-");
    if !is_tool_part {
        return None;
    }
    item.get("name")
        .or_else(|| item.get("tool"))
        .or_else(|| item.get("toolName"))
        .or_else(|| item.pointer("/toolInvocation/toolName"))
        .or_else(|| item.pointer("/toolInvocation/name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn scan_opencode_sqlite_cached(
    db_path: &Path,
    cutoff: Option<DateTime<Utc>>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
    covered_sessions: &mut HashSet<String>,
) {
    let key = db_path.to_string_lossy().to_string();
    let req_cutoff_ms = cutoff.map(|dt| dt.timestamp_millis());
    let min_bucket = cutoff_bucket_ts(cutoff);
    let sig = sqlite_signature(db_path);

    if let Some(ref cur_sig) = sig {
        if let Some(cached) = cache.opencode_dbs.get(&key) {
            let covers = cached.full_history
                || match (cached.min_cutoff_ms, req_cutoff_ms) {
                    (Some(c), Some(r)) => c <= r,
                    _ => false,
                };
            if cached.sig == *cur_sig && covers {
                for sid in &cached.covered_sessions {
                    covered_sessions.insert(sid.clone());
                }
                merge_opencode_db_results(
                    &cached.buckets,
                    &cached.subagent_meta,
                    min_bucket,
                    out,
                );
                return;
            }
        }
    }

    let Some(scanned) = scan_opencode_sqlite_db(db_path, cutoff) else {
        return;
    };

    for sid in &scanned.covered_sessions {
        covered_sessions.insert(sid.clone());
    }
    merge_opencode_db_results(&scanned.buckets, &scanned.subagent_meta, min_bucket, out);

    if let Some(cur_sig) = sig {
        let entry = CachedOpenCodeDb {
            sig: cur_sig,
            full_history: cutoff.is_none(),
            min_cutoff_ms: req_cutoff_ms,
            buckets: scanned.buckets,
            subagent_meta: scanned.subagent_meta,
            covered_sessions: scanned.covered_sessions,
        };
        cache.opencode_dbs.insert(key, entry);
        cache.dirty = true;
    }
}

fn merge_opencode_db_results(
    buckets: &[CachedBucketTools],
    subagent_meta: &[(String, bool, String)],
    min_bucket_ts: Option<i64>,
    out: &mut ToolSidecar,
) {
    for (sid, is_sub, parent) in subagent_meta {
        out.subagent_meta
            .entry(("opencode".to_string(), sid.clone()))
            .or_insert_with(|| (*is_sub, parent.clone()));
    }
    for b in buckets {
        if let Some(min_ts) = min_bucket_ts {
            if b.hour_ts < min_ts {
                continue;
            }
        }
        let Some(bucket) = DateTime::from_timestamp(b.hour_ts, 0) else {
            continue;
        };
        let dest = if b.model.is_empty() {
            out.tool_calls
                .entry(("opencode".to_string(), b.session_id.clone(), bucket))
                .or_default()
        } else {
            out.model_tool_calls
                .entry((
                    "opencode".to_string(),
                    b.session_id.clone(),
                    bucket,
                    b.model.clone(),
                ))
                .or_default()
        };
        for (name, count) in &b.tools {
            *dest.entry(name.clone()).or_insert(0) += *count;
        }
    }
}

struct OpenCodeDbScan {
    buckets: Vec<CachedBucketTools>,
    subagent_meta: Vec<(String, bool, String)>,
    covered_sessions: Vec<String>,
}

fn scan_opencode_sqlite_db(db_path: &Path, cutoff: Option<DateTime<Utc>>) -> Option<OpenCodeDbScan> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
    conn.execute_batch("BEGIN DEFERRED").ok()?;

    // Key: (session_id, hour_bucket_ts, model) -> { tool_name: count }
    let mut tool_map: HashMap<(String, i64, String), BTreeMap<String, i32>> = HashMap::new();
    let mut subagent_map: HashMap<String, String> = HashMap::new();
    // Sessions that genuinely have assistant rows in `session_message` (v2).
    let mut v2_msg_sessions: HashSet<String> = HashSet::new();
    let mut all_covered: HashSet<String> = HashSet::new();

    // 1h safety margin on SQL predicates to guard against minor clock / timestamp skew.
    let sql_cutoff_ms = cutoff.map(|dt| (dt - Duration::hours(1)).timestamp_millis());
    let sql_cutoff_sec = cutoff.map(|dt| (dt - Duration::hours(1)).timestamp());

    let has_session_v2 = table_exists(&conn, "session_v2");
    let has_session_v1 = table_exists(&conn, "session");
    let has_session_message = table_exists(&conn, "session_message");
    let has_message = table_exists(&conn, "message");
    let has_part = table_exists(&conn, "part");

    // 1. Read `session_v2` parent_id metadata when available.
    // Do NOT blindly mark every `session_v2` row as covered by `session_message`: partially
    // migrated databases may still keep tool parts in v1 `part` for sessions absent from
    // `session_message`.
    if has_session_v2 {
        let cols = table_columns(&conn, "session_v2");
        if cols.contains("id") && cols.contains("parent_id") {
            if let Ok(mut stmt) = conn.prepare("SELECT id, parent_id FROM session_v2") {
                if let Ok(rows) = stmt.query_map([], |row| {
                    let id: String = row.get(0)?;
                    let parent_id: Option<String> = row.get(1).ok().flatten();
                    Ok((id, parent_id))
                }) {
                    for row in rows.flatten() {
                        let sid = row.0.trim().to_string();
                        if sid.is_empty() {
                            continue;
                        }
                        if let Some(pid) = row.1.as_deref().map(str::trim).filter(|s| !s.is_empty())
                        {
                            subagent_map.entry(sid).or_insert_with(|| pid.to_string());
                        }
                    }
                }
            }
        }
    }

    // 2. Scan OpenCode v2 `session_message`.
    if has_session_message {
        let sm_cols = table_columns(&conn, "session_message");
        let sm_has_type = sm_cols.contains("type");
        let sm_has_time_created = sm_cols.contains("time_created");

        // Record which sessions actually have assistant messages in `session_message` so v1
        // `part` scanning skips ONLY genuinely migrated sessions (uses index on session_id/type).
        let distinct_sql = if sm_has_type {
            "SELECT DISTINCT session_id FROM session_message WHERE type = 'assistant'"
        } else {
            "SELECT DISTINCT session_id FROM session_message"
        };
        if let Ok(mut stmt) = conn.prepare(distinct_sql) {
            if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                for sid in rows.flatten() {
                    let sid = sid.trim().to_string();
                    if !sid.is_empty() {
                        v2_msg_sessions.insert(sid.clone());
                        all_covered.insert(sid);
                    }
                }
            }
        }

        let mut handle_v2_row = |sid: String, row_ts: i64, data: String| {
            let sid = sid.trim().to_string();
            if sid.is_empty() {
                return;
            }
            v2_msg_sessions.insert(sid.clone());
            all_covered.insert(sid.clone());
            // Fast pre-filter before JSON parsing (accepts "tool", "tool-call", "tool_use", etc.).
            if !data.contains("tool") {
                return;
            }
            let Ok(v) = serde_json::from_str::<Value>(&data) else {
                return;
            };
            if let Some(role) = v.get("role").and_then(Value::as_str) {
                if role != "assistant" {
                    return;
                }
            }
            let Some(ts) = v
                .pointer("/time/created")
                .and_then(parse_rfc3339_utc)
                .or_else(|| parse_epoch_utc(row_ts))
            else {
                return;
            };
            if let Some(min_ts) = cutoff {
                if ts < min_ts {
                    return;
                }
            }
            let Some(items) = v
                .get("content")
                .and_then(Value::as_array)
                .or_else(|| v.get("parts").and_then(Value::as_array))
            else {
                return;
            };
            let model = extract_opencode_model_id(&v);
            let bucket_ts = truncate_hour(ts).timestamp();
            for item in items {
                if let Some(clean) = extract_opencode_tool_name(item) {
                    *tool_map
                        .entry((sid.clone(), bucket_ts, model.clone()))
                        .or_default()
                        .entry(clean.to_string())
                        .or_insert(0) += 1;
                }
            }
        };

        let type_filter = if sm_has_type {
            "type = 'assistant'"
        } else {
            "1 = 1"
        };

        if let (Some(min_ms), Some(min_sec), true) =
            (sql_cutoff_ms, sql_cutoff_sec, sm_has_time_created)
        {
            let sql = format!(
                "SELECT session_id, time_created, data FROM session_message \
                 WHERE {type_filter} AND (time_created >= ?1 OR (time_created > 0 AND time_created < 1000000000000 AND time_created >= ?2) OR time_created IS NULL OR time_created = 0)"
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                if let Ok(rows) = stmt.query_map(rusqlite::params![min_ms, min_sec], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1).unwrap_or(0),
                        row.get::<_, String>(2)?,
                    ))
                }) {
                    for row in rows.flatten() {
                        handle_v2_row(row.0, row.1, row.2);
                    }
                }
            }
        } else {
            let ts_expr = if sm_has_time_created {
                "COALESCE(time_created, 0)"
            } else {
                "0"
            };
            let sql = format!(
                "SELECT session_id, {ts_expr}, data FROM session_message WHERE {type_filter}"
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1).unwrap_or(0),
                        row.get::<_, String>(2)?,
                    ))
                }) {
                    for row in rows.flatten() {
                        handle_v2_row(row.0, row.1, row.2);
                    }
                }
            }
        }
    }

    // 3. Scan OpenCode v1 `session` + `part` (joined with `message` for accurate hour_bucket & model)
    // ONLY for sessions NOT already present in v2 `session_message`!
    // On fully-migrated v2 databases, `v1_only_sessions` is empty so legacy `part` is never touched.
    let mut v1_only_sessions: Vec<String> = Vec::new();
    let mut seen_v1_sessions: HashSet<String> = HashSet::new();
    if has_session_v1 {
        let s_cols = table_columns(&conn, "session");
        if s_cols.contains("id") {
            let parent_expr = if s_cols.contains("parent_id") {
                "parent_id"
            } else {
                "NULL"
            };
            let mut collect_session_row = |id: String, parent_id: Option<String>| {
                let sid = id.trim().to_string();
                if sid.is_empty() {
                    return;
                }
                all_covered.insert(sid.clone());
                if let Some(pid) = parent_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    subagent_map.entry(sid.clone()).or_insert_with(|| pid.to_string());
                }
                if !v2_msg_sessions.contains(&sid) && seen_v1_sessions.insert(sid.clone()) {
                    v1_only_sessions.push(sid);
                }
            };

            if let (Some(min_ms), Some(min_sec), true) =
                (sql_cutoff_ms, sql_cutoff_sec, s_cols.contains("time_updated"))
            {
                let sql = format!(
                    "SELECT id, {parent_expr} FROM session \
                     WHERE time_updated >= ?1 OR (time_updated > 0 AND time_updated < 1000000000000 AND time_updated >= ?2) OR time_updated IS NULL OR time_updated = 0"
                );
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    if let Ok(rows) = stmt.query_map(rusqlite::params![min_ms, min_sec], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1).ok().flatten()))
                    }) {
                        for row in rows.flatten() {
                            collect_session_row(row.0, row.1);
                        }
                    }
                }
            } else {
                let sql = format!("SELECT id, {parent_expr} FROM session");
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    if let Ok(rows) = stmt.query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1).ok().flatten()))
                    }) {
                        for row in rows.flatten() {
                            collect_session_row(row.0, row.1);
                        }
                    }
                }
            }
        }
    }

    if has_part {
        let p_cols = table_columns(&conn, "part");
        let m_cols = if has_message {
            table_columns(&conn, "message")
        } else {
            HashSet::new()
        };
        let can_join_message = has_message
            && p_cols.contains("message_id")
            && m_cols.contains("id")
            && m_cols.contains("data");
        let p_has_ts = p_cols.contains("time_created");
        let m_has_ts = can_join_message && m_cols.contains("time_created");

        let mut handle_v1_part =
            |sid: String, part_ts: i64, part_data: String, msg_ts: i64, msg_data: Option<String>| {
                let sid = sid.trim().to_string();
                if sid.is_empty() || v2_msg_sessions.contains(&sid) {
                    return;
                }
                if !part_data.contains("tool") {
                    return;
                }
                let Ok(v) = serde_json::from_str::<Value>(&part_data) else {
                    return;
                };
                let Some(clean) = extract_opencode_tool_name(&v) else {
                    return;
                };

                // Align timestamp & model with the parent `message` row (matching tokscale-core,
                // which buckets usage by `message.data -> $.time.created`). Fall back to part
                // timestamps when message metadata is absent.
                let msg_val = msg_data
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                let model = msg_val
                    .as_ref()
                    .map(extract_opencode_model_id)
                    .unwrap_or_default();
                let Some(ts) = msg_val
                    .as_ref()
                    .and_then(|mv| mv.pointer("/time/created").and_then(parse_rfc3339_utc))
                    .or_else(|| parse_epoch_utc(msg_ts))
                    .or_else(|| parse_epoch_utc(part_ts))
                    .or_else(|| v.pointer("/state/time/start").and_then(parse_rfc3339_utc))
                    .or_else(|| v.pointer("/time/start").and_then(parse_rfc3339_utc))
                    .or_else(|| v.pointer("/time/created").and_then(parse_rfc3339_utc))
                else {
                    return;
                };
                if let Some(min_ts) = cutoff {
                    if ts < min_ts {
                        return;
                    }
                }
                all_covered.insert(sid.clone());
                let bucket_ts = truncate_hour(ts).timestamp();
                *tool_map
                    .entry((sid, bucket_ts, model))
                    .or_default()
                    .entry(clean.to_string())
                    .or_insert(0) += 1;
            };

        let p_ts_expr = if p_has_ts { "COALESCE(p.time_created, 0)" } else { "0" };
        let m_ts_expr = if m_has_ts { "COALESCE(m.time_created, 0)" } else { "0" };

        if has_session_v1 {
            // Query `part` strictly per v1-only session via `part_session_idx`!
            if !v1_only_sessions.is_empty() && p_cols.contains("session_id") && p_cols.contains("data") {
                let sql = if can_join_message {
                    format!(
                        "SELECT {p_ts_expr}, p.data, {m_ts_expr}, m.data \
                         FROM part p LEFT JOIN message m ON m.id = p.message_id \
                         WHERE p.session_id = ?1"
                    )
                } else {
                    format!(
                        "SELECT {p_ts_expr}, p.data, 0, NULL FROM part p WHERE p.session_id = ?1"
                    )
                };
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    for sid in &v1_only_sessions {
                        if let Ok(rows) = stmt.query_map([sid.as_str()], |row| {
                            Ok((
                                row.get::<_, i64>(0).unwrap_or(0),
                                row.get::<_, String>(1)?,
                                row.get::<_, i64>(2).unwrap_or(0),
                                row.get::<_, Option<String>>(3).ok().flatten(),
                            ))
                        }) {
                            for row in rows.flatten() {
                                handle_v1_part(sid.clone(), row.0, row.1, row.2, row.3);
                            }
                        }
                    }
                }
            }
        } else if !has_session_message && p_cols.contains("session_id") && p_cols.contains("data") {
            // Rare minimal DB with `part` and neither `session` nor `session_message`.
            let from_clause = if can_join_message {
                "FROM part p LEFT JOIN message m ON m.id = p.message_id"
            } else {
                "FROM part p"
            };
            let m_data_expr = if can_join_message { "m.data" } else { "NULL" };

            if let (Some(min_ms), Some(min_sec), true) = (sql_cutoff_ms, sql_cutoff_sec, p_has_ts) {
                let sql = format!(
                    "SELECT p.session_id, {p_ts_expr}, p.data, {m_ts_expr}, {m_data_expr} {from_clause} \
                     WHERE p.time_created >= ?1 OR (p.time_created > 0 AND p.time_created < 1000000000000 AND p.time_created >= ?2) OR p.time_created IS NULL OR p.time_created = 0"
                );
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    if let Ok(rows) = stmt.query_map(rusqlite::params![min_ms, min_sec], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1).unwrap_or(0),
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3).unwrap_or(0),
                            row.get::<_, Option<String>>(4).ok().flatten(),
                        ))
                    }) {
                        for row in rows.flatten() {
                            handle_v1_part(row.0, row.1, row.2, row.3, row.4);
                        }
                    }
                }
            } else {
                let sql = format!(
                    "SELECT p.session_id, {p_ts_expr}, p.data, {m_ts_expr}, {m_data_expr} {from_clause}"
                );
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    if let Ok(rows) = stmt.query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1).unwrap_or(0),
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3).unwrap_or(0),
                            row.get::<_, Option<String>>(4).ok().flatten(),
                        ))
                    }) {
                        for row in rows.flatten() {
                            handle_v1_part(row.0, row.1, row.2, row.3, row.4);
                        }
                    }
                }
            }
        }
    }

    let buckets = tool_map
        .into_iter()
        .map(|((session_id, hour_ts, model), tools)| CachedBucketTools {
            session_id,
            hour_ts,
            model,
            tools,
        })
        .collect();
    let subagent_meta = subagent_map
        .into_iter()
        .map(|(sid, parent)| (sid, true, parent))
        .collect();
    let covered_sessions = all_covered.into_iter().collect();

    Some(OpenCodeDbScan {
        buckets,
        subagent_meta,
        covered_sessions,
    })
}

fn scan_opencode_legacy_parts(
    part_root: &Path,
    cutoff: Option<DateTime<Utc>>,
    covered_sessions: &HashSet<String>,
    cache: &mut ToolCache,
    out: &mut ToolSidecar,
) {
    for entry in WalkDir::new(part_root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if !file_recently_modified(path, cutoff) {
            continue;
        }
        // Cache the raw parsed part file unconditionally and apply `covered_sessions` filtering
        // only at merge time so cache entries remain valid when SQLite coverage changes.
        scan_file_cached_filtered(
            "opencode",
            path,
            cutoff,
            Some(covered_sessions),
            cache,
            out,
            parse_opencode_legacy_part_file,
        );
    }
}

fn parse_opencode_legacy_part_file(path: &Path) -> FileScanResult {
    let mut res = FileScanResult::default();
    let Ok(raw) = fs::read_to_string(path) else {
        return res;
    };
    if !raw.contains("tool") {
        return res;
    }
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return res;
    };
    let Some(name) = extract_opencode_tool_name(&v) else {
        return res;
    };
    let Some(sid) = v
        .get("sessionID")
        .or_else(|| v.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return res;
    };
    let ts = v
        .pointer("/state/time/start")
        .and_then(parse_rfc3339_utc)
        .or_else(|| v.pointer("/time/start").and_then(parse_rfc3339_utc))
        .or_else(|| v.pointer("/time/created").and_then(parse_rfc3339_utc))
        .or_else(|| {
            fs::metadata(path)
                .ok()
                .and_then(|m| m.modified().ok())
                .map(DateTime::<Utc>::from)
        });
    let Some(ts) = ts else {
        return res;
    };
    let bucket_ts = truncate_hour(ts).timestamp();
    *res.tool_calls
        .entry((sid.to_string(), bucket_ts))
        .or_default()
        .entry(name.to_string())
        .or_insert(0) += 1;
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

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

        let mut cache = ToolCache::default();
        let mut sidecar = ToolSidecar::default();
        scan_codex_tools(&dir, None, &mut cache, &mut sidecar);

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

        // Second scan reuses cache cleanly
        let cache_file = dir.join("tool-cache.json");
        cache.save_if_dirty(&cache_file);
        let mut cache2 = ToolCache::load(&cache_file);
        let mut sidecar2 = ToolSidecar::default();
        scan_codex_tools(&dir, None, &mut cache2, &mut sidecar2);
        assert!(!cache2.dirty, "second scan on unchanged file must hit cache");
        assert_eq!(
            sidecar2.lookup_tool_calls("codex", stem, bucket),
            Some(tools)
        );

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

        let mut cache = ToolCache::default();
        let mut sidecar = ToolSidecar::default();
        scan_antigravity_tools(&dir, None, &mut cache, &mut sidecar);

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

    #[test]
    fn test_opencode_sqlite_v2_and_v1_tools_without_double_counting() {
        let dir = unique_tmp_dir("opencode-sqlite");
        let db_path = dir.join("opencode.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                time_updated INTEGER NOT NULL
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                time_updated INTEGER NOT NULL
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .unwrap();

        let ts_v2 = DateTime::parse_from_rfc3339("2026-11-25T14:20:00Z")
            .unwrap()
            .timestamp_millis();
        let ts_v1 = DateTime::parse_from_rfc3339("2026-11-24T09:15:00Z")
            .unwrap()
            .timestamp_millis();

        // Session migrated into v2 (exists in BOTH session_v2 and session, with parts in both!)
        conn.execute(
            "INSERT INTO session_v2 (id, parent_id, time_updated) VALUES (?1, ?2, ?3)",
            rusqlite::params!["ses_migrated", "ses_root", ts_v2],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, parent_id, time_updated) VALUES (?1, ?2, ?3)",
            rusqlite::params!["ses_migrated", "ses_root", ts_v2],
        )
        .unwrap();
        let v2_msg = format!(
            r#"{{"time":{{"created":{ts_v2}}},"content":[{{"type":"reasoning","text":"hi"}},{{"type":"tool","id":"c1","name":"shell"}},{{"type":"tool","id":"c2","name":"patch"}},{{"type":"tool","id":"c3","name":"shell"}}]}}"#
        );
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?1, ?2, 'assistant', ?3, ?4)",
            rusqlite::params!["msg_1", "ses_migrated", ts_v2, v2_msg],
        )
        .unwrap();
        // Duplicate legacy part row for the same migrated session — must NOT double count!
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                "prt_dup",
                "msg_1",
                "ses_migrated",
                ts_v2,
                r#"{"type":"tool","tool":"shell"}"#
            ],
        )
        .unwrap();

        // Unmigrated v1-only session — must be read from `part`!
        conn.execute(
            "INSERT INTO session (id, parent_id, time_updated) VALUES (?1, NULL, ?2)",
            rusqlite::params!["ses_v1_only", ts_v1],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                "prt_1",
                "msg_old",
                "ses_v1_only",
                ts_v1,
                r#"{"type":"tool","tool":"webfetch"}"#
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                "prt_2",
                "msg_old",
                "ses_v1_only",
                ts_v1,
                r#"{"type":"text","text":"not a tool"}"#
            ],
        )
        .unwrap();
        drop(conn);

        let mut cache = ToolCache::default();
        let mut sidecar = ToolSidecar::default();
        let mut covered = HashSet::new();
        scan_opencode_sqlite_cached(&db_path, None, &mut cache, &mut sidecar, &mut covered);

        let b_v2 = DateTime::parse_from_rfc3339("2026-11-25T14:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let t_v2 = sidecar
            .lookup_tool_calls("opencode", "ses_migrated", b_v2)
            .expect("should read OpenCode v2 tool calls");
        assert_eq!(t_v2.get("shell"), Some(&2));
        assert_eq!(t_v2.get("patch"), Some(&1));

        assert_eq!(
            sidecar
                .subagent_meta
                .get(&("opencode".to_string(), "ses_migrated".to_string())),
            Some(&(true, "ses_root".to_string()))
        );

        let b_v1 = DateTime::parse_from_rfc3339("2026-11-24T09:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let t_v1 = sidecar
            .lookup_tool_calls("opencode", "ses_v1_only", b_v1)
            .expect("should read unmigrated OpenCode v1 tool calls");
        assert_eq!(t_v1.get("webfetch"), Some(&1));
        assert_eq!(t_v1.len(), 1);

        // Save cache and verify second scan hits cache cleanly
        let cache_file = dir.join("tool-cache.json");
        cache.save_if_dirty(&cache_file);
        let mut cache2 = ToolCache::load(&cache_file);
        let mut sidecar2 = ToolSidecar::default();
        let mut covered2 = HashSet::new();
        scan_opencode_sqlite_cached(&db_path, None, &mut cache2, &mut sidecar2, &mut covered2);
        assert!(!cache2.dirty, "unchanged opencode.db must hit cache");
        assert_eq!(
            sidecar2.lookup_tool_calls("opencode", "ses_migrated", b_v2),
            Some(t_v2)
        );
        assert_eq!(
            sidecar2.lookup_tool_calls("opencode", "ses_v1_only", b_v1),
            Some(t_v1)
        );

        // Incremental cutoff after v1 excludes v1 tools while serving from full-history cache
        let cutoff = DateTime::parse_from_rfc3339("2026-11-25T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut sidecar3 = ToolSidecar::default();
        let mut covered3 = HashSet::new();
        scan_opencode_sqlite_cached(
            &db_path,
            Some(cutoff),
            &mut cache2,
            &mut sidecar3,
            &mut covered3,
        );
        assert!(!cache2.dirty);
        assert!(sidecar3
            .lookup_tool_calls("opencode", "ses_migrated", b_v2)
            .is_some());
        assert!(sidecar3
            .lookup_tool_calls("opencode", "ses_v1_only", b_v1)
            .is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_opencode_legacy_json_parts_scan() {
        let dir = unique_tmp_dir("opencode-legacy");
        let part_dir = dir.join("msg_001");
        fs::create_dir_all(&part_dir).unwrap();
        let ts = DateTime::parse_from_rfc3339("2026-11-25T16:45:00Z")
            .unwrap()
            .timestamp_millis();
        fs::write(
            part_dir.join("prt_001.json"),
            format!(
                r#"{{"type":"tool","tool":"bash","sessionID":"ses_legacy","state":{{"time":{{"start":{ts}}}}}}}"#
            ),
        )
        .unwrap();

        let mut cache = ToolCache::default();
        let mut sidecar = ToolSidecar::default();
        let covered = HashSet::new();
        scan_opencode_legacy_parts(&dir, None, &covered, &mut cache, &mut sidecar);

        let bucket = DateTime::parse_from_rfc3339("2026-11-25T16:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let tools = sidecar
            .lookup_tool_calls("opencode", "ses_legacy", bucket)
            .expect("should read legacy JSON part");
        assert_eq!(tools.get("bash"), Some(&1));

        // Re-scanning with `ses_legacy` now covered by SQLite must filter it out even on cache hit.
        let mut covered_after = HashSet::new();
        covered_after.insert("ses_legacy".to_string());
        let mut sidecar_covered = ToolSidecar::default();
        scan_opencode_legacy_parts(&dir, None, &covered_after, &mut cache, &mut sidecar_covered);
        assert!(sidecar_covered
            .lookup_tool_calls("opencode", "ses_legacy", bucket)
            .is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_opencode_v1_cross_hour_alignment_missing_columns_and_partial_v2() {
        let dir = unique_tmp_dir("opencode-edge-cases");
        let db_path = dir.join("opencode.db");
        let conn = Connection::open(&db_path).unwrap();
        // Deliberately omit `parent_id` and `time_updated` on `session`, omit `time_created` on
        // `session_message`, and include a `session_v2` row whose messages were NOT migrated yet.
        conn.execute_batch(
            "CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                directory TEXT NOT NULL
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                directory TEXT NOT NULL
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .unwrap();

        let msg_ts = DateTime::parse_from_rfc3339("2026-11-25T10:59:55Z")
            .unwrap()
            .timestamp_millis();
        let part_ts = DateTime::parse_from_rfc3339("2026-11-25T11:00:08Z")
            .unwrap()
            .timestamp_millis();
        let v2_ts = DateTime::parse_from_rfc3339("2026-11-25T12:10:00Z")
            .unwrap()
            .timestamp_millis();

        // Partially migrated: exists in `session_v2`, but has NO rows in `session_message`.
        conn.execute(
            "INSERT INTO session_v2 (id, directory) VALUES ('ses_partial', '/repo')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, directory) VALUES ('ses_partial', '/repo')",
            [],
        )
        .unwrap();
        let v1_msg_data = format!(
            r#"{{"role":"assistant","modelID":"claude-sonnet-4","time":{{"created":{msg_ts}}}}}"#
        );
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_cross', 'ses_partial', ?1, ?2)",
            rusqlite::params![msg_ts, v1_msg_data],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('prt_cross', 'msg_cross', 'ses_partial', ?1, ?2)",
            rusqlite::params![part_ts, r#"{"type":"tool","tool":"bash"}"#],
        )
        .unwrap();

        // v2 `session_message` without `time_created` column, using `tool-invocation` shape + model.
        let v2_data = format!(
            r#"{{"time":{{"created":{v2_ts}}},"model":{{"id":"gpt-6-astra"}},"content":[{{"type":"tool-invocation","toolInvocation":{{"toolName":"edit"}}}},{{"type":"tool-call","toolName":"read"}}]}}"#
        );
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, data) VALUES ('sm_1', 'ses_v2_notime', 'assistant', ?1)",
            rusqlite::params![v2_data],
        )
        .unwrap();
        drop(conn);

        let cutoff = DateTime::parse_from_rfc3339("2026-11-25T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut cache = ToolCache::default();
        let mut sidecar = ToolSidecar::default();
        let mut covered = HashSet::new();
        scan_opencode_sqlite_cached(&db_path, Some(cutoff), &mut cache, &mut sidecar, &mut covered);

        // Cross-hour v1 part must align to parent message's 10:00 bucket (NOT 11:00) AND carry model!
        let b10 = DateTime::parse_from_rfc3339("2026-11-25T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let t_partial = sidecar
            .lookup_model_tool_calls("opencode", "ses_partial", b10, "claude-sonnet-4")
            .expect("partially migrated v1 part should align to parent message hour & model");
        assert_eq!(t_partial.get("bash"), Some(&1));

        // v2 without `time_created` column must still parse tool-invocation & tool-call!
        let b12 = DateTime::parse_from_rfc3339("2026-11-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let t_v2 = sidecar
            .lookup_model_tool_calls("opencode", "ses_v2_notime", b12, "gpt-6-astra")
            .expect("v2 session_message without time_created should still extract tools");
        assert_eq!(t_v2.get("edit"), Some(&1));
        assert_eq!(t_v2.get("read"), Some(&1));

        let _ = fs::remove_dir_all(&dir);
    }
}
