// In-app update check + download + install.
//
// IMPORTANT — what this can and can't do: Android will never let a
// sideloaded (non-Play-Store) app silently replace itself. This module
// gets you all the way to "here's the new APK, please confirm" — the
// final install tap is a native Android system prompt this code cannot
// skip, by OS design (same restriction every non-Play-Store app faces).
// If NexPass doesn't yet have the "install unknown apps" permission for
// its source, Android's own package-installer screen asks for that
// automatically the moment the install intent fires — that's the OS's
// own permission gate (a "Settings" shortcut baked into the installer
// UI), not something this code requests or can bypass.
//
// Bump CURRENT_VERSION here (and APP_VERSION in App.tsx, and the version
// fields in Cargo.toml / tauri.conf.json / package.json) on every release.
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const CURRENT_VERSION: &str = "6.0.1";
const HTTP_TIMEOUT_SECS: u64 = 15;

// Android and desktop ship from the same NexPass-Update repo but read
// different manifest files, since the two builds have separate release
// cadences and installer formats (.apk vs the NSIS .exe). Everything
// below this — download, progress events, install hand-off — is shared
// code; only these constants branch per platform.
#[cfg(target_os = "android")]
const MANIFEST_URL: &str = "https://raw.githubusercontent.com/nexerisltd/NexPass-Update/main/update.json";
#[cfg(target_os = "android")]
const RELEASES_URL: &str = "https://raw.githubusercontent.com/nexerisltd/NexPass-Update/main/releases.json";
#[cfg(target_os = "android")]
const UPDATE_FILENAME: &str = "nexpass-update.apk";

// Desktop currently only ships a Windows build (see tauri.conf.json's
// nsis bundle target) — if macOS/Linux builds are added later, branch
// this further with their own -mac.json / -linux.json manifests.
#[cfg(not(target_os = "android"))]
const MANIFEST_URL: &str = "https://raw.githubusercontent.com/nexerisltd/NexPass-Update/main/update-win.json";
#[cfg(not(target_os = "android"))]
const RELEASES_URL: &str = "https://raw.githubusercontent.com/nexerisltd/NexPass-Update/main/release-win.json";
#[cfg(not(target_os = "android"))]
const UPDATE_FILENAME: &str = "nexpass-update.exe";

const UPDATE_META_FILENAME: &str = "nexpass-update.meta.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct UpdateManifest {
    pub version: String,
    pub changelog: String,
    pub download_url: String,
}

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub current_version: String,
    #[serde(flatten)]
    pub manifest: UpdateManifest,
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

// Simple "X.Y.Z" comparator — good enough as long as releases always use
// plain numeric versions (no "-beta" suffixes etc).
fn is_newer(remote: &str, local: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> { v.split('.').filter_map(|p| p.parse().ok()).collect() };
    let (r, l) = (parse(remote), parse(local));
    for i in 0..r.len().max(l.len()) {
        let rv = r.get(i).copied().unwrap_or(0);
        let lv = l.get(i).copied().unwrap_or(0);
        if rv != lv {
            return rv > lv;
        }
    }
    false
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ReleaseNote {
    pub version: String,
    pub date: String,
    pub notes: String,
}

pub fn fetch_release_notes() -> Result<Vec<ReleaseNote>, String> {
    let client = http_client()?;
    client
        .get(RELEASES_URL)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Vec<ReleaseNote>>()
        .map_err(|e| e.to_string())
}

pub fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    let client = http_client()?;
    let manifest: UpdateManifest = client
        .get(MANIFEST_URL)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    if is_newer(&manifest.version, CURRENT_VERSION) {
        Ok(Some(UpdateInfo { current_version: CURRENT_VERSION.to_string(), manifest }))
    } else {
        Ok(None)
    }
}

// --- Download progress -----------------------------------------------
//
// Emitted repeatedly to the frontend as "update-download-progress" while
// a download is in flight, then once more with phase "done" or "error".
// `total` is 0 when the server didn't send a Content-Length header —
// the frontend falls back to an indeterminate indicator in that case.
#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
    phase: String, // "downloading" | "done" | "error"
    message: String,
}

