use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub minimize_to_tray: bool,
    pub notifications_enabled: bool,
    pub auto_lock_minutes: i64,
    #[serde(default)]
    pub daily_sync_enabled: bool,
    #[serde(default)]
    pub daily_sync_time: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings { minimize_to_tray: true, notifications_enabled: true, auto_lock_minutes: 5, daily_sync_enabled: false, daily_sync_time: "09:00".to_string() }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load_settings(app: &AppHandle) -> AppSettings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
