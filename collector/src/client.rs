use crate::aggregate::IngestSlice;
use crate::config::{detect_hostname, CollectorConfig};
use anyhow::{anyhow, Context, Result};
use flate2::write::GzEncoder;
use flate2::Compression;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct IngestDevice {
    pub device_id: String,
    pub name: String,
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub collector_version: String,
}

#[derive(Debug, Serialize)]
pub struct IngestRequest {
    pub device: IngestDevice,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub force_overwrite: bool,
    pub slices: Vec<IngestSlice>,
}

#[derive(Debug, Deserialize)]
pub struct IngestResponse {
    pub accepted: usize,
    pub device_id: String,
}

pub struct YukiDeckClient {
    http: Client,
    endpoint: String,
    api_key: String,
    device: IngestDevice,
}

impl YukiDeckClient {
    pub fn new(cfg: &CollectorConfig) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent(format!("yukideck-collector/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .context("failed building HTTP client")?;
        let endpoint = format!("{}/api/v1/ai-usage/ingest", cfg.server_url.trim_end_matches('/'));
        let device = IngestDevice {
            device_id: cfg.device_id.clone(),
            name: cfg.device_name.clone(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            hostname: detect_hostname(),
            collector_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        Ok(Self {
            http,
            endpoint,
            api_key: cfg.api_key.clone(),
            device,
        })
    }

    pub fn verify_connection(&self) -> Result<IngestResponse> {
        self.send_batch(Vec::new(), false)
    }

    pub fn send_batch(&self, slices: Vec<IngestSlice>, force_overwrite: bool) -> Result<IngestResponse> {
        let req_body = IngestRequest {
            device: self.device.clone(),
            force_overwrite,
            slices,
        };
        let raw_json = serde_json::to_vec(&req_body)?;
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&raw_json)?;
        let compressed = gz.finish()?;

        let mut last_err = None;
        for attempt in 1..=3u64 {
            let res = self
                .http
                .post(&self.endpoint)
                .header(AUTHORIZATION, format!("Bearer {}", self.api_key))
                .header(CONTENT_TYPE, "application/json")
                .header(CONTENT_ENCODING, "gzip")
                .body(compressed.clone())
                .send();

            match res {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        let parsed: IngestResponse = resp
                            .json()
                            .context("failed decoding ingest response JSON")?;
                        return Ok(parsed);
                    }
                    let body = resp.text().unwrap_or_default();
                    // Fail fast on client / auth errors (except 429)
                    if status.is_client_error() && status.as_u16() != 429 {
                        return Err(anyhow!("server rejected request ({status}): {body}"));
                    }
                    last_err = Some(anyhow!("server error ({status}): {body}"));
                }
                Err(e) => {
                    last_err = Some(anyhow!("request failed: {e}"));
                }
            }
            if attempt < 3 {
                thread::sleep(Duration::from_secs(1 << attempt));
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("ingest failed after retries")))
    }
}
