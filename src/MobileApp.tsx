import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./MobileApp.css";

interface EntrySummary { id: string; title: string; username: string; url: string; updated_at: number; favorite: boolean; }
interface EntryFull extends EntrySummary { password: string; notes: string; }
interface EntryFormState { title: string; username: string; password: string; url: string; notes: string; }
const emptyForm: EntryFormState = { title: "", username: "", password: "", url: "", notes: "" };

interface AppSettings {
  minimize_to_tray: boolean;
  notifications_enabled: boolean;
  auto_lock_minutes: number;
  daily_sync_enabled: boolean;
  daily_sync_time: string;
}
interface GoogleSession { email: string; local_id: string; }
interface SyncStatus { local_dirty: number; remote_changed: boolean; needs_sync: boolean; last_sync_at: number; last_sync_ok: boolean; }
interface VaultKeyDebugInfo { local_salt_prefix: string | null; cloud_salt_prefix: string | null; salts_match: boolean; google_email: string | null; }
interface SyncProgressEvent { phase: string; done: number; total: number; message: string; }

type Screen = "loading" | "create-pin" | "confirm-pin" | "enter-pin" | "vault";
type Tab = "home" | "favorites" | "categories" | "settings";
type Panel = "list" | "detail" | "add" | "edit";
type Msg = { text: string; kind: "ok" | "err" } | null;

const Icon = {
  logo: () => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="mlg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3b82f6" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient></defs>
      <path d="M4 4h4l8 12V4h4v16h-4L8 8v12H4z" fill="url(#mlg)" /></svg>
  ),
  search: () => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>),
  lock: () => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>),
  plus: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>),
  back: () => (<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>),
  copy: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>),
  eye: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>),
  external: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" /></svg>),
  star: (filled: boolean) => (<svg width="17" height="17" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="M12 2l3.1 6.6 7.2.9-5.3 5 1.5 7.2L12 18l-6.5 3.7L7 14.5l-5.3-5 7.2-.9z" /></svg>),
  trash: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" /></svg>),
  edit: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>),
  home: () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>),
  grid: () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>),
  gear: () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z" /></svg>),
};

