use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CollectorState {
    #[serde(default)]
    pub slice_hashes: BTreeMap<String, String>,
    #[serde(default)]
    pub last_synced_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_sync_accepted: usize,
}

impl CollectorState {
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Atomically persists state (temp file + rename) after server 2xx acknowledgement.
    pub fn save_atomic(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        let data = serde_json::to_vec_pretty(self)?;
        fs::write(&tmp, data)
            .with_context(|| format!("failed writing temp state {}", tmp.display()))?;
        fs::rename(&tmp, path)
            .with_context(|| format!("failed committing state {}", path.display()))?;
        Ok(())
    }

    pub fn prune_old_hashes(&mut self, max_entries: usize) {
        if self.slice_hashes.len() <= max_entries {
            return;
        }
        let remove_count = self.slice_hashes.len() - max_entries;
        let keys: Vec<String> = self.slice_hashes.keys().take(remove_count).cloned().collect();
        for k in keys {
            self.slice_hashes.remove(&k);
        }
    }
}

pub struct SyncLock {
    _file: File,
}

pub fn acquire_sync_lock(lock_path: &Path) -> Result<SyncLock> {
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .with_context(|| format!("failed opening lock file {}", lock_path.display()))?;
    file.try_lock_exclusive().with_context(|| {
        format!(
            "another yukideck-collector sync process holds lock {}",
            lock_path.display()
        )
    })?;
    Ok(SyncLock { _file: file })
}
