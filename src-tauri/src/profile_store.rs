// Local profile data — name, bio, and an optional custom avatar image.
// Email and (initially) the profile picture come from the linked
// Google account; name/bio are edited locally and never sent
// anywhere. If the person picks a custom avatar image, its local file
// path is stored here and takes priority over the Google photo.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Profile {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub avatar_path: Option<String>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("profile.json"))
}

pub fn load(app: &AppHandle) -> Profile {
    let Ok(path) = store_path(app) else { return Profile::default() };
    let Ok(content) = fs::read_to_string(path) else { return Profile::default() };
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save(app: &AppHandle, profile: &Profile) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_string(profile).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
