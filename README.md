# NexPass

v4 · NexApp · Developed by Arabi Islam, MR. ARX

A desktop credential vault built with Tauri (Rust) + React. v1 scaffold:
local-only vault with PIN unlock. Cloud sync and browser autofill are
planned for later versions.

## Before you run this

1. **Icon**: a placeholder icon is included at `src-tauri/icons/` and
   `public/assets/icon.png`. Replace both with your real logo — for the
   `src-tauri/icons/` set, run:
   ```
   npm install -g @tauri-apps/cli
   tauri icon path/to/your/icon.png
   ```
   This regenerates all platform-specific sizes automatically.

2. **Prerequisites**: Node.js 18+, and Rust (via `rustup`). Tauri also
   needs platform build tools — see
   https://v2.tauri.app/start/prerequisites/ for your OS.

## Getting it running

```bash
npm install
npm run tauri dev
```

First run: you'll be asked to create a 6-digit PIN (entered twice to
confirm). After that, the app will always ask for that PIN to unlock.

## What's here vs. what's next

- ✅ Project shell: Vite + React + TypeScript frontend, Tauri + Rust backend
- ✅ Branding: app name, version, identifier, window config, placeholder icon
- ✅ Crypto module (`src-tauri/src/crypto.rs`): Argon2id key derivation + AES-256-GCM encrypt/decrypt
- ✅ Storage module (`src-tauri/src/storage.rs`): saves/loads vault metadata locally
- ✅ PIN unlock screen: first-run setup + returning-user unlock, with a shake animation on wrong PIN
- ✅ Release build tuned for a smaller, faster binary (LTO, stripped symbols)
- ✅ Google Sign-In (`src-tauri/src/google_auth.rs`): opens the system browser, catches the redirect on a local loopback server, exchanges tokens with Google then Firebase Auth
- ✅ Firestore sync (`src-tauri/src/sync.rs`): push/pull already-encrypted entries, last-write-wins by timestamp
- ✅ Redesigned UI: search bar, two-pane list + detail layout, favicon-style avatars (falls back to an initial-letter avatar when a site has no favicon), copy/edit/delete icons, toast feedback, smooth hover states
- ⬜ Sidebar categories (Favorites, Cards, Secure Notes, Identities, Trash) — not built yet, only "All items" exists for now
- ⬜ Browser autofill extension — later version

## Note on the current UI

The list+detail layout, search, and favicon avatars are built and working.
Category sidebar items, a security-strength meter, and premium upsell —
if you want any of those from your reference design — aren't implemented;
say the word and they can be added next.

## ⚠️ Security note on `google_auth.rs`

The Google OAuth Client ID/Secret and Firebase Web API key are hardcoded
in `src-tauri/src/google_auth.rs` for now, to get sign-in working
quickly. Before you publish this repo anywhere public (GitHub, etc.) or
ship a release build:
- Move these three values out of source into a build-time config or
  `.env` file that's git-ignored.
- The Client ID/API key aren't secret by nature (they're visible in any
  compiled binary regardless), but keeping them out of version control
  is still good practice — and if you ever rotate the Client Secret,
  you won't have to hunt through git history.

## Where the PIN and vault data live

`vault_meta.json` is saved in the OS app-data directory (Tauri resolves
this automatically per platform — e.g.
`%APPDATA%/com.nexapp.nexpass/` on Windows). It contains only a salt
and a verification hash — never the PIN itself, and never the
encryption key.
