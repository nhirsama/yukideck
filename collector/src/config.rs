use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProjectPrivacy {
    #[default]
    Name,
    Hash,
    None,
}

impl std::str::FromStr for ProjectPrivacy {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "name" => Ok(Self::Name),
            "hash" => Ok(Self::Hash),
            "none" => Ok(Self::None),
            other => anyhow::bail!("invalid project_privacy '{other}', expected name|hash|none"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectorConfig {
    pub server_url: String,
    pub api_key: String,
    pub device_id: String,
    pub device_name: String,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub project_privacy: ProjectPrivacy,
    #[serde(default = "default_lookback_hours")]
    pub lookback_hours: u64,
    #[serde(default = "default_batch_size")]
    pub batch_size: usize,
}

fn default_lookback_hours() -> u64 {
    48
}

fn default_batch_size() -> usize {
    200
}

impl CollectorConfig {
    pub fn default_config_path() -> PathBuf {
        if let Ok(p) = std::env::var("YUKIDECK_COLLECTOR_CONFIG") {
            if !p.trim().is_empty() {
                return PathBuf::from(p);
            }
        }
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("yukideck-collector")
            .join("config.toml")
    }

    pub fn default_state_path() -> PathBuf {
        if let Ok(p) = std::env::var("YUKIDECK_COLLECTOR_STATE") {
            if !p.trim().is_empty() {
                return PathBuf::from(p);
            }
        }
        dirs::state_dir()
            .or_else(dirs::data_local_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("yukideck-collector")
            .join("state.json")
    }

    pub fn lock_path_for(state_path: &Path) -> PathBuf {
        state_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("sync.lock")
    }

    pub fn load(path: &Path) -> Result<Self> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("failed to read config at {} (run `init` first)", path.display()))?;
        let mut cfg: Self = toml::from_str(&content)
            .with_context(|| format!("failed to parse TOML config at {}", path.display()))?;
        cfg.apply_env_overrides();
        cfg.normalize();
        Ok(cfg)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = toml::to_string_pretty(self)?;
        fs::write(path, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn apply_env_overrides(&mut self) {
        if let Ok(v) = std::env::var("YUKIDECK_SERVER_URL") {
            if !v.trim().is_empty() {
                self.server_url = v;
            }
        }
        if let Ok(v) = std::env::var("YUKIDECK_API_KEY") {
            if !v.trim().is_empty() {
                self.api_key = v;
            }
        }
        if let Ok(v) = std::env::var("YUKIDECK_DEVICE_ID") {
            if !v.trim().is_empty() {
                self.device_id = v;
            }
        }
        if let Ok(v) = std::env::var("YUKIDECK_DEVICE_NAME") {
            if !v.trim().is_empty() {
                self.device_name = v;
            }
        }
    }

    pub fn normalize(&mut self) {
        self.server_url = self.server_url.trim().trim_end_matches('/').to_string();
        self.api_key = self.api_key.trim().to_string();
        if self.device_id.trim().is_empty() {
            self.device_id = Uuid::new_v4().to_string();
        }
        if self.device_name.trim().is_empty() {
            self.device_name = detect_hostname();
        }
        if self.batch_size == 0 || self.batch_size > 500 {
            self.batch_size = 200;
        }
        if self.lookback_hours == 0 {
            self.lookback_hours = 48;
        }
    }
}

pub fn detect_hostname() -> String {
    for key in ["HOSTNAME", "COMPUTERNAME"] {
        if let Ok(h) = std::env::var(key) {
            if !h.trim().is_empty() {
                return h.trim().to_string();
            }
        }
    }
    if let Ok(h) = fs::read_to_string("/etc/hostname") {
        let t = h.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    "unknown-host".to_string()
}