fn emit_download_progress(app: &AppHandle, downloaded: u64, total: u64, phase: &str, message: &str) {
    let _ = app.emit(
        "update-download-progress",
        DownloadProgress { downloaded, total, phase: phase.to_string(), message: message.to_string() },
    );
}

// --- Where the APK lives on disk --------------------------------------
//
// Deliberately the app's own internal-storage data directory (NOT the
// cache dir) — cache can be silently purged by Android when the system
// is low on space, which would make the "Delete APK file" storage
// control below misleading (the OS could've already removed it). This
// directory is private to NexPass and is never encrypted — there's
// nothing sensitive in an app installer package, so encrypting it would
// just cost battery/time for no benefit.
fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn update_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(updates_dir(app)?.join(UPDATE_FILENAME))
}

fn meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(updates_dir(app)?.join(UPDATE_META_FILENAME))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DownloadedUpdateInfo {
    pub version: String,
    pub size_bytes: u64,
    pub downloaded_at: u64, // unix seconds
    pub path: String,
}

/// Reports whatever update APK (if any) is already sitting on disk from
/// a previous download — lets the frontend restore the Install/Delete
/// buttons after an app restart without re-downloading anything.
pub fn get_downloaded_update_info(app: &AppHandle) -> Result<Option<DownloadedUpdateInfo>, String> {
    let update_p = update_file_path(app)?;
    let meta_p = meta_path(app)?;
    if !update_p.exists() || !meta_p.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&meta_p).map_err(|e| e.to_string())?;
    let mut info: DownloadedUpdateInfo = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // Keep the reported size honest even if the meta file is stale.
    if let Ok(md) = std::fs::metadata(&update_p) {
        info.size_bytes = md.len();
    }
    info.path = update_p.to_string_lossy().to_string();
    Ok(Some(info))
}

/// Deletes the downloaded update APK (and its sidecar metadata) to free
/// up storage. Returns true if a file was actually removed.
pub fn delete_downloaded_update(app: &AppHandle) -> Result<bool, String> {
    let update_p = update_file_path(app)?;
    let meta_p = meta_path(app)?;
    let existed = update_p.exists();
    if existed {
        std::fs::remove_file(&update_p).map_err(|e| e.to_string())?;
    }
    if meta_p.exists() {
        let _ = std::fs::remove_file(&meta_p);
    }
    Ok(existed)
}

/// Downloads the update APK into the app's internal storage, streaming
/// it to disk in chunks and emitting "update-download-progress" events
/// along the way, then returns the local file path — the frontend hands
/// that path to the opener plugin, which fires Android's native
/// package-installer prompt.
pub fn download_update(app: &AppHandle, url: &str, version: &str) -> Result<String, String> {
    match download_update_inner(app, url, version) {
        Ok(path) => Ok(path),
        Err(e) => {
            emit_download_progress(app, 0, 0, "error", &e);
            Err(e)
        }
    }
}

fn download_update_inner(app: &AppHandle, url: &str, version: &str) -> Result<String, String> {
    let client = http_client()?;
    let mut response = client.get(url).send().map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let total = response.content_length().unwrap_or(0);

    let update_p = update_file_path(app)?;
    let mut file = std::fs::File::create(&update_p).map_err(|e| e.to_string())?;

    let mut downloaded: u64 = 0;
    let mut buf = [0u8; 64 * 1024];
    emit_download_progress(app, 0, total, "downloading", "Starting download…");

    loop {
        let n = response.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        emit_download_progress(app, downloaded, total, "downloading", "Downloading update…");
    }
    file.flush().map_err(|e| e.to_string())?;

    let downloaded_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let info = DownloadedUpdateInfo {
        version: version.to_string(),
        size_bytes: downloaded,
        downloaded_at,
        path: update_p.to_string_lossy().to_string(),
    };
    std::fs::write(meta_path(app)?, serde_json::to_string(&info).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;

    emit_download_progress(app, downloaded, total, "done", "Download complete");
    Ok(update_p.to_string_lossy().to_string())
}
