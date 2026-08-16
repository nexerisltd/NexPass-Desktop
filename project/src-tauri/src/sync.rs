// NexPass — Firestore sync (push/pull encrypted entries)
//
// Entries are already AES-256-GCM encrypted before they reach this
// module (see vault.rs) — Firestore only ever sees ciphertext, never
// plaintext credentials or the vault key. Sync is last-write-wins,
// compared by each entry's updated_at timestamp.
//
// v5.0.1 changes:
//  - "Smart sync": only dirty (changed-since-last-sync) entries are
//    pushed, and a cheap remote snapshot check can skip network calls
//    entirely when nothing changed on either side.
//  - Push is batched via Firestore's `:commit` endpoint (chunks of 20)
//    instead of one HTTP request per entry — this is the main fix for
//    the app becoming unresponsive with 50-60+ credentials.
//  - Every HTTP call has a timeout and a small retry-with-backoff for
//    transient failures, and a failure on one batch no longer silently
//    loses progress already made by earlier batches.
//  - Progress is reported via the "sync-progress" Tauri event so the
//    UI can show real feedback instead of freezing silently.

use crate::storage;
use crate::vault::{self, RawEntry};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::secrets::FIREBASE_API_KEY;
const FIRESTORE_PROJECT_ID: &str = "nexpass-9bfe3";

/// How many entries go into a single Firestore batch-write request.
/// Firestore allows up to 500 writes/commit, but smaller batches keep
/// each request fast, keep memory/payload size sane, and let us report
/// progress between batches instead of one big all-or-nothing call.
const PUSH_BATCH_SIZE: usize = 20;
const HTTP_TIMEOUT_SECS: u64 = 20;
const MAX_RETRIES: u32 = 2;

#[derive(serde::Serialize, Clone)]
pub struct SyncSummary {
    pub pushed: usize,
    pub pulled: usize,
    pub skipped: bool,
}

#[derive(serde::Serialize, Clone)]
struct SyncProgress {
    phase: String, // "checking" | "pushing" | "pulling" | "done" | "error"
    done: usize,
    total: usize,
    message: String,
}

fn emit_progress(app: &AppHandle, phase: &str, done: usize, total: usize, message: &str) {
    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            phase: phase.to_string(),
            done,
            total,
            message: message.to_string(),
        },
    );
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("failed to set up network client: {e}"))
}

/// Runs `f` (one HTTP attempt) up to MAX_RETRIES+1 times with a short
/// backoff, but only for errors worth retrying (network hiccups,
/// timeouts, 429/5xx). Auth errors (401/403) and other 4xx fail fast
/// since retrying won't help.
fn with_retry<T>(mut f: impl FnMut() -> Result<T, RetryableError>) -> Result<T, String> {
    let mut attempt = 0;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(RetryableError::Fatal(msg)) => return Err(msg),
            Err(RetryableError::Retryable(msg)) => {
                if attempt >= MAX_RETRIES {
                    return Err(format!("{msg} (gave up after {} attempts)", attempt + 1));
                }
                std::thread::sleep(Duration::from_millis(300 * 2u64.pow(attempt)));
                attempt += 1;
            }
        }
    }
}

enum RetryableError {
    Retryable(String),
    Fatal(String),
}

fn classify_status(status: reqwest::StatusCode, body: String) -> RetryableError {
    if status.is_server_error() || status.as_u16() == 429 {
        RetryableError::Retryable(format!("server error {status}: {body}"))
    } else if status.as_u16() == 401 {
        RetryableError::Fatal("sign-in expired — please sign in to Google again".to_string())
    } else {
        RetryableError::Fatal(format!("request failed ({status}): {body}"))
    }
}

pub fn get_refreshed_session(app: &AppHandle) -> Result<(String, String), String> {
    let mut session = storage::load_google_session(app)?
        .ok_or_else(|| "Not signed in to Google — sign in first".to_string())?;
    let (new_id_token, new_refresh_token) = refresh_id_token(&session.refresh_token)?;
    session.id_token = new_id_token.clone();
    session.refresh_token = new_refresh_token;
    storage::save_google_session(app, &session)?;
    Ok((new_id_token, session.local_id))
}

