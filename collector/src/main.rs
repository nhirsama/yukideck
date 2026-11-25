mod aggregate;
mod client;
mod config;
mod state;
mod tools;

use crate::aggregate::{collect_slices, normalize_agent_id};
use crate::client::YukiDeckClient;
use crate::config::{detect_hostname, CollectorConfig, ProjectPrivacy};
use crate::state::{acquire_sync_lock, CollectorState};
use anyhow::{anyhow, Result};
use chrono::Utc;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Parser)]
#[command(
    name = "yukideck-collector",
    version = crate::client::COLLECTOR_VERSION,
    about = "Lightweight oneshot AI Agent usage probe for YukiDeck"
)]
struct Cli {
    /// Override config file path
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    /// Override state file path
    #[arg(long, global = true)]
    state: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize collector configuration and verify server connectivity
    Init {
        /// YukiDeck server base URL (e.g. https://deck.example.com)
        #[arg(long)]
        server: String,

        /// YukiDeck global API key with `ai-usage:ingest` permission
        #[arg(long)]
        api_key: String,

        /// Human-readable device name (defaults to hostname)
        #[arg(long)]
        device_name: Option<String>,

        /// Comma-separated agent list (empty = auto-detect all supported agents)
        #[arg(long)]
        agents: Option<String>,

        /// Project name privacy mode: name | hash | none
        #[arg(long, default_value = "name")]
        project_privacy: ProjectPrivacy,

        /// Default incremental lookback window in hours
        #[arg(long, default_value_t = 48)]
        lookback_hours: u64,

        /// Skip server connectivity verification during init
        #[arg(long)]
        skip_verify: bool,
    },

    /// Inspect local discovered agents, pending slice delta, and server health
    #[command(alias = "status")]
    Doctor {
        /// Scan full history instead of default lookback window
        #[arg(long)]
        all: bool,
    },

