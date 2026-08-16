# NexPass desktop redesign — final delivery

Repo: https://github.com/nexerisltd/NexPass-Android (Tauri + React, not
Flutter). 5 files changed in total. Everything else — crypto, vault,
sync, storage, google_auth, biometric, settings backend, the installer
plugin — is untouched.

- `src/App.tsx`
- `src/App.css`
- `src-tauri/src/lib.rs`
- `src-tauri/src/updater.rs`
- `src-tauri/tauri.conf.json`

## What changed, grouped by topic

### 1. Desktop layout (App.tsx / App.css)
- Desktop (anything that isn't Android, detected via `navigator.userAgent`)
  now gets a left **sidebar** — Home / Favorites / Categories / Settings,
  a "Vault Status" card, and a profile button — instead of the mobile
  bottom island-nav. Mobile is untouched (same nav, same behavior).
- **Home tab only**: splits into a list column + a persistent 460px-wide
  detail pane on the right, with an empty-state placeholder when nothing's
  selected. A shared full-width search bar sits above both columns.
  Favorites/Categories/Settings stay single full-width columns — no
  reserved empty space, since they don't show a credential's detail there.
- Detail pane's back/star/edit/delete row lines up with the list's
  "Recent / lock / New Item" toolbar row (both are the first thing in
  their column, right under the search bar) — no repeated title in that
  row, since the item's name already shows next to its icon below.
- If a credential is ever opened from outside the Home tab, it falls back
  to a full-screen modal (same as Add/Edit/Profile) instead of trying to
  embed next to a list that isn't split.
- Add/Edit/Profile/Pick-category panels are full-screen modals on desktop
  (matching mobile's full-page behavior), not small popups.
- List column's width is now driven by CSS Grid (`grid-template-columns`)
  instead of flexbox, so it can't shift/resize when the detail pane's
  content changes.
- Themed scrollbars (thin, dark) instead of the default light OS/webview
  scrollbar that didn't match the theme.
- Categories page keeps its own title (only Home/Favorites' per-tab
  header is replaced by the shared search bar above).
- Auto-lock, "Instant" setting: uses Tauri's native
  `getCurrentWindow().onFocusChanged()` instead of DOM `blur`, which
  isn't reliable for real OS-level focus loss inside a WebView2 host.
- Auto-lock, "N minutes": now based on mouse/keyboard idle time rather
  than window blur/focus — previously the timer only ever got *armed* by
  a blur event, so a window that just sat open and untouched (very
  normal for a desktop app) never triggered it at all.
- App version display fixed: was a hardcoded stale `5.0.5` const, now
  reads `6.0.1` (matching package.json/Cargo.toml/tauri.conf.json) and
  displays as `V.6.0.1`.

### 2. Profile picture not loading (lib.rs / tauri.conf.json)
On desktop the user can pick an avatar from anywhere on disk, but the
asset protocol had no scope configured, so `convertFileSrc` silently
failed for any local file.
- `set_profile_avatar` (desktop only) now copies the picked image into
  NexPass's own app-data folder as `avatar.<ext>` and stores that path
  instead of the original; `clear_profile_avatar` deletes it. Android
  keeps the old raw-path behavior (`#[cfg(not(desktop))]`).
- `tauri.conf.json` grants `assetProtocol.scope: ["$APPDATA/**"]` — narrow
  scope (just the app's own folder), not the whole filesystem.

### 3. Update/release fetching split by platform (updater.rs)
- Android → `update.json` + `releases.json`, downloads `.apk`
  (`#[cfg(target_os = "android")]`).
- Desktop → `update-win.json` + `release-win.json`, downloads `.exe`
  (`#[cfg(not(target_os = "android"))]`).
- Download logic, progress events, and the install hand-off
  (`install_update_apk` → `tauri-plugin-nexpass-installer`) are shared —
  `desktop.rs` in that plugin already just opens whatever file it's
  given, so the `.exe` launches the same way the `.apk` does on Android.
  No plugin changes needed.

## Verified
- `npx tsc --noEmit` — clean
- `npm run build` (vite) — clean
- `tauri.conf.json` — validated as JSON
- No Rust toolchain in this sandbox, so `lib.rs`/`updater.rs` were
  reviewed by hand rather than compiled (they follow the exact
  `app.path().app_data_dir()` / `#[cfg(...)]` patterns already used
  elsewhere in the codebase). Run `cargo check` on your machine before
  shipping.
