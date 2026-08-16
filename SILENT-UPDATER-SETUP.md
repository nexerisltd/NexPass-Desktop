# Silent auto-updater — what changed and what to do next

Desktop now uses Tauri's **official, signed updater plugin** instead of the
manual "download .exe → double-click → click through the installer" flow.
Android is completely untouched — it still uses its own manifest
(update.json/releases.json) + APK install flow in updater.rs, since a
sideloaded Android app isn't allowed to silently replace itself anyway.

## ⚠️ The signing key — read this first

`signing-key/nexpass_updater_private.key` is the private half of an
Ed25519 keypair generated for this. **Treat it exactly like a password:**

- Anyone with this key can sign a fake "update" and your users' NexPass
  installs would accept it as legitimate. Store it somewhere private —
  a password manager (ironic, but yes — NexPass itself works), or at
  minimum somewhere that isn't this chat thread long-term.
- **Never commit it to git.** It's not inside the `project/` folder for
  exactly that reason — keep it separate.
- It has no password on it (empty password, for simplicity). If you'd
  rather have one, regenerate it yourself later:
  `npx @tauri-apps/cli signer generate -w nexpass_updater_private.key`
  (it'll prompt you for a password this time), then swap the `pubkey` in
  `tauri.conf.json` for the new public key and re-sign future builds with
  the new private key.
- If this key is ever exposed, generate a new one the same way and update
  `tauri.conf.json`'s `pubkey` — old installs simply won't trust updates
  signed with a different key anymore (no other cleanup needed).

The **public** key (`nexpass_updater_public.key.pub`) is already baked into
`project/src-tauri/tauri.conf.json` under `plugins.updater.pubkey` — that
one's fine to have in the repo, it's not a secret.

## What changed in the project

- `src-tauri/Cargo.toml` — added `tauri-plugin-updater` (desktop-only
  target section, same place `window-vibrancy`/tray-icon already live).
- `src-tauri/src/lib.rs` — registers the plugin under `#[cfg(desktop)]`.
- `src-tauri/capabilities/desktop.json` — **new file**, grants
  `updater:default` only on windows/macOS/linux (kept separate from
  `default.json` so it can never affect the Android build).
- `src-tauri/tauri.conf.json` — added `bundle.createUpdaterArtifacts: true`
  (tells the bundler to produce the special signed update archive
  alongside the normal setup.exe) and a `plugins.updater` block with your
  public key + the manifest endpoint URL.
- `package.json` — added `@tauri-apps/plugin-updater`.
- `src/App.tsx` — `maybeCheckForUpdate`, `handleDownloadUpdate`, and
  `handleInstallDownloadedApk` now branch on `isDesktop`: desktop calls
  the plugin's `check()` / `update.download()` / `update.install()` +
  `relaunch()`; Android is byte-for-byte what it was before. Same
  Settings UI (banner → progress bar → Install Now), just wired to a
  different backend for desktop. The "Delete APK File" button is hidden
  on desktop since there's no leftover file to manage there.

## Building a signed release

On your Windows machine, from `project/`:

```
set TAURI_SIGNING_PRIVATE_KEY=<paste the whole contents of nexpass_updater_private.key>
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
npm install
npm run tauri build
```

(PowerShell: use `$env:TAURI_SIGNING_PRIVATE_KEY = "..."` instead of `set`.)

This produces, under `src-tauri/target/release/bundle/nsis/`:
- `NexPass_6.0.1_x64-setup.exe` — the normal installer, for people
  downloading NexPass for the first time from your website/GitHub.
- `NexPass_6.0.1_x64-setup.nsis.zip` — the **update artifact**, used only
  by the silent updater. Don't rename it.
- `NexPass_6.0.1_x64-setup.nsis.zip.sig` — the signature for that zip.

## Publishing a release

1. Upload **both** the `.exe` and the `.nsis.zip` to the GitHub release
   (tag `v.6.0.1-win` or whatever the next version's tag is).
2. Open the `.sig` file, copy its whole contents.
3. Edit `NexPass-Update-repo-files/update-win-v2.json` (included here as a
   starting template) — set `version`, `notes`, `pub_date`, paste the
   signature into `signature`, and set `url` to the `.nsis.zip`'s release
   download URL.
4. Commit that file as `update-win-v2.json` in the `NexPass-Update` repo
   (same place `update-win.json`/`release-win.json` already live).
5. Keep updating `release-win.json` as before too — that one's still used
   for the human-readable "What's new" list in Settings; it's independent
   of the actual update mechanism.

`update-win.json` (the old one) is no longer read by the desktop app —
it's now dead weight for desktop, but leave it alone if Android or
anything else still depends on similarly-named files; nothing here
touches Android's `update.json`/`releases.json`.

## Testing

Bump `version` in `Cargo.toml` + `tauri.conf.json` + `package.json` +
`APP_VERSION` in `App.tsx` down by one patch level temporarily (or just
publish a real `update-win-v2.json` with a higher version than what
you've currently got installed), then use Settings → "Check for Updates"
in the running app. You should see the banner, a real progress bar while
it downloads, and "Install Now" should close and relaunch NexPass on the
new version with no separate installer window ever appearing.
