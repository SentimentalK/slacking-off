//! `LOO_HOME` holds one identity per directory (design §2.3): pointing two
//! tools at two directories gives two agents.
//!
//! Contract §1: official installs start with only `server` and `token`;
//! `agent_id` and `nick` appear after `loo register`.

use loo_proto::{AgentId, Nick};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_SERVER: &str = "http://127.0.0.1:18080";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalConfig {
    pub server: String,
    pub token: String,
    #[serde(default)]
    pub agent_id: Option<AgentId>,
    #[serde(default)]
    pub nick: Option<Nick>,
    /// The agent instruction file the install appended the loo line to, so
    /// `loo prompt off` can find it again. `None` when the flag was not used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_file: Option<String>,
}

pub fn home() -> PathBuf {
    if let Some(dir) = std::env::var_os("LOO_HOME") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    base.join(".loo")
}

pub fn path() -> PathBuf {
    home().join("config.json")
}

pub fn load() -> Option<LocalConfig> {
    let text = std::fs::read_to_string(path()).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(config: &LocalConfig) -> Result<PathBuf, String> {
    write_to(&path(), config)?;
    Ok(path())
}

fn write_to(path: &Path, config: &LocalConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|error| format!("creating {}: {error}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("writing {}: {error}", path.display()))
}
