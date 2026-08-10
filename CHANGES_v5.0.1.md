# NexPass v5.0.1 — Desktop backend fixes

## 1. Toast notifications (popup-style)
- Old: single plain-text toast, no success/error distinction.
- New: stacked, dismissible toast queue with 3 types — success (green ✓),
  error (red !), info (blue i). Every credential action now reports
  success/failure explicitly:
  - "Credential saved successfully" / "Failed to save credential"
  - "Credential updated successfully" / "Failed to update credential"
  - Similar for trash/restore/delete/favorite/backup/restore/sync.

## 2. Advanced error handling (fixes freeze with 50-60+ credentials)
Root cause: `push_entries` sent **one blocking HTTP request per entry**
with no timeout, no retry, and aborted the whole sync on the first
failure.

Fixes in `sync.rs`:
- Push now uses Firestore's `:commit` **batch-write** endpoint, 20
  entries per request, instead of 1 request per entry.
- Every HTTP call has a 20s timeout and retries transient failures
  (network errors, 5xx, 429) up to 2x with backoff. Auth errors (401)
  fail fast with a clear "sign-in expired" message instead of hanging.
- A failed batch no longer wipes out progress from earlier batches —
  only the entries in the successful batches are marked synced.
- Sync commands (`sync_now`, `backup_to_cloud`, `restore_from_cloud`,
  `check_sync_status`) are now `async fn` + `spawn_blocking`, so a long
  sync can't starve Tauri's async runtime / other commands.
- Live progress is emitted via a `sync-progress` Tauri event
  (checking → pushing → pulling → done/error) and shown in the UI as a
  progress bar instead of a frozen-looking button.

## 3. Smart sync
- Every entry now has a `synced_at` column. Edits, deletes, restores,
  and favorite-toggles all mark the entry dirty (`synced_at = NULL`)
  — **note**: soft-delete/restore/favorite previously did NOT update
  `updated_at` at all, which was a real bug (deletes/restores/favorite
  changes weren't reliably syncing cross-device via last-write-wins).
  Fixed as part of this change.
- Push only sends dirty entries (`list_dirty_entries_raw`), not the
  whole vault every time.
- New `check_sync_status` command does one lightweight request (field
  mask, `updated_at` only — no passwords, no full pull) to detect
  whether the cloud changed since last time, compared against a local
  `sync_meta.json` snapshot (count + max `updated_at`).
- On opening the vault / signing in, the app calls `check_sync_status`
  first. If nothing changed on either side, it skips syncing entirely
  (fast startup, no needless network calls). If something did change,
  it auto-syncs quietly and only toasts if something was actually
  pushed/pulled.

## 4. Version bump
`4.0.0` → `5.0.1` in `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and the in-app "About" display.

---

## ⚠️ Important — please build & test locally before shipping
This sandbox has no Rust/Cargo toolchain, so **the Rust changes could
not be compiled here** (only manually reviewed very carefully — brace/
paren-balance checked, types traced by hand). The **frontend (React/TS)
was fully compiled and built successfully** (`tsc --noEmit` clean,
`npm run build` clean).

Before shipping, please run locally:
```bash
npm install
npm run tauri dev      # sanity check at runtime
cargo build --manifest-path src-tauri/Cargo.toml   # or just tauri build
```
Specifically re-test:
- Add/edit/delete/restore/favorite an entry → correct toast appears
- Sign in with Google, click "Sync now" with a vault of 50+ entries →
  should complete in a few seconds with a visible progress bar, not
  freeze
- Close and reopen the app → should auto-sync only if something
  changed (try: (a) no changes → instant, no toast; (b) edit locally
  → auto push on next open; (c) edit on another device → auto pull on
  this device's next open)
- Kill your network mid-sync → should show a clear error toast (not
  hang forever) thanks to the 20s timeout

## Next phase (per your request)
Mobile app — **Tauri Mobile (Android)**, reusing this same Rust core
(`#[cfg_attr(mobile, tauri::mobile_entry_point)]` is already in
`lib.rs`) and the same React UI. We'll pick this up next.
