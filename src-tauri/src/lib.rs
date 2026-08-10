// NexPass — Tauri backend library
mod crypto;
mod google_auth;
mod settings;
mod storage;
mod sync;
mod vault;

use std::sync::Mutex;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WindowEvent};

#[derive(Default)]
struct SessionState {
    key: Option<crypto::VaultKey>,
}
type Session = Mutex<SessionState>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Session::default())
        .setup(|app| {
            // Tray icons don't exist on Android/iOS — this whole block
            // (and the imports above) only compiles in on desktop.
            #[cfg(desktop)]
            {
                let show_item = MenuItem::with_id(app, "show", "Show NexPass", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

                let mut tray = TrayIconBuilder::new().menu(&menu).on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    use window_vibrancy::{apply_acrylic, apply_mica};
                    if apply_mica(&window, Some(true)).is_err() {
                        let _ = apply_acrylic(&window, Some((10, 10, 20, 125)));
                    }
                }
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    let _ = apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let s = settings::load_settings(app);
                if s.minimize_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(session) = app.try_state::<Session>() {
                        if let Ok(mut guard) = session.lock() {
                            guard.key = None;
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault_exists,
            setup_pin,
            unlock_with_pin,
            lock_vault,
            google_sign_in,
            google_session_status,
            add_entry,
            list_entries,
            list_trash,
            get_entry,
            update_entry,
            soft_delete_entry,
            restore_entry,
            permanently_delete_entry,
            toggle_favorite,
            sync_now,
            check_sync_status,
            check_cloud_vault_key,
            adopt_cloud_vault_key,
            debug_vault_key_info,
            backup_to_cloud,
            restore_from_cloud,
            export_vault,
            import_vault,
            logout_and_wipe,
            delete_account,
            get_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running NexPass");
}

fn require_key(s: &SessionState) -> Result<&crypto::VaultKey, String> {
    s.key.as_ref().ok_or_else(|| "Vault is locked".to_string())
}

#[tauri::command]
fn vault_exists(app: AppHandle) -> Result<bool, String> {
    storage::vault_exists(&app)
}

#[tauri::command]
fn setup_pin(app: AppHandle, session: State<Session>, pin: String) -> Result<(), String> {
    if pin.len() < 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("PIN must be at least 4 digits".to_string());
    }

    // If this device is already linked to a Google account that
    // already has vault key material in the cloud, adopt THAT
    // material instead of generating a new one — otherwise this
    // device would derive a different AES key from the same PIN and
    // would never be able to decrypt entries from other devices on
    // the same account (or vice versa).
    if storage::load_google_session(&app)?.is_some() {
        if let Ok(Some(material)) = sync::fetch_cloud_key_material(&app) {
            let key = crypto::unlock(&pin, &material).map_err(|_| {
                "This account's vault already uses a different PIN on another device — enter that PIN instead.".to_string()
            })?;
            storage::save_master(&app, &material)?;
            session.lock().map_err(|_| "lock poisoned".to_string())?.key = Some(key);
            return Ok(());
        }
    }

    let (material, key) =
        crypto::create_master_key(&pin).map_err(|_| "Failed to set up PIN".to_string())?;
    storage::save_master(&app, &material)?;
    // Best-effort: if already signed in, publish this device's key
    // material immediately so it becomes the account's canonical key.
    if storage::load_google_session(&app)?.is_some() {
        let _ = sync::push_cloud_key_material(&app, &material);
    }
    session.lock().map_err(|_| "lock poisoned".to_string())?.key = Some(key);
    Ok(())
}

#[tauri::command]
fn unlock_with_pin(app: AppHandle, session: State<Session>, pin: String) -> Result<bool, String> {
    let material = storage::load_master(&app)?;
    match crypto::unlock(&pin, &material) {
        Ok(key) => {
            session.lock().map_err(|_| "lock poisoned".to_string())?.key = Some(key);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

#[tauri::command]
fn lock_vault(session: State<Session>) -> Result<(), String> {
    session.lock().map_err(|_| "lock poisoned".to_string())?.key = None;
    Ok(())
}

#[tauri::command]
fn add_entry(app: AppHandle, session: State<Session>, input: vault::EntryInput) -> Result<String, String> {
    let s = session.lock().map_err(|_| "lock poisoned".to_string())?;
    vault::add_entry(&app, require_key(&s)?, input)
}

#[tauri::command]
fn list_entries(app: AppHandle, session: State<Session>) -> Result<Vec<vault::EntrySummary>, String> {
    let s = session.lock().map_err(|_| "lock poisoned".to_string())?;
    vault::list_entries(&app, require_key(&s)?)
}

#[tauri::command]
fn list_trash(app: AppHandle, session: State<Session>) -> Result<Vec<vault::EntrySummary>, String> {
    let s = session.lock().map_err(|_| "lock poisoned".to_string())?;
    vault::list_trash(&app, require_key(&s)?)
}

#[tauri::command]
fn get_entry(app: AppHandle, session: State<Session>, id: String) -> Result<vault::EntryFull, String> {
    let s = session.lock().map_err(|_| "lock poisoned".to_string())?;
    vault::get_entry(&app, require_key(&s)?, &id)
}

#[tauri::command]
fn update_entry(app: AppHandle, session: State<Session>, id: String, input: vault::EntryInput) -> Result<(), String> {
    let s = session.lock().map_err(|_| "lock poisoned".to_string())?;
    vault::update_entry(&app, require_key(&s)?, &id, input)
}

#[tauri::command]
fn soft_delete_entry(app: AppHandle, id: String) -> Result<(), String> {
    vault::soft_delete_entry(&app, &id)
}

#[tauri::command]
fn restore_entry(app: AppHandle, id: String) -> Result<(), String> {
    vault::restore_entry(&app, &id)
}

#[tauri::command]
fn permanently_delete_entry(app: AppHandle, id: String) -> Result<(), String> {
    vault::permanently_delete_entry(&app, &id)?;
    let _ = sync::delete_remote_entry(&app, &id);
    Ok(())
}

#[tauri::command]
fn toggle_favorite(app: AppHandle, id: String) -> Result<bool, String> {
    vault::toggle_favorite(&app, &id)
}

#[derive(serde::Serialize)]
struct GoogleSignInResult {
    email: String,
    local_id: String,
}

#[tauri::command]
async fn google_sign_in(app: AppHandle) -> Result<GoogleSignInResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = google_auth::sign_in_with_google(&app)?;
        storage::save_google_session(&app, &session)?;
        Ok(GoogleSignInResult { email: session.email, local_id: session.local_id })
    })
    .await
    .map_err(|e| format!("sign-in task panicked: {e}"))?
}

#[tauri::command]
fn google_session_status(app: AppHandle) -> Result<Option<GoogleSignInResult>, String> {
    let session = storage::load_google_session(&app)?;
    Ok(session.map(|s| GoogleSignInResult { email: s.email, local_id: s.local_id }))
}

/// Called right after a successful Google sign-in (when a local PIN/
/// vault already exists on this device, which is the normal flow —
/// PIN is set up before linking an account). Compares this device's
/// vault key material against whatever the account already has in the
/// cloud.
///
/// Returns:
/// - "match"     — nothing to do, this device already uses the account's key
/// - "published" — no cloud material existed yet; this device's key was published as canonical
/// - "mismatch"  — the account already has a DIFFERENT key from another device;
///                 the caller should prompt for that device's PIN and call
///                 `adopt_cloud_vault_key` to reconcile
#[tauri::command]
fn check_cloud_vault_key(app: AppHandle) -> Result<String, String> {
    let local = storage::load_master(&app)?;
    match sync::fetch_cloud_key_material(&app)? {
        None => {
            sync::push_cloud_key_material(&app, &local)?;
            Ok("published".to_string())
        }
        Some(cloud) => {
            if cloud.salt == local.salt {
                Ok("match".to_string())
            } else {
                Ok("mismatch".to_string())
            }
        }
    }
}

/// Resolves a "mismatch" from `check_cloud_vault_key`: verifies the
/// given PIN against the ACCOUNT's cloud key material, and if correct,
/// replaces this device's local key material with it and wipes this
/// device's local (now-undecryptable, since it was under a different
/// key) entries so a fresh pull from the cloud can repopulate them.
#[tauri::command]
fn adopt_cloud_vault_key(app: AppHandle, session: State<Session>, pin: String) -> Result<(), String> {
    let cloud = sync::fetch_cloud_key_material(&app)?
        .ok_or_else(|| "No cloud vault key found for this account".to_string())?;
    let key = crypto::unlock(&pin, &cloud)
        .map_err(|_| "That's not the PIN this account's vault was set up with".to_string())?;

    storage::save_master(&app, &cloud)?;
    vault::wipe_all_entries(&app)?;
    session.lock().map_err(|_| "lock poisoned".to_string())?.key = Some(key);
    Ok(())
}

/// Diagnostic only — shows exactly what this device's local salt and
/// the account's cloud salt currently are (short prefixes, not the
/// full secret material) so a real mismatch can be seen directly
/// instead of inferred from symptoms.
#[derive(serde::Serialize)]
struct VaultKeyDebugInfo {
    local_salt_prefix: Option<String>,
    cloud_salt_prefix: Option<String>,
    salts_match: bool,
    google_email: Option<String>,
}

#[tauri::command]
fn debug_vault_key_info(app: AppHandle) -> Result<VaultKeyDebugInfo, String> {
    let local = storage::load_master(&app).ok();
    let local_salt_prefix = local.as_ref().map(|m| m.salt.chars().take(12).collect::<String>());

    let google = storage::load_google_session(&app)?;
    let google_email = google.as_ref().map(|g| g.email.clone());

    let cloud_salt_prefix = if google.is_some() {
        sync::fetch_cloud_key_material(&app)
            .ok()
            .flatten()
            .map(|m| m.salt.chars().take(12).collect::<String>())
    } else {
        None
    };

    let salts_match = match (&local_salt_prefix, &cloud_salt_prefix) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    };

    Ok(VaultKeyDebugInfo { local_salt_prefix, cloud_salt_prefix, salts_match, google_email })
}

// These are `async fn` + `spawn_blocking` rather than plain sync
// commands. Tauri already runs commands off the JS/UI thread, but a
// plain sync command occupies one of the async-runtime's worker
// threads for its entire (potentially many-second, many-request)
// duration; spawn_blocking moves that work to the dedicated blocking
// thread pool so it can't starve other commands (or Tauri's own event
// loop) while a big sync is in flight — this is part of the "advance
// error handling" fix for large vaults (50-60+ credentials) freezing
// the app.

#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<sync::SyncSummary, String> {
    tauri::async_runtime::spawn_blocking(move || sync::sync_now(&app))
        .await
        .map_err(|e| format!("sync task panicked: {e}"))?
}

#[tauri::command]
async fn check_sync_status(app: AppHandle) -> Result<sync::SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || sync::check_sync_status(&app))
        .await
        .map_err(|e| format!("sync status check panicked: {e}"))?
}