function timeAgo(unix: number): string {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function favicon(url: string): string | null {
  try { return url ? `https://www.google.com/s2/favicons?domain=${new URL(url.startsWith("http") ? url : `https://${url}`).hostname}&sz=64` : null; } catch { return null; }
}

export default function MobileApp() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [pin, setPin] = useState("");
  const [firstPin, setFirstPin] = useState("");
  const [pinError, setPinError] = useState("");

  const [tab, setTab] = useState<Tab>("home");
  const [panel, setPanel] = useState<Panel>("list");
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<EntryFull | null>(null);
  const [form, setForm] = useState<EntryFormState>(emptyForm);
  const [showPw, setShowPw] = useState(false);
  const [entriesError, setEntriesError] = useState("");

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [googleSession, setGoogleSession] = useState<GoogleSession | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgressEvent | null>(null);
  const [debugInfo, setDebugInfo] = useState<VaultKeyDebugInfo | null>(null);
  const [keyMismatch, setKeyMismatch] = useState(false);
  const [reconcilePin, setReconcilePin] = useState("");
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileError, setReconcileError] = useState("");
  const [exportPw, setExportPw] = useState("");
  const [confirm, setConfirm] = useState<{ msg: string; onYes: () => void } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const msgTimer = useRef<number | null>(null);

  function toast(text: string, kind: "ok" | "err" = "ok") {
    setMsg({ text, kind });
    if (msgTimer.current) window.clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setMsg(null), 3200);
  }

  useEffect(() => {
    invoke<boolean>("vault_exists").then((exists) => setScreen(exists ? "enter-pin" : "create-pin")).catch(() => setScreen("create-pin"));
    invoke<GoogleSession | null>("google_session_status").then(setGoogleSession).catch(() => {});
    invoke<AppSettings>("get_settings").then(setSettings).catch(() => {});
    const un = listen<SyncProgressEvent>("sync-progress", (e) => setSyncProgress(e.payload));
    return () => { un.then((f) => f()); };
  }, []);

  function loadAll() {
    invoke<EntrySummary[]>("list_entries").then(setEntries).catch((e) => setEntriesError(String(e)));
  }

  async function doSync(silent = false) {
    if (syncing) return;
    setSyncing(true);
    try {
      const s = await invoke<{ pushed: number; pulled: number }>("sync_now");
      if (!silent || s.pushed || s.pulled) toast(s.pushed || s.pulled ? `Synced (+${s.pushed}/${s.pulled})` : "Already up to date");
      loadAll();
      invoke<SyncStatus>("check_sync_status").then(setSyncStatus).catch(() => {});
    } catch (e) {
      const m = String(e);
      if (m.includes("VAULT_KEY_MISMATCH")) setKeyMismatch(true);
      else toast("Sync failed: " + m, "err");
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (screen !== "vault" || !googleSession) return;
    invoke<string>("check_cloud_vault_key")
      .then((st) => { if (st === "mismatch") setKeyMismatch(true); else doSync(true); })
      .catch(() => {});
    invoke<SyncStatus>("check_sync_status").then(setSyncStatus).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, googleSession]);

  useEffect(() => { if (screen === "vault") loadAll(); }, [screen]);

  async function submitPin() {
    setPinError("");
    if (pin.length < 4) { setPinError("PIN must be at least 4 digits"); return; }
    try {
      if (screen === "create-pin") { setFirstPin(pin); setPin(""); setScreen("confirm-pin"); return; }
      if (screen === "confirm-pin") {
        if (pin !== firstPin) { setPinError("PINs don't match"); setPin(""); setFirstPin(""); setScreen("create-pin"); return; }
        await invoke("setup_pin", { pin });
        setScreen("vault"); setPin("");
        return;
      }
      const ok = await invoke<boolean>("unlock_with_pin", { pin });
      if (ok) { setScreen("vault"); setPin(""); } else { setPinError("Wrong PIN"); setPin(""); }
    } catch (e) { setPinError(String(e)); setPin(""); }
  }

  async function openEntry(id: string) {
    try {
      const e = await invoke<EntryFull>("get_entry", { id });
      setSelected(e); setShowPw(false); setPanel("detail");
    } catch (e) { toast(String(e), "err"); }
  }

  function startAdd() { setForm(emptyForm); setPanel("add"); }
  function startEdit() {
    if (!selected) return;
    setForm({ title: selected.title, username: selected.username, password: selected.password, url: selected.url, notes: selected.notes });
    setPanel("edit");
  }

  async function saveForm() {
    if (!form.title.trim()) { toast("Title can't be empty", "err"); return; }
    try {
      if (panel === "edit" && selected) {
        await invoke("update_entry", { id: selected.id, input: form });
        toast("Credential updated");
        loadAll(); await openEntry(selected.id);
      } else {
        const id = await invoke<string>("add_entry", { input: form });
        toast("Credential saved");
        loadAll(); await openEntry(id);
      }
    } catch (e) { toast("Save failed: " + String(e), "err"); }
  }

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); toast(`${label} copied`); } catch { toast("Copy failed", "err"); }
  }

  async function toggleFav(id: string) {
    try {
      const v = await invoke<boolean>("toggle_favorite", { id });
      setEntries((p) => p.map((x) => (x.id === id ? { ...x, favorite: v } : x)));
      if (selected?.id === id) setSelected({ ...selected, favorite: v });
    } catch (e) { toast(String(e), "err"); }
  }

  function trashSelected() {
    if (!selected) return;
    setConfirm({
      msg: "Move this credential to Trash?",
      onYes: async () => {
        try { await invoke("soft_delete_entry", { id: selected.id }); toast("Moved to Trash"); setSelected(null); setPanel("list"); loadAll(); }
        catch (e) { toast(String(e), "err"); }
        setConfirm(null);
      },
    });
  }

  async function saveSettings(patch: Partial<AppSettings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try { await invoke("save_settings", { settings: next }); } catch (e) { toast(String(e), "err"); }
  }

  async function handleSignIn() {
    setSigningIn(true);
    try {
      const s = await invoke<GoogleSession>("google_sign_in");
      setGoogleSession(s);
      const st = await invoke<string>("check_cloud_vault_key");
      if (st === "mismatch") setKeyMismatch(true); else doSync(true);
    } catch (e) { toast(String(e), "err"); } finally { setSigningIn(false); }
  }

  async function reconcile() {
    if (reconcilePin.length < 4) { setReconcileError("Enter that device's PIN"); return; }
    setReconcileBusy(true); setReconcileError("");
    try {
      await invoke("adopt_cloud_vault_key", { pin: reconcilePin });
      setKeyMismatch(false); setReconcilePin("");
      toast("Vault key synced — pulling data…");
      await doSync(false);
    } catch (e) { setReconcileError(String(e)); } finally { setReconcileBusy(false); }
  }

  function logout() {
    setConfirm({
      msg: "Log out? This removes all local data from this device.",
      onYes: async () => {
        await invoke("logout_and_wipe").catch(() => {});
        setEntries([]); setGoogleSession(null); setSelected(null); setPanel("list"); setTab("home");
        setScreen("create-pin");
        setConfirm(null);
      },
    });
  }

  function deleteAccount() {
    setConfirm({
      msg: "Delete account? This permanently wipes cloud data AND this device's local vault. Cannot be undone.",
      onYes: async () => {
        try { await invoke("delete_account"); toast("Account deleted"); } catch (e) { toast(String(e), "err"); }
        setEntries([]); setGoogleSession(null); setScreen("create-pin");
        setConfirm(null);
      },
    });
  }

  // ---------- render ----------
  if (screen === "loading") return <div className="m-shell m-center"><Icon.logo /></div>;

  if (screen === "create-pin" || screen === "confirm-pin" || screen === "enter-pin") {
    const title = screen === "create-pin" ? "Set a PIN" : screen === "confirm-pin" ? "Confirm PIN" : "Enter PIN";
    return (
      <div className="m-shell m-center">
        <div className="m-pin-card">
          <Icon.logo />
          <h1>NexPass</h1>
          <p className="m-sub">{title}</p>
          <input
            className="m-pin-input" type="password" inputMode="numeric" autoFocus
            value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setPinError(""); }}
            onKeyDown={(e) => e.key === "Enter" && submitPin()}
            placeholder="••••"
          />
          {pinError && <p className="m-error">{pinError}</p>}
          <button className="m-primary-btn" onClick={submitPin}>Continue</button>
        </div>
      </div>
    );
  }

  const filtered = entries
    .filter((e) => (tab === "favorites" ? e.favorite : true))
    .filter((e) => !search || e.title.toLowerCase().includes(search.toLowerCase()) || e.username.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="m-shell">
      {msg && <div className={`m-toast m-toast-${msg.kind}`}>{msg.text}</div>}

      {confirm && (
        <div className="m-overlay" onClick={() => setConfirm(null)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            <p>{confirm.msg}</p>
            <div className="m-row-gap">
              <button className="m-btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="m-btn m-danger" onClick={confirm.onYes}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {keyMismatch && (
        <div className="m-overlay">
          <div className="m-sheet">
            <p>This account's vault uses a different PIN on another device. Enter that device's PIN to sync.</p>
            <input className="m-text-input" type="password" inputMode="numeric" placeholder="That device's PIN"
              value={reconcilePin} onChange={(e) => { setReconcilePin(e.target.value.replace(/\D/g, "")); setReconcileError(""); }} />
            {reconcileError && <p className="m-error">{reconcileError}</p>}
            <div className="m-row-gap">
              <button className="m-btn" onClick={() => { setKeyMismatch(false); setReconcilePin(""); }}>Cancel</button>
              <button className="m-btn m-primary" disabled={reconcileBusy} onClick={reconcile}>{reconcileBusy ? "…" : "Sync"}</button>
            </div>
          </div>
        </div>
      )}

      {(tab === "home" || tab === "favorites") && panel === "list" && (
        <div className="m-page">
          <div className="m-header">
            <Icon.logo /><span className="m-title">NexPass</span>
            <button className="m-icon-btn" onClick={() => invoke("lock_vault").then(() => setScreen("enter-pin"))}><Icon.lock /></button>
          </div>
          <div className="m-searchbar">
            <Icon.search />
            <input placeholder="Search credentials…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="m-toolbar">
            <span className="m-list-title">{tab === "favorites" ? "Favorites" : "All Items"}</span>
            <button className="m-new-btn" onClick={startAdd}><Icon.plus />New Item</button>
          </div>
          {entriesError && <p className="m-error">{entriesError}</p>}
          <div className="m-list">
            {filtered.length === 0 && <p className="m-empty">No entries yet — add your first one.</p>}
            {filtered.map((e) => {
              const fav = favicon(e.url);
              return (
                <button key={e.id} className="m-card" onClick={() => openEntry(e.id)}>
                  <span className="m-avatar">{fav ? <img src={fav} alt="" /> : e.title.slice(0, 1).toUpperCase()}</span>
                  <span className="m-card-text">
                    <span className="m-card-title">{e.title}</span>
                    <span className="m-card-sub">{e.username || e.url || "—"}</span>
                  </span>
                  <span className="m-card-time">{timeAgo(e.updated_at)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {panel === "detail" && selected && (
        <div className="m-page">
          <div className="m-header">
            <button className="m-icon-btn" onClick={() => { setPanel("list"); setSelected(null); }}><Icon.back /></button>
            <span className="m-title">{selected.title}</span>
            <button className="m-icon-btn" onClick={() => toggleFav(selected.id)}>{Icon.star(selected.favorite)}</button>
          </div>
          <div className="m-detail">
            <div className="m-detail-icon">
              {favicon(selected.url) ? <img src={favicon(selected.url)!} alt="" /> : selected.title.slice(0, 1).toUpperCase()}
            </div>
            <div className="m-actions-row">
              <button className="m-btn" onClick={startEdit}><Icon.edit />Edit</button>
              <button className="m-btn m-danger" onClick={trashSelected}><Icon.trash />Trash</button>
            </div>
            {selected.username && (
              <div className="m-field"><label>Username / Email</label>
                <div className="m-field-row"><span>{selected.username}</span><button onClick={() => copy(selected.username, "Username")}><Icon.copy /></button></div>
              </div>
            )}
            {selected.password && (
              <div className="m-field"><label>Password</label>
                <div className="m-field-row">
                  <span>{showPw ? selected.password : "•".repeat(Math.min(selected.password.length, 16))}</span>
                  <button onClick={() => setShowPw((v) => !v)}><Icon.eye /></button>
                  <button onClick={() => copy(selected.password, "Password")}><Icon.copy /></button>
                </div>
              </div>
            )}
            {selected.url && (
              <div className="m-field"><label>Website</label>
                <div className="m-field-row">
                  <a href={selected.url.startsWith("http") ? selected.url : `https://${selected.url}`} target="_blank" rel="noreferrer">{selected.url}</a>
                  <Icon.external />
                </div>
              </div>
            )}
            {selected.notes && (
              <div className="m-field"><label>Notes</label><div className="m-field-row m-notes"><span>{selected.notes}</span></div></div>
            )}
          </div>
        </div>
      )}

      {(panel === "add" || panel === "edit") && (
        <div className="m-page">
          <div className="m-header">
            <button className="m-icon-btn" onClick={() => setPanel(selected ? "detail" : "list")}><Icon.back /></button>
            <span className="m-title">{panel === "edit" ? "Edit item" : "New item"}</span>
            <span style={{ width: 34 }} />
          </div>
          <div className="m-form">
            <label>Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Gmail" autoFocus /></label>
            <label>Username / Email<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
            <label>Password<input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
            <label>Website<input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="example.com" /></label>
            <label>Notes<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} /></label>
            <button className="m-primary-btn" onClick={saveForm}>Save</button>
          </div>
        </div>
      )}

      {tab === "categories" && (
        <div className="m-page m-center">
          <Icon.grid />
          <h2>Categories</h2>
          <p className="m-sub">Coming soon</p>
        </div>
      )}

      {tab === "settings" && (
        <div className="m-page">
          <div className="m-header"><span className="m-title">Settings</span></div>
          <div className="m-settings">
            <h3>General</h3>
            <div className="m-set-row">
              <span>Auto-lock</span>
              <select value={settings?.auto_lock_minutes ?? 5} onChange={(e) => saveSettings({ auto_lock_minutes: Number(e.target.value) })}>
                <option value={0}>Instant</option>
                <option value={5}>5 min</option>
                <option value={10}>10 min</option>
                <option value={15}>15 min</option>
              </select>
            </div>
            <div className="m-set-row">
              <span>Notifications</span>
              <label className="m-switch"><input type="checkbox" checked={settings?.notifications_enabled ?? true} onChange={(e) => saveSettings({ notifications_enabled: e.target.checked })} /><span /></label>
            </div>
            <div className="m-set-row">
              <span>Linked account</span>
              {googleSession ? <span className="m-muted">{googleSession.email}</span> : <button className="m-btn m-primary" disabled={signingIn} onClick={handleSignIn}>{signingIn ? "…" : "Sign in with Google"}</button>}
            </div>
            <div className="m-set-row">
              <span>Manual sync</span>
              <button className="m-btn" disabled={syncing} onClick={() => doSync(false)}>{syncing ? "Syncing…" : "Sync now"}</button>
            </div>
            {syncing && syncProgress && syncProgress.total > 0 && (
              <p className="m-sub">{syncProgress.message} ({syncProgress.done}/{syncProgress.total})</p>
            )}
            <div className="m-set-row">
              <span>Daily sync</span>
              <label className="m-switch"><input type="checkbox" checked={settings?.daily_sync_enabled ?? false} onChange={(e) => saveSettings({ daily_sync_enabled: e.target.checked })} /><span /></label>
            </div>
            {settings?.daily_sync_enabled && (
              <div className="m-set-row">
                <span>Sync time</span>
                <input className="m-time-input" type="time" value={settings?.daily_sync_time ?? "09:00"} onChange={(e) => saveSettings({ daily_sync_time: e.target.value })} />
              </div>
            )}
            <div className="m-set-row"><span>Last sync</span><span className="m-muted">{syncStatus && syncStatus.last_sync_at > 0 ? new Date(syncStatus.last_sync_at * 1000).toLocaleString() : "Never"}</span></div>
            <div className="m-set-row"><span>Sync status</span><span className={syncStatus?.last_sync_ok === false ? "m-error" : "m-muted"}>{syncStatus ? (syncStatus.last_sync_ok ? "OK" : "Failed") : "—"}</span></div>

            <h3>Account</h3>
            <div className="m-set-row"><span>Log out</span><button className="m-btn" onClick={logout}>Log out</button></div>
            <div className="m-set-block">
              <span>Vault key diagnostic</span>
              <button className="m-btn" onClick={async () => { try { setDebugInfo(await invoke<VaultKeyDebugInfo>("debug_vault_key_info")); } catch (e) { toast(String(e), "err"); } }}>Check vault key</button>
              {debugInfo && (
                <p className="m-mono">Account: {debugInfo.google_email ?? "—"}<br />Local: {debugInfo.local_salt_prefix ?? "none"}<br />Cloud: {debugInfo.cloud_salt_prefix ?? "none"}<br />
                  <strong className={debugInfo.salts_match ? "m-ok" : "m-error"}>{debugInfo.salts_match ? "MATCH" : "MISMATCH"}</strong></p>
              )}
            </div>
            <div className="m-set-row">
              <span>Backup / Restore</span>
              <div className="m-row-gap">
                <button className="m-btn" onClick={async () => { try { const n = await invoke<number>("backup_to_cloud"); toast(`Backed up ${n}`); } catch (e) { toast(String(e), "err"); } }}>Backup</button>
                <button className="m-btn" onClick={async () => { try { const n = await invoke<number>("restore_from_cloud"); toast(`Restored ${n}`); loadAll(); } catch (e) { toast(String(e), "err"); } }}>Restore</button>
              </div>
            </div>
            <div className="m-set-block">
              <span>Export credentials</span>
              <div className="m-row-gap">
                <input className="m-text-input" type="password" placeholder="Export password (min 6 chars)" value={exportPw} onChange={(e) => setExportPw(e.target.value)} />
                <button className="m-btn" onClick={async () => {
                  if (exportPw.length < 6) { toast("Min 6 characters", "err"); return; }
                  try { await invoke("export_vault", { password: exportPw }); toast("Exported"); setExportPw(""); } catch (e) { toast(String(e), "err"); }
                }}>Export</button>
              </div>
            </div>
            <div className="m-set-row"><span>Delete account</span><button className="m-btn m-danger" onClick={deleteAccount}>Delete account</button></div>

            <h3>About</h3>
            <div className="m-set-row"><span>App Name</span><span className="m-muted">NexPass</span></div>
            <div className="m-set-row"><span>Version</span><span className="m-muted">v5.0.1</span></div>
            <div className="m-set-row"><span>App ID</span><span className="m-muted">068691</span></div>
            <div className="m-set-row"><span>Author</span><a className="m-link" href="https://nexappog.vercel.app/" target="_blank" rel="noreferrer">NexApp</a></div>
            <div className="m-set-row"><span>Developer</span><a className="m-link" href="https://arabiislam.odoo.com/" target="_blank" rel="noreferrer">Arabi Islam × MR. ARX</a></div>
          </div>
        </div>
      )}

      {panel === "list" && (
        <nav className="m-island">
          <button className={tab === "home" ? "active" : ""} onClick={() => { setTab("home"); setPanel("list"); }}><Icon.home /><span>Home</span></button>
          <button className={tab === "favorites" ? "active" : ""} onClick={() => { setTab("favorites"); setPanel("list"); }}>{Icon.star(tab === "favorites")}<span>Favorites</span></button>
          <button className={tab === "categories" ? "active" : ""} onClick={() => setTab("categories")}><Icon.grid /><span>Categories</span></button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Icon.gear /><span>Settings</span></button>
        </nav>
      )}
    </div>
  );
}