/// Cheap "does anything actually need to sync?" check — one lightweight
/// request that fetches only the `updated_at` field of every remote
/// document (no password ciphertext, no full pull, no local writes),
/// compared against the local dirty-count and the last known remote
/// snapshot. Meant to be called on app start / unlock so the app can
/// skip a full sync entirely when nothing changed anywhere.
#[derive(serde::Serialize)]
pub struct SyncStatus {
    pub local_dirty: i64,
    pub remote_changed: bool,
    pub needs_sync: bool,
    pub last_sync_at: i64,
    pub last_sync_ok: bool,
}

pub fn check_sync_status(app: &AppHandle) -> Result<SyncStatus, String> {
    let local_dirty = vault::count_dirty_entries(app)?;
    let meta = storage::load_sync_meta(app);

    let (id_token, uid) = get_refreshed_session(app)?;
    let (remote_count, remote_max_updated) = fetch_remote_snapshot(&id_token, &uid)?;
    let remote_changed =
        remote_count != meta.last_remote_count || remote_max_updated != meta.last_remote_max_updated;

    Ok(SyncStatus {
        local_dirty,
        remote_changed,
        needs_sync: local_dirty > 0 || remote_changed,
        last_sync_at: meta.last_sync_at,
        last_sync_ok: meta.last_sync_ok,
    })
}

