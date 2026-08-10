// NexPass — Storage module
// Persists the vault's master-key material (salt + verification hash
// only — never the PIN/password, never the encryption key) to a local
// JSON file in the OS's app-data directory. Actual encrypted vault
// entries will move to SQLite in a later step; this file is just for
// unlock verification.

use crate::crypto::MasterKeyMaterial;
use crate::google_auth::FirebaseSession;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
struct VaultMeta {
    master: MasterKeyMaterial,
}

fn vault_meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault_meta.json"))
}

pub fn vault_exists(app: &AppHandle) -> Result<bool, String> {
    Ok(vault_meta_path(app)?.exists())
}

pub fn save_master(app: &AppHandle, material: &MasterKeyMaterial) -> Result<(), String> {
    let path = vault_meta_path(app)?;
    let meta = VaultMeta {
        master: material.clone(),
    };
    let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn wipe_all_local_data(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    for name in ["vault_meta.json", "google_session.json", "vault.sqlite3", "sync_meta.json"] {
        let p = dir.join(name);
        if p.exists() {
            let _ = fs::remove_file(p);
        }
    }
    Ok(())
}

pub fn load_master(app: &AppHandle) -> Result<MasterKeyMaterial, String> {
    let path = vault_meta_path(app)?;
    let json = fs::read_to_string(path).map_err(|_| "vault not set up yet".to_string())?;
    let meta: VaultMeta = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(meta.master)
}

// --- Google/Firebase session persistence ---
// NOTE (MVP): stored as plain local JSON for now, same trust boundary
// as an OS-protected app-data folder. A later hardening pass should
// encrypt this with the vault key before writing to disk.

fn google_session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("google_session.json"))
}

pub fn save_google_session(app: &AppHandle, session: &FirebaseSession) -> Result<(), String> {
    let path = google_session_path(app)?;
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn load_google_session(app: &AppHandle) -> Result<Option<FirebaseSession>, String> {
    let path = google_session_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let session: FirebaseSession = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(Some(session))
}

// --- Smart sync metadata ---
// A small local snapshot of "what the cloud looked like last time we
// checked", so the app can tell — without doing a full push/pull —
// whether anything actually needs to sync the next time it's opened.

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SyncMeta {
    /// Unix seconds of the last time a sync (push+pull) completed.
    pub last_sync_at: i64,
    /// Number of (non-tombstone-only) documents seen in Firestore as of
    /// the last successful sync — used as a cheap remote-change signal.
    pub last_remote_count: i64,
    /// max(updated_at) across all remote documents as of the last
    /// successful sync — used as a cheap remote-change signal.
    pub last_remote_max_updated: i64,
    /// Whether the *last* sync attempt succeeded — surfaced in the UI
    /// so the user knows if they're looking at a stale state.
    pub last_sync_ok: bool,
}

fn sync_meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sync_meta.json"))
}

pub fn load_sync_meta(app: &AppHandle) -> SyncMeta {
    let Ok(path) = sync_meta_path(app) else { return SyncMeta::default() };
    let Ok(json) = fs::read_to_string(path) else { return SyncMeta::default() };
    serde_json::from_str(&json).unwrap_or_default()
}

pub fn save_sync_meta(app: &AppHandle, meta: &SyncMeta) -> Result<(), String> {
    let path = sync_meta_path(app)?;
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