#[tauri::command]
async fn backup_to_cloud(app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || sync::backup_to_cloud(&app))
        .await
        .map_err(|e| format!("backup task panicked: {e}"))?
}

#[tauri::command]
async fn restore_from_cloud(app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || sync::restore_from_cloud(&app))
        .await
        .map_err(|e| format!("restore task panicked: {e}"))?
}

/// Exports all active entries as a password-protected encrypted JSON blob
/// (safe to share — nothing readable without the export password).
#[tauri::command]
fn export_vault(app: AppHandle, session: State<Session>, password: String) -> Result<String, String> {
    if password.len() < 6 {
        return Err("Export password must be at least 6 characters".to_string());
    }
    let entries = {
        let s = session.lock().map_err(|_| "lock poisoned".to_string())?;
        vault::export_all(&app, require_key(&s)?)?
    };
    let plaintext = serde_json::to_string(&entries).map_err(|e| e.to_string())?;
    let blob = crypto::encrypt_with_password(&plaintext, &password).map_err(|_| "export encryption failed".to_string())?;
    serde_json::to_string(&serde_json::json!({
        "nexpass_export": true,
        "version": 1,
        "salt": blob.salt,
        "nonce": blob.nonce_b64,
        "ciphertext": blob.ciphertext_b64
    }))
    .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
struct ImportedEntry {
    title: String,
    username: String,
    password: String,
    url: String,
    notes: String,
}

/// Imports entries from a file produced by export_vault.
#[tauri::command]
fn import_vault(app: AppHandle, session: State<Session>, file_content: String, password: String) -> Result<usize, String> {
    let parsed: serde_json::Value = serde_json::from_str(&file_content).map_err(|_| "Not a valid NexPass export file".to_string())?;
    let blob = crypto::ExportBlob {
        salt: parsed["salt"].as_str().ok_or("missing salt")?.to_string(),
        ciphertext_b64: parsed["ciphertext"].as_str().ok_or("missing ciphertext")?.to_string(),
        nonce_b64: parsed["nonce"].as_str().ok_or("missing nonce")?.to_string(),
    };
    let plaintext = crypto::decrypt_with_password(&blob, &password).map_err(|_| "Wrong export password".to_string())?;
    let entries: Vec<ImportedEntry> = serde_json::from_str(&plaintext).map_err(|e| e.to_string())?;

    let s = session.lock().map_err(|_| "lock poisoned".to_string())?;
    let key = require_key(&s)?;
    let mut count = 0;
    for e in entries {
        vault::add_entry(&app, key, vault::EntryInput {
            title: e.title, username: e.username, password: e.password, url: e.url, notes: e.notes,
        })?;
        count += 1;
    }
    Ok(count)
}

/// Wipes ALL local data (vault, PIN, Google session) — used for logout
/// and as part of account deletion. Does not touch cloud data.
#[tauri::command]
fn logout_and_wipe(app: AppHandle, session: State<Session>) -> Result<(), String> {
    session.lock().map_err(|_| "lock poisoned".to_string())?.key = None;
    storage::wipe_all_local_data(&app)
}

/// Deletes ALL of this user's data from Firestore, then wipes local data too.
#[tauri::command]
fn delete_account(app: AppHandle, session: State<Session>) -> Result<(), String> {
    sync::delete_all_remote(&app)?;
    session.lock().map_err(|_| "lock poisoned".to_string())?.key = None;
    storage::wipe_all_local_data(&app)
}

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::AppSettings {
    settings::load_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: settings::AppSettings) -> Result<(), String> {
    settings::save_settings(&app, &settings)
}