/// Lists remote docs with only the `updated_at` field returned, so this
/// is much cheaper than a full pull — used purely for change detection.
fn fetch_remote_snapshot(id_token: &str, uid: &str) -> Result<(i64, i64), String> {
    let client = http_client()?;
    let url = format!("{}?pageSize=1000&mask.fieldPaths=updated_at", firestore_base(uid));

    let json: Value = with_retry(|| {
        let resp = client
            .get(&url)
            .bearer_auth(id_token)
            .send()
            .map_err(|e| RetryableError::Retryable(format!("network error: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            return Err(classify_status(status, body));
        }
        resp.json::<Value>()
            .map_err(|e| RetryableError::Fatal(format!("bad response: {e}")))
    })?;

    let documents = json.get("documents").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let count = documents.len() as i64;
    let max_updated = documents
        .iter()
        .filter_map(|d| get_int(&d.get("fields").cloned().unwrap_or(json!({})), "updated_at"))
        .max()
        .unwrap_or(0);
    Ok((count, max_updated))
}

pub fn sync_now(app: &AppHandle) -> Result<SyncSummary, String> {
    emit_progress(app, "checking", 0, 0, "Checking what changed…");
    let (id_token, uid) = get_refreshed_session(app)?;

    // Guard against the case that broke decryption before: this device's
    // local vault key not matching what's actually in the cloud. Checking
    // this on every sync (not just at the moment of signing in) closes
    // the gap where a device's PIN got reset locally without a fresh
    // sign-in click triggering reconciliation.
    if let Ok(local) = storage::load_master(app) {
        match fetch_cloud_key_material(app) {
            Ok(Some(cloud)) if cloud.salt != local.salt => {
                emit_progress(app, "error", 0, 0, "VAULT_KEY_MISMATCH");
                return Err("VAULT_KEY_MISMATCH".to_string());
            }
            _ => {}
        }
    }

    let result = (|| -> Result<SyncSummary, String> {
        let pushed = push_entries(app, &id_token, &uid)?;
        let pulled = pull_entries(app, &id_token, &uid)?;
        let (remote_count, remote_max_updated) = fetch_remote_snapshot(&id_token, &uid)?;
        storage::save_sync_meta(
            app,
            &storage::SyncMeta {
                last_sync_at: now_unix(),
                last_remote_count: remote_count,
                last_remote_max_updated: remote_max_updated,
                last_sync_ok: true,
            },
        )?;
        Ok(SyncSummary { pushed, pulled, skipped: false })
    })();

    match &result {
        Ok(s) => emit_progress(app, "done", s.pushed + s.pulled, s.pushed + s.pulled, "Sync complete"),
        Err(e) => {
            // Record the failure so the UI can show "last sync failed"
            // even though we don't know the remote snapshot right now.
            let mut meta = storage::load_sync_meta(app);
            meta.last_sync_ok = false;
            let _ = storage::save_sync_meta(app, &meta);
            emit_progress(app, "error", 0, 0, e);
        }
    }
    result
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn backup_to_cloud(app: &AppHandle) -> Result<usize, String> {
    let (id_token, uid) = get_refreshed_session(app)?;
    push_entries(app, &id_token, &uid)
}

pub fn restore_from_cloud(app: &AppHandle) -> Result<usize, String> {
    let (id_token, uid) = get_refreshed_session(app)?;
    pull_entries(app, &id_token, &uid)
}

// --- Cross-device vault key material sync ---
//
// The Argon2id salt (and the PHC verification hash derived alongside
// it) used to turn a PIN into the actual AES-256 key is generated
// once, LOCALLY, the first time a device sets up a PIN. If every
// device generated its own random salt independently, the same PIN
// would derive a DIFFERENT key on each device — meaning entries
// encrypted on one device could never be decrypted on another, even
// with the correct PIN. This is fixed by treating this material as
// something to sync (it contains no secrets — salt + one-way hash —
// so it's safe to store in Firestore) so every device on the same
// account derives the identical key.

fn vault_key_url(uid: &str) -> String {
    format!(
        "https://firestore.googleapis.com/v1/projects/{FIRESTORE_PROJECT_ID}/databases/(default)/documents/users/{uid}/meta/vaultkey"
    )
}

/// Fetches the account's vault key material from the cloud, if any
/// device has ever published one. `None` means this is the first
/// device ever to set up a PIN for this account.
pub fn fetch_cloud_key_material(
    app: &AppHandle,
) -> Result<Option<crate::crypto::MasterKeyMaterial>, String> {
    let (id_token, uid) = get_refreshed_session(app)?;
    let client = http_client()?;
    let url = vault_key_url(&uid);

    let resp = client
        .get(&url)
        .bearer_auth(&id_token)
        .send()
        .map_err(|e| format!("network error checking cloud vault key: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "failed to check cloud vault key: {}",
            resp.text().unwrap_or_default()
        ));
    }

    let json: Value = resp.json().map_err(|e| e.to_string())?;
    let fields = json.get("fields").cloned().unwrap_or_else(|| json!({}));
    let salt = get_str(&fields, "salt").ok_or("cloud vault key material missing salt")?;
    let verification_hash = get_str(&fields, "verification_hash")
        .ok_or("cloud vault key material missing verification hash")?;
    Ok(Some(crate::crypto::MasterKeyMaterial { salt, verification_hash }))
}

/// Publishes this device's vault key material so other devices on the
/// same account adopt the same salt (and therefore the same derived
/// key) instead of generating their own.
pub fn push_cloud_key_material(
    app: &AppHandle,
    material: &crate::crypto::MasterKeyMaterial,
) -> Result<(), String> {
    let (id_token, uid) = get_refreshed_session(app)?;
    let client = http_client()?;
    let url = vault_key_url(&uid);
    let body = json!({
        "fields": {
            "salt": {"stringValue": material.salt},
            "verification_hash": {"stringValue": material.verification_hash},
        }
    });

    with_retry(|| {
        let resp = client
            .patch(&url)
            .bearer_auth(&id_token)
            .json(&body)
            .send()
            .map_err(|e| RetryableError::Retryable(format!("network error: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().unwrap_or_default();
            return Err(classify_status(status, text));
        }
        Ok(())
    })
    .map_err(|e| format!("failed to publish vault key material to cloud: {e}"))
}

pub fn delete_remote_entry(app: &AppHandle, id: &str) -> Result<(), String> {
    let (id_token, uid) = get_refreshed_session(app)?;
    let client = http_client()?;
    let url = format!("{}/{}", firestore_base(&uid), id);
    let _ = client.delete(&url).bearer_auth(&id_token).send();
    Ok(())
}

pub fn delete_all_remote(app: &AppHandle) -> Result<(), String> {
    let (id_token, uid) = get_refreshed_session(app)?;
    let client = http_client()?;
    let list_url = format!("{}?pageSize=300", firestore_base(&uid));
    let resp = client
        .get(&list_url)
        .bearer_auth(&id_token)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("failed to list remote entries: {}", resp.text().unwrap_or_default()));
    }
    let json: Value = resp.json().map_err(|e| e.to_string())?;
    let documents = json.get("documents").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    for doc in documents {
        if let Some(name) = doc.get("name").and_then(|n| n.as_str()) {
            let del_url = format!("https://firestore.googleapis.com/v1/{name}");
            let _ = client.delete(&del_url).bearer_auth(&id_token).send();
        }
    }
    Ok(())
}

fn refresh_id_token(refresh_token: &str) -> Result<(String, String), String> {
    let client = http_client()?;
    let url = format!("https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}");

    let json: Value = with_retry(|| {
        let resp = client
            .post(&url)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ])
            .send()
            .map_err(|e| RetryableError::Retryable(format!("network error: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            return Err(classify_status(status, body));
        }
        resp.json::<Value>()
            .map_err(|e| RetryableError::Fatal(format!("bad response: {e}")))
    })
    .map_err(|e| format!("token refresh failed: {e}"))?;
    let id_token = json["id_token"]
        .as_str()
        .ok_or("missing id_token in refresh response")?
        .to_string();
    let refresh_token = json["refresh_token"]
        .as_str()
        .ok_or("missing refresh_token in refresh response")?
        .to_string();
    Ok((id_token, refresh_token))
}

fn firestore_base(uid: &str) -> String {
    format!(
        "https://firestore.googleapis.com/v1/projects/{FIRESTORE_PROJECT_ID}/databases/(default)/documents/users/{uid}/entries"
    )
}

fn entry_to_fields(entry: &RawEntry) -> Value {
    let mut fields = serde_json::Map::new();
    fields.insert("title_ct".into(), json!({"stringValue": entry.title_ct}));
    fields.insert("title_nonce".into(), json!({"stringValue": entry.title_nonce}));
    insert_opt(&mut fields, "username_ct", &entry.username_ct);
    insert_opt(&mut fields, "username_nonce", &entry.username_nonce);
    fields.insert("password_ct".into(), json!({"stringValue": entry.password_ct}));
    fields.insert(
        "password_nonce".into(),
        json!({"stringValue": entry.password_nonce}),
    );
    insert_opt(&mut fields, "url_ct", &entry.url_ct);
    insert_opt(&mut fields, "url_nonce", &entry.url_nonce);
    insert_opt(&mut fields, "notes_ct", &entry.notes_ct);
    insert_opt(&mut fields, "notes_nonce", &entry.notes_nonce);
    insert_opt(&mut fields, "fields_ct", &entry.fields_ct);
    insert_opt(&mut fields, "fields_nonce", &entry.fields_nonce);
    fields.insert(
        "created_at".into(),
        json!({"integerValue": entry.created_at.to_string()}),
    );
    fields.insert(
        "updated_at".into(),
        json!({"integerValue": entry.updated_at.to_string()}),
    );
    fields.insert("favorite".into(), json!({"booleanValue": entry.favorite}));
    fields.insert("category".into(), json!({"stringValue": entry.category}));
    if let Some(deleted_at) = entry.deleted_at {
        fields.insert(
            "deleted_at".into(),
            json!({"integerValue": deleted_at.to_string()}),
        );
    }
    json!({ "fields": fields })
}

fn insert_opt(map: &mut serde_json::Map<String, Value>, key: &str, val: &Option<String>) {
    if let Some(v) = val {
        map.insert(key.to_string(), json!({"stringValue": v}));
    }
}

fn get_str(fields: &Value, key: &str) -> Option<String> {
    fields
        .get(key)?
        .get("stringValue")?
        .as_str()
        .map(|s| s.to_string())
}

fn get_int(fields: &Value, key: &str) -> Option<i64> {
    fields.get(key)?.get("integerValue")?.as_str()?.parse().ok()
}

fn get_bool(fields: &Value, key: &str) -> Option<bool> {
    fields.get(key)?.get("booleanValue")?.as_bool()
}

/// Pushes only entries that changed since their last successful sync
/// (see vault::list_dirty_entries_raw), in batches of PUSH_BATCH_SIZE
/// using Firestore's `:commit` batch-write endpoint instead of one
/// HTTP request per entry. This is what fixes the app freezing with
/// large vaults: a 60-credential vault used to mean 60 sequential
/// blocking requests; now it's ~3 batched requests, and only for the
/// entries that actually changed.
fn push_entries(app: &AppHandle, id_token: &str, uid: &str) -> Result<usize, String> {
    let entries = vault::list_dirty_entries_raw(app)?;
    if entries.is_empty() {
        return Ok(0);
    }

    let client = http_client()?;
    let commit_url = format!(
        "https://firestore.googleapis.com/v1/projects/{FIRESTORE_PROJECT_ID}/databases/(default)/documents:commit"
    );
    let doc_prefix = format!(
        "projects/{FIRESTORE_PROJECT_ID}/databases/(default)/documents/users/{uid}/entries"
    );

    let total = entries.len();
    let mut pushed = 0usize;

    for chunk in entries.chunks(PUSH_BATCH_SIZE) {
        emit_progress(app, "pushing", pushed, total, "Uploading changes…");

        let writes: Vec<Value> = chunk
            .iter()
            .map(|entry| {
                let mut doc = entry_to_fields(entry);
                doc["name"] = json!(format!("{doc_prefix}/{}", entry.id));
                json!({ "update": doc })
            })
            .collect();
        let body = json!({ "writes": writes });

        with_retry(|| {
            let resp = client
                .post(&commit_url)
                .bearer_auth(id_token)
                .json(&body)
                .send()
                .map_err(|e| RetryableError::Retryable(format!("network error: {e}")))?;
            let status = resp.status();
            if !status.is_success() {
                let text = resp.text().unwrap_or_default();
                return Err(classify_status(status, text));
            }
            Ok(())
        })
        .map_err(|e| format!("push failed (batch of {}): {e}", chunk.len()))?;

        // Only mark synced_at after the batch actually succeeded, so a
        // failed batch is correctly retried on the next sync attempt
        // instead of being silently skipped.
        let marks: Vec<(String, i64)> =
            chunk.iter().map(|e| (e.id.clone(), e.updated_at)).collect();
        vault::mark_synced(app, &marks)?;

        pushed += chunk.len();
    }

    Ok(pushed)
}

fn pull_entries(app: &AppHandle, id_token: &str, uid: &str) -> Result<usize, String> {
    emit_progress(app, "pulling", 0, 0, "Downloading changes…");
    let client = http_client()?;
    let url = format!("{}?pageSize=300", firestore_base(uid));

    let json: Value = with_retry(|| {
        let resp = client
            .get(&url)
            .bearer_auth(id_token)
            .send()
            .map_err(|e| RetryableError::Retryable(format!("network error: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            return Err(classify_status(status, body));
        }
        resp.json::<Value>()
            .map_err(|e| RetryableError::Fatal(format!("bad response: {e}")))
    })
    .map_err(|e| format!("pull failed: {e}"))?;

    let documents = json
        .get("documents")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    let total = documents.len();
    let mut applied = 0;
    for (i, doc) in documents.into_iter().enumerate() {
        if i % 10 == 0 {
            emit_progress(app, "pulling", i, total, "Downloading changes…");
        }
        let name = doc.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let id = name.rsplit('/').next().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let fields = doc.get("fields").cloned().unwrap_or(json!({}));

        let entry = RawEntry {
            id,
            title_ct: get_str(&fields, "title_ct").unwrap_or_default(),
            title_nonce: get_str(&fields, "title_nonce").unwrap_or_default(),
            username_ct: get_str(&fields, "username_ct"),
            username_nonce: get_str(&fields, "username_nonce"),
            password_ct: get_str(&fields, "password_ct").unwrap_or_default(),
            password_nonce: get_str(&fields, "password_nonce").unwrap_or_default(),
            url_ct: get_str(&fields, "url_ct"),
            url_nonce: get_str(&fields, "url_nonce"),
            notes_ct: get_str(&fields, "notes_ct"),
            notes_nonce: get_str(&fields, "notes_nonce"),
            created_at: get_int(&fields, "created_at").unwrap_or(0),
            updated_at: get_int(&fields, "updated_at").unwrap_or(0),
            favorite: get_bool(&fields, "favorite").unwrap_or(false),
            deleted_at: get_int(&fields, "deleted_at"),
            synced_at: None, // ignored by apply_remote_entry; it sets its own
            category: get_str(&fields, "category").unwrap_or_else(vault::default_category),
            fields_ct: get_str(&fields, "fields_ct"),
            fields_nonce: get_str(&fields, "fields_nonce"),
        };

        if vault::apply_remote_entry(app, &entry)? {
            applied += 1;
        }
    }

    Ok(applied)
}
