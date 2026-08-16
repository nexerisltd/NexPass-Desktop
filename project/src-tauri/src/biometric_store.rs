// Stores the PIN used to auto-unlock the vault after a successful
// biometric prompt.
//
// IMPORTANT — trust model: this is a *convenience* layer, not an extra
// cryptographic security boundary. The biometric prompt (native Android
// BiometricPrompt via tauri-plugin-biometric) is a yes/no gate the OS
// shows the user; once it resolves, the app reads this file and feeds
// the PIN straight into the normal `unlock_with_pin` flow. The PIN here
// is protected the same way the rest of NexPass's local data already is
// (settings.json, the vault db) — by the Android per-app storage sandbox,
// not by a hardware-backed key. That matches this app's existing trust
// model (settings.json is already plaintext), so this doesn't weaken it,
// but it's worth knowing: a rooted device or physical access with debug
// tools could read this file directly, bypassing the fingerprint prompt.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Default)]
struct BiometricStore {
    pin: Option<String>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("biometric.json"))
}

pub fn save_pin(app: &AppHandle, pin: &str) -> Result<(), String> {
    let path = store_path(app)?;
    let data = BiometricStore { pin: Some(pin.to_string()) };
    let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn load_pin(app: &AppHandle) -> Option<String> {
    let path = store_path(app).ok()?;
    let content = fs::read_to_string(path).ok()?;
    let data: BiometricStore = serde_json::from_str(&content).ok()?;
    data.pin
}

pub fn clear_pin(app: &AppHandle) -> Result<(), String> {
    let path = store_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
