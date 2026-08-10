import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

const APP_NAME = "NexPass";
const APP_VERSION = "5.0.1";
const APP_AUTHOR = "NexApp";
const APP_DEVELOPERS = "Arabi Islam, MR. ARX";
const LOGO_SRC = "/assets/icon.png";
const PIN_LENGTH = 6;
const CLIPBOARD_CLEAR_MS = 15000;

type Screen = "loading" | "create-pin" | "confirm-pin" | "enter-pin" | "vault";
type PanelMode = "none" | "view" | "edit" | "add";
type NavKey = "all" | "favorites" | "logins" | "cards" | "notes" | "identities" | "trash";
type SortMode = "recent" | "name";

interface GoogleSession {
  email: string;
  local_id: string;
}

type ToastType = "success" | "error" | "info";
interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface SyncProgressEvent {
  phase: "checking" | "pushing" | "pulling" | "done" | "error";
  done: number;
  total: number;
  message: string;
}

interface SyncStatus {
  local_dirty: number;
  remote_changed: boolean;
  needs_sync: boolean;
  last_sync_at: number;
  last_sync_ok: boolean;
}

interface VaultKeyDebugInfo {
  local_salt_prefix: string | null;
  cloud_salt_prefix: string | null;
  salts_match: boolean;
  google_email: string | null;
}

interface EntrySummary {
  id: string;
  title: string;
  username: string;
  url: string;
  updated_at: number;
  favorite: boolean;
}

interface EntryFull extends EntrySummary {
  password: string;
  notes: string;
}

interface EntryFormState {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
}

const emptyForm: EntryFormState = { title: "", username: "", password: "", url: "", notes: "" };
const IS_MOBILE_PLATFORM = /Android|iPhone|iPad/i.test(navigator.userAgent);

const AVATAR_COLORS = ["#38bdf8", "#a78bfa", "#f472b6", "#fb923c", "#4ade80", "#facc15", "#60a5fa"];

function avatarColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function hostnameOf(url: string): string | null {
  if (!url.trim()) return null;
  try {
    const withProto = url.startsWith("http") ? url : `https://${url}`;
    return new URL(withProto).hostname;
  } catch {
    return null;
  }
}

function faviconUrl(url: string): string | null {
  const host = hostnameOf(url);
  return host ? `https://www.google.com/s2/favicons?sz=64&domain=${host}` : null;
}

function timeAgo(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const Icon = {
  search: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  lock: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  sync: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  ),
  checkCircle: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  ),
  back: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  ),
  alertCircle: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="7.5" x2="12" y2="13" /><circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
    </svg>
  ),
  infoCircle: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="11" /><circle cx="12" cy="7.5" r="0.5" fill="currentColor" />
    </svg>
  ),
  eye: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ),
  copy: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  edit: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  trash: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  plus: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  star: ({ filled }: { filled?: boolean }) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  grid: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  filter: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  ),
  card: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  ),
  note: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
    </svg>
  ),
  user: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
  shield: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  external: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  undo: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  ),
  gear: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  close: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  download: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  upload: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
};