    /// Synchronize AI Agent usage slices to YukiDeck (oneshot)
    Sync {
        /// Scan full history instead of incremental lookback window
        #[arg(long)]
        all: bool,

        /// Force re-upload even if slice hash matches local state
        #[arg(long)]
        force: bool,

        /// Print sanitized JSON payload locally without uploading
        #[arg(long)]
        dry_run: bool,

        /// Override lookback window in hours for this run
        #[arg(long)]
        lookback_hours: Option<u64>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg_path = cli.config.unwrap_or_else(CollectorConfig::default_config_path);
    let state_path = cli.state.unwrap_or_else(CollectorConfig::default_state_path);

    match cli.command {
        Commands::Init {
            server,
            api_key,
            device_name,
            agents,
            project_privacy,
            lookback_hours,
            skip_verify,
        } => {
            let existing = CollectorConfig::load(&cfg_path).ok();
            let device_id = existing
                .as_ref()
                .map(|c| c.device_id.clone())
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let agent_list = agents
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            let mut cfg = CollectorConfig {
                server_url: server,
                api_key,
                device_id,
                device_name: device_name.unwrap_or_else(detect_hostname),
                agents: agent_list,
                project_privacy,
                lookback_hours,
                batch_size: 200,
            };
            cfg.normalize();

            if !skip_verify {
                let cli = YukiDeckClient::new(&cfg)?;
                let resp = cli.verify_connection()?;
                println!("Server verified OK (device_id={}).", resp.device_id);
            }

            cfg.save(&cfg_path)?;
            println!("Saved config to {}", cfg_path.display());
            println!("Device ID: {}", cfg.device_id);
            Ok(())
        }

        Commands::Doctor { all } => {
            let cfg = CollectorConfig::load(&cfg_path)?;
            let st = CollectorState::load(&state_path);
            println!("Config:     {}", cfg_path.display());
            println!("State:      {}", state_path.display());
            println!("Server:     {}", cfg.server_url);
            println!("Device:     {} ({})", cfg.device_name, cfg.device_id);
            println!(
                "Agents:     {}",
                if cfg.agents.is_empty() {
                    "(auto-detect all)".to_string()
                } else {
                    cfg.agents.join(", ")
                }
            );
            println!("Privacy:    {:?}", cfg.project_privacy);
            if let Some(last) = st.last_synced_at {
                println!(
                    "Last sync:  {} ({} slices accepted, {} cached hashes)",
                    last.to_rfc3339(),
                    st.last_sync_accepted,
                    st.slice_hashes.len()
                );
            } else {
                println!("Last sync:  never");
            }

            let summary = collect_slices(&cfg, all, None)?;
            let scope = if all {
                "all history".to_string()
            } else {
                format!("{}h window", cfg.lookback_hours)
            };
            println!(
                "Local scan ({scope}): {} raw messages -> {} hourly slices",
                summary.raw_messages,
                summary.slices.len()
            );
            if let (Some(min_b), Some(max_b)) = (summary.earliest_bucket, summary.latest_bucket) {
                println!("Slice span: {} ~ {}", min_b.to_rfc3339(), max_b.to_rfc3339());
            }
            if summary.dropped_invalid_ts > 0
                || summary.dropped_cutoff > 0
                || summary.dropped_missing_fields > 0
            {
                println!(
                    "Dropped:    invalid_ts={}, before_cutoff={}, missing_fields={}",
                    summary.dropped_invalid_ts,
                    summary.dropped_cutoff,
                    summary.dropped_missing_fields
                );
            }
            if summary.client_counts.is_empty() {
                println!("Detected agents: (none)");
            } else {
                for (agent, count) in &summary.client_counts {
                    let norm = normalize_agent_id(agent);
                    let sc = summary.slices_by_agent.get(&norm).copied().unwrap_or(0);
                    if norm != *agent {
                        println!("  - {agent} (stored as {norm}): {count} raw messages -> {sc} slices");
                    } else {
                        println!("  - {agent}: {count} raw messages -> {sc} slices");
                    }
                }
            }

            let pending = summary
                .slices
                .iter()
                .filter(|s| st.slice_hashes.get(&s.slice_key()) != Some(&s.content_hash()))
                .count();
            println!("Pending changed slices: {pending}");

            let cli = YukiDeckClient::new(&cfg)?;
            match cli.verify_connection() {
                Ok(_) => println!("Connectivity: OK (ingest endpoint & API key verified)"),
                Err(e) => {
                    eprintln!("Connectivity: FAILED ({e})");
                    return Err(anyhow!("doctor connectivity check failed"));
                }
            }
            Ok(())
        }

        Commands::Sync {
            all,
            force,
            dry_run,
            lookback_hours,
        } => {
            let cfg = CollectorConfig::load(&cfg_path)?;
            let lock_path = CollectorConfig::lock_path_for(&state_path);
            let _lock = acquire_sync_lock(&lock_path)?;

            let mut st = CollectorState::load(&state_path);
            let summary = collect_slices(&cfg, all, lookback_hours)?;
            let total_slices = summary.slices.len();

            let mut to_upload = Vec::new();
            let mut next_hashes = Vec::new();
            let mut skipped_unchanged = 0usize;
            for sl in summary.slices {
                let key = sl.slice_key();
                let hash = sl.content_hash();
                if !force && st.slice_hashes.get(&key) == Some(&hash) {
                    skipped_unchanged += 1;
                    continue;
                }
                next_hashes.push((key, hash));
                to_upload.push(sl);
            }

            let mode_label = if all {
                "all".to_string()
            } else {
                format!("lookback={}h", lookback_hours.unwrap_or(cfg.lookback_hours))
            };
            let span_label = match (summary.earliest_bucket, summary.latest_bucket) {
                (Some(a), Some(b)) => format!("{} ~ {}", a.format("%Y-%m-%d"), b.format("%Y-%m-%d")),
                _ => "empty".to_string(),
            };

            if dry_run {
                println!("{}", serde_json::to_string_pretty(&to_upload)?);
                eprintln!(
                    "[dry-run] mode={mode_label} raw={} slices={total_slices} span=({span_label}) pending={} skipped_unchanged={skipped_unchanged} dropped=(ts:{},cutoff:{},fields:{})",
                    summary.raw_messages,
                    to_upload.len(),
                    summary.dropped_invalid_ts,
                    summary.dropped_cutoff,
                    summary.dropped_missing_fields
                );
                return Ok(());
            }

            if to_upload.is_empty() {
                println!(
                    "No changed slices to sync (mode={mode_label}, total={total_slices}, skipped_unchanged={skipped_unchanged}, span={span_label})."
                );
                return Ok(());
            }

            let cli = YukiDeckClient::new(&cfg)?;
            let mut total_accepted = 0usize;
            let batch_size = cfg.batch_size.clamp(1, 500);

            for (chunk, hashes_chunk) in to_upload
                .chunks(batch_size)
                .zip(next_hashes.chunks(batch_size))
            {
                let resp = cli.send_batch(chunk.to_vec(), force || all)?;
                total_accepted += resp.accepted;

                // Commit-after-2xx: only advance local state after server acknowledges this batch.
                for (k, h) in hashes_chunk {
                    st.slice_hashes.insert(k.clone(), h.clone());
                }
                st.prune_old_hashes(20_000);
                st.last_synced_at = Some(Utc::now());
                st.last_sync_accepted = total_accepted;
                st.save_atomic(&state_path)?;
            }

            println!(
                "Synced {total_accepted} slices (mode={mode_label}, raw={}, total_slices={total_slices}, skipped_unchanged={skipped_unchanged}, span={span_label}, dropped=ts:{}/cutoff:{}/fields:{}).",
                summary.raw_messages,
                summary.dropped_invalid_ts,
                summary.dropped_cutoff,
                summary.dropped_missing_fields
            );
            Ok(())
        }
    }
}