const PRIMARY_NAV: { key: NavKey; label: string; icon: () => JSX.Element; builtin: boolean }[] = [
  { key: "all", label: "All Items", icon: Icon.grid, builtin: true },
  { key: "favorites", label: "Favorites", icon: () => <Icon.star />, builtin: true },
  { key: "logins", label: "Logins", icon: Icon.lock, builtin: true },
  { key: "cards", label: "Cards", icon: Icon.card, builtin: false },
  { key: "notes", label: "Secure Notes", icon: Icon.note, builtin: false },
  { key: "identities", label: "Identities", icon: Icon.user, builtin: false },
];

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [pin, setPin] = useState("");
  const [firstPin, setFirstPin] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);

  const [googleSession, setGoogleSession] = useState<GoogleSession | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncError, setSyncError] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncProgressEvent | null>(null);
  const [keyMismatch, setKeyMismatch] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [reconcilePin, setReconcilePin] = useState("");
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileError, setReconcileError] = useState("");
  const [debugInfo, setDebugInfo] = useState<VaultKeyDebugInfo | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);

  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [trashEntries, setTrashEntries] = useState<EntrySummary[]>([]);
  const [entriesError, setEntriesError] = useState("");
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [nav, setNav] = useState<NavKey>("all");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<EntryFull | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("none");
  const [form, setForm] = useState<EntryFormState>(emptyForm);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "account" | "about">("general");
  const [appSettings, setAppSettings] = useState({ minimize_to_tray: true, notifications_enabled: true, auto_lock_minutes: 5 });
  const [exportPassword, setExportPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMsg, setAccountMsg] = useState("");
  const [deleteEmailInput, setDeleteEmailInput] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void; danger?: boolean } | null>(null);
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    invoke<boolean>("vault_exists")
      .then((exists) => setScreen(exists ? "enter-pin" : "create-pin"))
      .catch(() => setError("Could not reach the app backend."));
  }, []);

  useEffect(() => {
    if (screen !== "vault") return;
    invoke<GoogleSession | null>("google_session_status").then(setGoogleSession).catch(() => {});
    invoke<typeof appSettings>("get_settings").then(setAppSettings).catch(() => {});
    loadAll();
  }, [screen]);

  useEffect(() => {
    function onKeyDown2(e: KeyboardEvent) {
      if (screen !== "vault") return;
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown2);
    return () => window.removeEventListener("keydown", onKeyDown2);
  }, [screen]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const pinScreens: Screen[] = ["create-pin", "confirm-pin", "enter-pin"];
      if (!pinScreens.includes(screen)) return;
      if (e.key >= "0" && e.key <= "9") handleDigit(e.key);
      else if (e.key === "Backspace") handleBackspace();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const toastIdRef = useRef(0);
  function showToast(message: string, type: ToastType = "success", ms = 2600) {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ms);
  }
  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // Live progress from the Rust side during sync — this is what
  // replaces the old "app looks frozen while 60 credentials sync"
  // experience with real feedback (checking → pushing → pulling → done).
  useEffect(() => {
    const unlistenPromise = listen<SyncProgressEvent>("sync-progress", (event) => {
      setSyncProgress(event.payload);
      if (event.payload.phase === "done" || event.payload.phase === "error") {
        setTimeout(() => setSyncProgress(null), 1200);
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Smart sync: on entering the vault, ask the backend (one lightweight
  // request) whether anything actually changed locally or remotely
  // since last time — and only run a full sync if it did, instead of
  // always pushing/pulling everything on every app open.
  useEffect(() => {
    if (screen !== "vault" || !googleSession) return;
    let cancelled = false;

    // Run BEFORE the sync-status check: if this is the account's first
    // device, this publishes its key material; if another device
    // already published one and it's different, this surfaces the
    // reconcile dialog instead of letting sync fail with a confusing
    // decrypt error. This runs on every vault load (not just right
    // after clicking "Sign in with Google") because a Google session
    // saved from a previous app version, before this check existed,
    // would otherwise never get a chance to publish/verify its key.
    invoke<string>("check_cloud_vault_key")
      .then((status) => {
        if (cancelled) return;
        if (status === "mismatch") {
          setKeyMismatch(true);
          return;
        }
        invoke<SyncStatus>("check_sync_status")
          .then((s) => {
            if (cancelled) return;
            if (s.needs_sync) {
              handleSyncNow(true);
            } else if (!s.last_sync_ok && s.last_sync_at > 0) {
              showToast("Last sync didn't finish — will retry in background", "info");
              handleSyncNow(true);
            }
          })
          .catch(() => {});
      })
      .catch(() => {
        // Not signed in yet, or offline — silently skip. Manual "Sync
        // now" and explicit sign-in remain available in Settings.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, googleSession]);

  function triggerError(message: string) {
    setError(message);
    setShake(true);
    setPin("");
    setTimeout(() => setShake(false), 400);
  }

  async function handleDigit(digit: string) {
    if (pin.length >= PIN_LENGTH) return;
    const next = pin + digit;
    setPin(next);
    setError("");
    if (next.length !== PIN_LENGTH) return;

    if (screen === "create-pin") {
      setFirstPin(next);
      setPin("");
      setScreen("confirm-pin");
      return;
    }
    if (screen === "confirm-pin") {
      if (next !== firstPin) {
        triggerError("PINs didn't match — try again from the start.");
        setFirstPin("");
        setScreen("create-pin");
        return;
      }
      try {
        await invoke("setup_pin", { pin: next });
        setPin("");
        setScreen("vault");
      } catch (e) {
        triggerError(String(e));
      }
      return;
    }
    if (screen === "enter-pin") {
      try {
        const ok = await invoke<boolean>("unlock_with_pin", { pin: next });
        if (ok) {
          setPin("");
          setScreen("vault");
        } else {
          triggerError("Wrong PIN — try again.");
        }
      } catch (e) {
        triggerError(String(e));
      }
    }
  }

  function handleBackspace() {
    setPin((p) => p.slice(0, -1));
    setError("");
  }

  async function handleGoogleSignIn() {
    setSigningIn(true);
    setSyncError("");
    try {
      const s = await invoke<GoogleSession>("google_sign_in");
      setGoogleSession(s);
      // This device may already have a local PIN/vault (the normal
      // flow — PIN is set up before linking an account). Check whether
      // this account already has a DIFFERENT vault key from another
      // device, which would otherwise silently make sync produce
      // undecryptable data.
      try {
        const status = await invoke<string>("check_cloud_vault_key");
        if (status === "mismatch") {
          setKeyMismatch(true);
        }
      } catch {
        // non-fatal — manual "Sync now" will surface any real problem
      }
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSigningIn(false);
    }
  }

  async function handleReconcileVaultKey() {
    if (reconcilePin.length < 4) {
      setReconcileError("Enter the PIN this account's vault was set up with.");
      return;
    }
    setReconcileBusy(true);
    setReconcileError("");
    try {
      await invoke("adopt_cloud_vault_key", { pin: reconcilePin });
      setKeyMismatch(false);
      setReconcilePin("");
      showToast("Vault key synced — pulling this account's data…", "success");
      await handleSyncNow(false);
    } catch (e) {
      setReconcileError(String(e));
    } finally {
      setReconcileBusy(false);
    }
  }

  async function handleSyncNow(silent = false) {
    if (syncing) return; // avoid overlapping syncs (e.g. auto + manual click)
    setSyncing(true);
    setSyncError("");
    setSyncMessage("");
    try {
      const summary = await invoke<{ pushed: number; pulled: number; skipped: boolean }>("sync_now");
      const msg = `Pushed ${summary.pushed} · Pulled ${summary.pulled}`;
      setSyncMessage(msg);
      if (!silent) {
        showToast(summary.pushed || summary.pulled ? `Synced — ${msg}` : "Already up to date", "success");
      } else if (summary.pushed || summary.pulled) {
        // Auto-triggered but something actually changed — worth a
        // quiet confirmation rather than a fully silent background sync.
        showToast(`Synced — ${msg}`, "success", 2000);
      }
      loadAll();
    } catch (e) {
      const message = String(e);
      if (message.includes("VAULT_KEY_MISMATCH")) {
        setKeyMismatch(true);
      } else {
        setSyncError(message);
        showToast(`Sync failed: ${message}`, "error", 4000);
      }
    } finally {
      setSyncing(false);
    }
  }

  function loadAll() {
    setEntriesError("");
    invoke<EntrySummary[]>("list_entries").then(setEntries).catch((e) => setEntriesError(String(e)));
    invoke<EntrySummary[]>("list_trash").then(setTrashEntries).catch(() => {});
  }

  async function selectEntry(id: string) {
    setSelectedId(id);
    setPasswordVisible(false);
    try {
      const entry = await invoke<EntryFull>("get_entry", { id });
      setSelectedEntry(entry);
      setPanelMode("view");
    } catch (e) {
      setEntriesError(String(e));
    }
  }

  function startAdd() {
    setForm(emptyForm);
    setSelectedId(null);
    setSelectedEntry(null);
    setPanelMode("add");
  }

  function startEdit() {
    if (!selectedEntry) return;
    setForm({
      title: selectedEntry.title,
      username: selectedEntry.username,
      password: selectedEntry.password,
      url: selectedEntry.url,
      notes: selectedEntry.notes,
    });
    setPanelMode("edit");
  }

  function cancelPanel() {
    setPanelMode(selectedEntry ? "view" : "none");
  }

  async function saveForm() {
    if (!form.title.trim()) {
      setEntriesError("Title can't be empty.");
      return;
    }
    const wasEdit = panelMode === "edit" && !!selectedId;
    try {
      if (wasEdit && selectedId) {
        await invoke("update_entry", { id: selectedId, input: form });
        loadAll();
        selectEntry(selectedId);
      } else {
        const id = await invoke<string>("add_entry", { input: form });
        loadAll();
        selectEntry(id);
      }
      showToast(wasEdit ? "Credential updated successfully" : "Credential saved successfully", "success");
    } catch (e) {
      setEntriesError(String(e));
      showToast(wasEdit ? "Failed to update credential" : "Failed to save credential", "error");
    }
  }

  async function moveToTrash() {
    if (!selectedId) return;
    try {
      await invoke("soft_delete_entry", { id: selectedId });
      setSelectedId(null);
      setSelectedEntry(null);
      setPanelMode("none");
      loadAll();
      showToast("Moved to Trash");
    } catch (e) {
      setEntriesError(String(e));
      showToast("Failed to move to Trash", "error");
    }
  }

  async function restoreSelected() {
    if (!selectedId) return;
    try {
      await invoke("restore_entry", { id: selectedId });
      setSelectedId(null);
      setSelectedEntry(null);
      setPanelMode("none");
      loadAll();
      showToast("Restored");
    } catch (e) {
      setEntriesError(String(e));
      showToast("Failed to restore item", "error");
    }
  }

  function deleteForever() {
    if (!selectedId) return;
    setConfirmDialog({
      message: "Permanently delete this item? This can't be undone.",
      danger: true,
      onConfirm: async () => {
        try {
          await invoke("permanently_delete_entry", { id: selectedId });
          setSelectedId(null);
          setSelectedEntry(null);
          setPanelMode("none");
          loadAll();
          showToast("Deleted forever");
        } catch (e) {
          setEntriesError(String(e));
          showToast("Failed to delete item", "error");
        }
        setConfirmDialog(null);
      },
    });
  }

  async function toggleFavorite(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    try {
      const newVal = await invoke<boolean>("toggle_favorite", { id });
      setEntries((prev) => prev.map((en) => (en.id === id ? { ...en, favorite: newVal } : en)));
      if (selectedEntry?.id === id) setSelectedEntry({ ...selectedEntry, favorite: newVal });
    } catch (e) {
      setEntriesError(String(e));
      showToast("Failed to update favorite", "error");
    }
  }

  async function copyToClipboard(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied`);
    setTimeout(() => navigator.clipboard.writeText("").catch(() => {}), CLIPBOARD_CLEAR_MS);
  }

  async function updateSetting(patch: Partial<typeof appSettings>) {
    const next = { ...appSettings, ...patch };
    setAppSettings(next);
    invoke("save_settings", { settings: next }).catch(() => {});
  }

  async function handleBackup() {
    setAccountBusy(true);
    setAccountMsg("");
    try {
      const n = await invoke<number>("backup_to_cloud");
      const msg = `Backed up ${n} item(s) to cloud`;
      setAccountMsg(msg);
      showToast(msg, "success");
    } catch (e) {
      const msg = String(e);
      setAccountMsg(msg);
      showToast("Backup failed", "error");
    } finally {
      setAccountBusy(false);
    }
  }

  async function handleRestore() {
    setAccountBusy(true);
    setAccountMsg("");
    try {
      const n = await invoke<number>("restore_from_cloud");
      const msg = `Restored ${n} item(s) from cloud`;
      setAccountMsg(msg);
      showToast(msg, "success");
      loadAll();
    } catch (e) {
      const msg = String(e);
      setAccountMsg(msg);
      showToast("Restore failed", "error");
    } finally {
      setAccountBusy(false);
    }
  }

  async function handleExport() {
    if (exportPassword.length < 6) {
      setAccountMsg("Export password must be at least 6 characters");
      return;
    }
    try {
      const json = await invoke<string>("export_vault", { password: exportPassword });
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "nexpass-export.json";
      a.click();
      URL.revokeObjectURL(url);
      setExportPassword("");
      setAccountMsg("Export downloaded");
    } catch (e) {
      setAccountMsg(String(e));
    }
  }

  async function handleImport() {
    if (!importFile || importPassword.length < 6) {
      setAccountMsg("Choose a file and enter the export password");
      return;
    }
    try {
      const content = await importFile.text();
      const n = await invoke<number>("import_vault", { fileContent: content, password: importPassword });
      setAccountMsg(`Imported ${n} item(s)`);
      setImportPassword("");
      setImportFile(null);
      loadAll();
    } catch (e) {
      setAccountMsg(String(e));
    }
  }

  function handleLogout() {
    setConfirmDialog({
      message: "Log out? This removes ALL local data from this device (cloud data stays safe if you've backed up).",
      danger: true,
      onConfirm: async () => {
        await invoke("logout_and_wipe").catch(() => {});
        setShowSettings(false);
        setScreen("create-pin");
        setEntries([]);
        setTrashEntries([]);
        setGoogleSession(null);
        setSelectedEntry(null);
        setSelectedId(null);
        setPanelMode("none");
        setForm(emptyForm);
        setConfirmDialog(null);
      },
    });
  }

  async function handleDeleteAccount() {
    if (!googleSession || deleteEmailInput.trim() !== googleSession.email) return;
    setAccountBusy(true);
    try {
      await invoke("delete_account");
      setShowSettings(false);
      setScreen("create-pin");
      setEntries([]);
      setTrashEntries([]);
      setGoogleSession(null);
    } catch (e) {
      setAccountMsg(String(e));
    } finally {
      setAccountBusy(false);
      setShowDeleteConfirm(false);
    }
  }

  async function lockNow() {
    await invoke("lock_vault").catch(() => {});
    setEntries([]);
    setTrashEntries([]);
    setSelectedEntry(null);
    setSelectedId(null);
    setPanelMode("none");
    setShowSettings(false);
    setScreen("enter-pin");
  }

  useEffect(() => {
    if (screen !== "vault") return;
    function onBlur() {
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
      if (appSettings.auto_lock_minutes <= 0) {
        lockNow();
      } else {
        lockTimerRef.current = setTimeout(lockNow, appSettings.auto_lock_minutes * 60_000);
      }
    }
    function onFocus() {
      if (lockTimerRef.current) {
        clearTimeout(lockTimerRef.current);
        lockTimerRef.current = null;
      }
    }
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    };
  }, [screen, appSettings.auto_lock_minutes]);

  async function handleLock() {
    await lockNow();
  }

  const baseList = useMemo(() => {
    if (nav === "trash") return trashEntries;
    if (nav === "favorites") return entries.filter((e) => e.favorite);
    if (nav === "all" || nav === "logins") return entries;
    return [];
  }, [nav, entries, trashEntries]);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = !q
      ? baseList
      : baseList.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.username.toLowerCase().includes(q) ||
            e.url.toLowerCase().includes(q)
        );
    list = [...list].sort((a, b) =>
      sortMode === "name" ? a.title.localeCompare(b.title) : b.updated_at - a.updated_at
    );
    return list;
  }, [baseList, search, sortMode]);

  const isPlaceholderNav = nav === "cards" || nav === "notes" || nav === "identities";
  const isTrashNav = nav === "trash";
  const favoritesCount = entries.filter((e) => e.favorite).length;

  const heading =
    screen === "create-pin" ? "Create a PIN" : screen === "confirm-pin" ? "Confirm your PIN" : screen === "enter-pin" ? "Enter your PIN" : "";
  const subheading =
    screen === "create-pin"
      ? `Choose a ${PIN_LENGTH}-digit PIN to lock your vault`
      : screen === "confirm-pin"
      ? "Enter it again to confirm"
      : screen === "enter-pin"
      ? "Unlock NexPass to continue"
      : "";

  return (
    <div className={`app-shell ${IS_MOBILE_PLATFORM ? "platform-mobile" : "platform-desktop"}`}>
      {(screen === "loading" ||
        screen === "create-pin" ||
        screen === "confirm-pin" ||
        screen === "enter-pin") && (
        <div className="centered-content full-bleed">
          {screen === "loading" && <p className="status-text">Loading…</p>}
          {screen !== "loading" && (
            <div className="pin-screen">
              <img src={LOGO_SRC} alt="" className="pin-logo" />
              <h2>{heading}</h2>
              <p className="status-text">{subheading}</p>
              <div className={`pin-dots ${shake ? "shake" : ""}`}>
                {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                  <span key={i} className={`pin-dot ${i < pin.length ? "filled" : ""}`} />
                ))}
              </div>
              {error && <p className="error-text">{error}</p>}
              <div className="keypad">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                  <button key={d} onClick={() => handleDigit(d)}>{d}</button>
                ))}
                <button className="keypad-spacer" disabled />
                <button onClick={() => handleDigit("0")}>0</button>
                <button onClick={handleBackspace} aria-label="Backspace">⌫</button>
              </div>
            </div>
          )}
        </div>
      )}

      {screen === "vault" && (
        <div className="vault-layout">
          {mobileSidebarOpen && <div className="sidebar-scrim" onClick={() => setMobileSidebarOpen(false)} />}
          <aside className={`sidebar ${mobileSidebarOpen ? "sidebar-open" : ""}`}>
            <div className="sidebar-brand">
              <img src={LOGO_SRC} alt="" className="app-logo" />
              <div>
                <div className="sidebar-title">{APP_NAME}</div>
                <div className="sidebar-meta">v{APP_VERSION} · {APP_AUTHOR} · {APP_DEVELOPERS}</div>
              </div>
            </div>

            <nav className="side-nav">
              {PRIMARY_NAV.map((item) => {
                const count = item.key === "all" || item.key === "logins" ? entries.length : item.key === "favorites" ? favoritesCount : 0;
                return (
                  <button
                    key={item.key}
                    className={`side-nav-item ${nav === item.key ? "active" : ""} ${!item.builtin ? "muted" : ""}`}
                    onClick={() => {
                      setNav(item.key);
                      setPanelMode("none");
                      setSelectedId(null);
                      setMobileSidebarOpen(false);
                    }}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                    <span className="side-nav-count">{count}</span>
                  </button>
                );
              })}
              <button
                className={`side-nav-item ${nav === "trash" ? "active" : ""}`}
                onClick={() => {
                  setNav("trash");
                  setPanelMode("none");
                  setSelectedId(null);
                  setMobileSidebarOpen(false);
                }}
              >
                <Icon.trash />
                <span>Trash</span>
                <span className="side-nav-count">{trashEntries.length}</span>
              </button>
            </nav>

            <div className="sidebar-section-label">SECURITY</div>
            <div className="vault-status-card">
              <div className="vault-status-top">
                <span className="shield-icon"><Icon.shield /></span>
                <div>
                  <div className="vault-status-label">Vault Status</div>
                  <div className="vault-status-value">Secure</div>
                </div>
              </div>
              <div className="vault-status-meta">
                <span>{entries.length} item{entries.length === 1 ? "" : "s"} encrypted</span>
                <span className="vault-status-sub">AES-256-GCM · Argon2id PIN</span>
              </div>
            </div>

            {googleSession ? (
              <div className="sync-card">
                <div className="sync-card-email">{googleSession.email}</div>
                <button className="sync-card-btn" onClick={() => handleSyncNow(false)} disabled={syncing}>
                  <span className={syncing ? "spin" : ""}><Icon.sync /></span>
                  {syncing ? "Syncing…" : "Sync now"}
                </button>
                {syncing && syncProgress && (syncProgress.phase === "pushing" || syncProgress.phase === "pulling") && syncProgress.total > 0 && (
                  <div className="sync-card-progress">
                    <div className="sync-card-progress-bar">
                      <div
                        className="sync-card-progress-fill"
                        style={{ width: `${Math.min(100, (syncProgress.done / syncProgress.total) * 100)}%` }}
                      />
                    </div>
                    <span className="sync-card-progress-label">
                      {syncProgress.message} ({syncProgress.done}/{syncProgress.total})
                    </span>
                  </div>
                )}
                {syncMessage && <div className="sync-card-msg">{syncMessage}</div>}
                {syncError && <div className="error-text small">{syncError}</div>}
              </div>
            ) : (
              <button className="sync-card-btn outline" onClick={handleGoogleSignIn} disabled={signingIn}>
                {signingIn ? "Waiting for browser…" : "Sign in with Google"}
              </button>
            )}

            <button className="side-nav-item settings-trigger" onClick={() => setShowSettings(true)}>
              <Icon.gear /><span>Settings</span>
            </button>
          </aside>

          <div className="main-column">
            <div className="mobile-app-header">
              <img src="/assets/icon.png" className="app-logo" alt="" />
              <span className="mobile-app-title">NexPass</span>
              <button className="icon-btn" onClick={() => searchRef.current?.focus()} title="Search"><Icon.search /></button>
            </div>
            <header className="top-bar">
              <button className="icon-btn mobile-menu-btn" onClick={() => setMobileSidebarOpen(true)} title="Menu">
                <Icon.grid />
              </button>
              <div className="search-box">
                <Icon.search />
                <input ref={searchRef} placeholder="Search credentials…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <kbd>Ctrl + /</kbd>
              </div>

              <div className="top-bar-actions">
                <div className="sort-select">
                  <span>Sort:</span>
                  <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
                    <option value="recent">Recently Used</option>
                    <option value="name">Name</option>
                  </select>
                </div>
                <button className="icon-btn" title="Filters (coming soon)" onClick={() => showToast("Filters coming soon", "info")}>
                  <Icon.filter />
                </button>
                <button className="icon-btn" title="Grid view (coming soon)" onClick={() => showToast("Grid view coming soon", "info")}>
                  <Icon.grid />
                </button>
                <button className="icon-btn" onClick={handleLock} title="Lock vault">
                  <Icon.lock />
                </button>
                {!isPlaceholderNav && !isTrashNav && (
                  <button className="primary-btn" onClick={startAdd}>
                    <Icon.plus /> New Item
                  </button>
                )}
              </div>
            </header>

            <div className={`vault-body ${selectedId || panelMode !== "none" ? "mobile-detail-open" : ""}`}>
              <section className="list-column">
                <div className="list-column-header">
                  <h2>
                    {nav === "all" && "All Items"}
                    {nav === "favorites" && "Favorites"}
                    {nav === "logins" && "Logins"}
                    {nav === "cards" && "Cards"}
                    {nav === "notes" && "Secure Notes"}
                    {nav === "identities" && "Identities"}
                    {nav === "trash" && "Trash"}
                  </h2>
                  <span className="status-text">{filteredEntries.length} item{filteredEntries.length === 1 ? "" : "s"}</span>
                </div>

                {entriesError && <p className="error-text small">{entriesError}</p>}

                {isPlaceholderNav ? (
                  <p className="status-text empty-hint">This category isn't built yet — coming in a future update.</p>
                ) : filteredEntries.length === 0 ? (
                  <p className="status-text empty-hint">
                    {search ? "No matches." : isTrashNav ? "Trash is empty." : "No entries yet — add your first one."}
                  </p>
                ) : (
                  <ul className="entry-list">
                    {filteredEntries.map((entry) => {
                      const icon = faviconUrl(entry.url);
                      return (
                        <li
                          key={entry.id}
                          className={`entry-row ${selectedId === entry.id ? "active" : ""}`}
                          onClick={() => selectEntry(entry.id)}
                        >
                          <span className="avatar" style={{ background: icon ? "transparent" : avatarColor(entry.title) }}>
                            {icon ? <img src={icon} alt="" onError={(e) => (e.currentTarget.style.display = "none")} /> : entry.title.charAt(0).toUpperCase() || "?"}
                          </span>
                          <span className="entry-row-text">
                            <span className="entry-row-title">{entry.title}</span>
                            <span className="entry-row-sub">{entry.username || entry.url || "—"}</span>
                          </span>
                          <span className="entry-row-time">{timeAgo(entry.updated_at)}</span>
                          {!isTrashNav && (
                            <button
                              className={`star-btn ${entry.favorite ? "filled" : ""}`}
                              onClick={(e) => toggleFavorite(entry.id, e)}
                              title="Toggle favorite"
                            >
                              <Icon.star filled={entry.favorite} />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="detail-panel">
                {panelMode === "none" && (
                  <div className="centered-content">
                    <p className="status-text">Select an item to view it{!isPlaceholderNav && !isTrashNav ? ", or add a new one" : ""}.</p>
                  </div>
                )}

                {panelMode === "view" && selectedEntry && (
                  <div className="detail-content">
                    <div className="detail-header">
                      <button
                        className="icon-btn mobile-back-btn"
                        onClick={() => { setSelectedId(null); setSelectedEntry(null); setPanelMode("none"); }}
                        title="Back"
                      >
                        <Icon.back />
                      </button>
                      <span className="avatar large" style={{ background: faviconUrl(selectedEntry.url) ? "transparent" : avatarColor(selectedEntry.title) }}>
                        {faviconUrl(selectedEntry.url) ? <img src={faviconUrl(selectedEntry.url)!} alt="" /> : selectedEntry.title.charAt(0).toUpperCase() || "?"}
                      </span>
                      <h2>{selectedEntry.title}</h2>
                      <div className="detail-header-actions">
                        {!isTrashNav && (
                          <button className={`icon-btn ${selectedEntry.favorite ? "star-active" : ""}`} onClick={() => toggleFavorite(selectedEntry.id)} title="Favorite">
                            <Icon.star filled={selectedEntry.favorite} />
                          </button>
                        )}
                        {isTrashNav ? (
                          <>
                            <button className="icon-btn" onClick={restoreSelected} title="Restore">
                              <Icon.undo />
                            </button>
                            <button className="icon-btn danger" onClick={deleteForever} title="Delete forever">
                              <Icon.trash />
                            </button>
                          </>
                        ) : (
                          <>
                            <button className="icon-btn" onClick={startEdit} title="Edit">
                              <Icon.edit />
                            </button>
                            <button className="icon-btn danger" onClick={moveToTrash} title="Move to Trash">
                              <Icon.trash />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="field-block">
                      <label>Username / Email</label>
                      <div className="field-row">
                        <span>{selectedEntry.username || "—"}</span>
                        {selectedEntry.username && (
                          <button className="icon-btn" onClick={() => copyToClipboard(selectedEntry.username, "Username")}><Icon.copy /></button>
                        )}
                      </div>
                    </div>

                    <div className="field-block">
                      <label>Password</label>
                      <div className="field-row">
                        <span className="password-field">
                          {passwordVisible ? selectedEntry.password : "•".repeat(Math.max(8, selectedEntry.password.length))}
                        </span>
                        <button className="icon-btn" onClick={() => setPasswordVisible((v) => !v)}><Icon.eye /></button>
                        <button className="icon-btn" onClick={() => copyToClipboard(selectedEntry.password, "Password")}><Icon.copy /></button>
                      </div>
                    </div>

                    {selectedEntry.url && (
                      <div className="field-block">
                        <label>Website</label>
                        <div className="field-row">
                          <a href={selectedEntry.url} target="_blank" rel="noreferrer" className="url-link">{selectedEntry.url}</a>
                          <Icon.external />
                        </div>
                      </div>
                    )}

                    <div className="field-block">
                      <label>Category</label>
                      <span className="category-pill">Login</span>
                    </div>

                    {selectedEntry.notes && (
                      <div className="field-block">
                        <label>Notes</label>
                        <p className="notes-text">{selectedEntry.notes}</p>
                      </div>
                    )}

                    <div className="meta-grid">
                      <div>
                        <label>Updated</label>
                        <span>{formatDateTime(selectedEntry.updated_at)}</span>
                      </div>
                    </div>
                  </div>
                )}

                {(panelMode === "edit" || panelMode === "add") && (
                  <div className="detail-content">
                    <div className="form-header-row">
                      <button
                        className="icon-btn mobile-back-btn"
                        onClick={() => { setSelectedId(null); setSelectedEntry(null); setPanelMode("none"); }}
                        title="Back"
                      >
                        <Icon.back />
                      </button>
                      <h2>{panelMode === "edit" ? "Edit item" : "New item"}</h2>
                    </div>
                    <label className="form-label">Title
                      <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Gmail" autoFocus />
                    </label>
                    <label className="form-label">Username / Email
                      <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                    </label>
                    <label className="form-label">Password
                      <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                    </label>
                    <label className="form-label">Website
                      <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" />
                    </label>
                    <label className="form-label">Notes
                      <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                    </label>
                    <div className="form-actions">
                      <button onClick={cancelPanel}>Cancel</button>
                      <button className="primary-btn" onClick={saveForm}>Save</button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}

      {screen === "vault" && (
        <nav className="mobile-tab-bar">
          <button
            className={nav !== "trash" && !mobileSidebarOpen && !showSettings && nav === "all" ? "active" : ""}
            onClick={() => { setNav("all"); setSelectedId(null); setSelectedEntry(null); setPanelMode("none"); setMobileSidebarOpen(false); setShowSettings(false); }}
          >
            <Icon.shield />
            <span>Vault</span>
          </button>
          <button
            className={!mobileSidebarOpen && !showSettings && nav === "favorites" ? "active" : ""}
            onClick={() => { setNav("favorites"); setSelectedId(null); setSelectedEntry(null); setPanelMode("none"); setMobileSidebarOpen(false); setShowSettings(false); }}
          >
            <Icon.star filled={false} />
            <span>Favorites</span>
          </button>
          <button
            className={mobileSidebarOpen ? "active" : ""}
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Icon.grid />
            <span>Categories</span>
          </button>
          <button
            className={showSettings ? "active" : ""}
            onClick={() => setShowSettings(true)}
          >
            <Icon.gear />
            <span>Settings</span>
          </button>
        </nav>
      )}

      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-panel-header">
              <div className="settings-tabs">
                {(["general", "account", "about"] as const).map((t) => (
                  <button key={t} className={settingsTab === t ? "active" : ""} onClick={() => { setSettingsTab(t); setAccountMsg(""); }}>
                    {t === "general" ? "General" : t === "account" ? "Account" : "About"}
                  </button>
                ))}
              </div>
              <button className="icon-btn" onClick={() => setShowSettings(false)}><Icon.close /></button>
            </div>

            <div className="settings-body">
              {settingsTab === "general" && (
                <div className="settings-section">
                  <div className="settings-row">
                    <div>
                      <div className="settings-row-title">Minimize to tray</div>
                      <div className="settings-row-sub">Closing the window hides it to the system tray instead of quitting.</div>
                    </div>
                    <label className="switch">
                      <input type="checkbox" checked={appSettings.minimize_to_tray} onChange={(e) => updateSetting({ minimize_to_tray: e.target.checked })} />
                      <span />
                    </label>
                  </div>
                  <div className="settings-row">
                    <div>
                      <div className="settings-row-title">Notifications</div>
                      <div className="settings-row-sub">Enable app notifications. (No alerts trigger yet — this just sets the preference.)</div>
                    </div>
                    <label className="switch">
                      <input type="checkbox" checked={appSettings.notifications_enabled} onChange={(e) => updateSetting({ notifications_enabled: e.target.checked })} />
                      <span />
                    </label>
                  </div>
                  <div className="settings-row">
                    <div>
                      <div className="settings-row-title">Auto-lock</div>
                      <div className="settings-row-sub">Locks the vault after the app loses focus for this long.</div>
                    </div>
                    <select className="settings-select" value={appSettings.auto_lock_minutes} onChange={(e) => updateSetting({ auto_lock_minutes: Number(e.target.value) })}>
                      <option value={0}>Instant</option>
                      <option value={1}>1 minute</option>
                      <option value={5}>5 minutes</option>
                      <option value={10}>10 minutes</option>
                    </select>
                  </div>
                  <div className="settings-row">
                    <div>
                      <div className="settings-row-title">Shortcuts</div>
                      <div className="settings-row-sub">Ctrl + / — Focus search</div>
                    </div>
                  </div>
                </div>
              )}

              {settingsTab === "account" && (
                <div className="settings-section">
                  {accountMsg && <p className="status-text">{accountMsg}</p>}

                  <div className="settings-row">
                    <div>
                      <div className="settings-row-title">Log out</div>
                      <div className="settings-row-sub">Removes all data from this device. Back up first if you haven't synced.</div>
                    </div>
                    <button className="settings-btn" onClick={handleLogout}>Log out</button>
                  </div>

                  <div className="settings-row column">
                    <div className="settings-row-title">Vault key diagnostic</div>
                    <div className="settings-row-sub">
                      Compare this device's key with the account's cloud key — should say "match" on every
                      device signed into the same account. Screenshot this alongside the other device's if
                      you need help.
                    </div>
                    <button
                      className="settings-btn"
                      disabled={debugBusy}
                      onClick={async () => {
                        setDebugBusy(true);
                        try {
                          setDebugInfo(await invoke<VaultKeyDebugInfo>("debug_vault_key_info"));
                        } catch (e) {
                          showToast(String(e), "error");
                        } finally {
                          setDebugBusy(false);
                        }
                      }}
                    >
                      {debugBusy ? "Checking…" : "Check vault key"}
                    </button>
                    {debugInfo && (
                      <div className="settings-row-sub" style={{ marginTop: 8, fontFamily: "monospace" }}>
                        Account: {debugInfo.google_email ?? "not signed in"}
                        <br />
                        Local salt: {debugInfo.local_salt_prefix ?? "none"}
                        <br />
                        Cloud salt: {debugInfo.cloud_salt_prefix ?? "none"}
                        <br />
                        <strong style={{ color: debugInfo.salts_match ? "#34d399" : "#f87171" }}>
                          {debugInfo.salts_match ? "✓ MATCH" : "✗ MISMATCH"}
                        </strong>
                      </div>
                    )}
                  </div>

                  <div className="settings-row">
                    <div>
                      <div className="settings-row-title">Backup / Restore</div>
                      <div className="settings-row-sub">Manual push/pull to your cloud account.</div>
                    </div>
                    <div className="settings-btn-group">
                      <button className="settings-btn" disabled={accountBusy} onClick={handleBackup}><Icon.upload /> Backup</button>
                      <button className="settings-btn" disabled={accountBusy} onClick={handleRestore}><Icon.download /> Restore</button>
                    </div>
                  </div>

                  <div className="settings-row column">
                    <div className="settings-row-title">Export credentials</div>
                    <div className="settings-row-sub">Creates an encrypted file — safe to share, needs this password to open.</div>
                    <div className="settings-inline-form">
                      <input type="password" placeholder="Export password (min 6 chars)" value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} />
                      <button className="settings-btn" onClick={handleExport}>Export</button>
                    </div>
                  </div>

                  <div className="settings-row column">
                    <div className="settings-row-title">Import credentials</div>
                    <div className="settings-row-sub">Import a NexPass export file.</div>
                    <div className="settings-inline-form">
                      <input type="file" accept=".json" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
                      <input type="password" placeholder="Export password" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} />
                      <button className="settings-btn" onClick={handleImport}>Import</button>
                    </div>
                  </div>

                  <div className="settings-row column danger-zone">
                    <div className="settings-row-title">Delete account</div>
                    <div className="settings-row-sub">Permanently deletes ALL your data from the cloud and this device.</div>
                    {!showDeleteConfirm ? (
                      <button className="settings-btn danger" onClick={() => setShowDeleteConfirm(true)}>Delete account</button>
                    ) : (
                      <div className="delete-confirm">
                        <p className="error-text">
                          If you DELETE YOUR ACCOUNT, ALL OF YOUR DATA WILL BE REMOVED FROM THE CLOUD. Type your
                          email ({googleSession?.email ?? "sign in first"}) to confirm.
                        </p>
                        <input value={deleteEmailInput} onChange={(e) => setDeleteEmailInput(e.target.value)} placeholder="your@email.com" />
                        <div className="settings-btn-group">
                          <button className="settings-btn" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
                          <button
                            className="settings-btn danger"
                            disabled={!googleSession || deleteEmailInput.trim() !== googleSession.email || accountBusy}
                            onClick={handleDeleteAccount}
                          >
                            Delete forever
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {settingsTab === "about" && (
                <div className="settings-section">
                  <div className="settings-row">
                    <div><div className="settings-row-title">App Name</div></div>
                    <span>{APP_NAME}</span>
                  </div>
                  <div className="settings-row">
                    <div><div className="settings-row-title">Version</div></div>
                    <span>v{APP_VERSION}</span>
                  </div>
                  <div className="settings-row">
                    <div><div className="settings-row-title">App ID</div></div>
                    <span className="copyable" onClick={() => copyToClipboard("com.nexapp.nexpass", "App ID")}>com.nexapp.nexpass</span>
                  </div>
                  <div className="settings-row">
                    <div><div className="settings-row-title">Author</div></div>
                    <a className="plain-link" href="https://nexappog.vercel.app" target="_blank" rel="noreferrer">{APP_AUTHOR}</a>
                  </div>
                  <div className="settings-row">
                    <div><div className="settings-row-title">Developer</div></div>
                    <a className="plain-link" href="https://arabiislam.odoo.com" target="_blank" rel="noreferrer">{APP_DEVELOPERS}</a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {keyMismatch && (
        <div className="confirm-overlay">
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <p>
              This Google account's vault was already set up with a different PIN on another
              device. Enter <strong>that device's PIN</strong> to sync this device with it.
              This device's local entries (if any) will be replaced by the account's synced data.
            </p>
            <input
              type="password"
              inputMode="numeric"
              className="delete-confirm-input"
              value={reconcilePin}
              onChange={(e) => {
                setReconcilePin(e.target.value.replace(/\D/g, ""));
                setReconcileError("");
              }}
              placeholder="Enter that device's PIN"
              autoFocus
            />
            {reconcileError && <p className="error-text">{reconcileError}</p>}
            <div className="settings-btn-group">
              <button
                className="settings-btn"
                onClick={() => {
                  setKeyMismatch(false);
                  setReconcilePin("");
                  setReconcileError("");
                }}
              >
                Cancel
              </button>
              <button className="settings-btn" disabled={reconcileBusy} onClick={handleReconcileVaultKey}>
                {reconcileBusy ? "Verifying…" : "Sync this device"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="confirm-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <p>{confirmDialog.message}</p>
            <div className="settings-btn-group">
              <button className="settings-btn" onClick={() => setConfirmDialog(null)}>Cancel</button>
              <button className={`settings-btn ${confirmDialog.danger ? "danger" : ""}`} onClick={confirmDialog.onConfirm}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismissToast(t.id)}>
            <span className="toast-icon">
              {t.type === "success" && <Icon.checkCircle />}
              {t.type === "error" && <Icon.alertCircle />}
              {t.type === "info" && <Icon.infoCircle />}
            </span>
            <span className="toast-msg">{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
