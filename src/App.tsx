import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { authenticate as biometricAuthenticate, checkStatus as biometricCheckStatus } from "@tauri-apps/plugin-biometric";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save as saveFileDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";

const BACK_EXIT_WINDOW_MS = 2000;

// Turns raw backend/network error strings into something a non-technical
// person won't be alarmed by. Anything that looks like a connectivity
// problem becomes one friendly line; anything else long/technical gets
// trimmed instead of dumped verbatim on screen.
function friendlyError(raw: string): string {
  const s = raw.toLowerCase();
  if (
    s.includes("network error") ||
    s.includes("error sending request") ||
    s.includes("dns error") ||
    s.includes("connection") ||
    s.includes("timed out") ||
    s.includes("gave up after") ||
    s.includes("no internet")
  ) {
    return "Couldn't reach the server — check your internet connection and try again.";
  }
  if (s.includes("error decoding response body") || s.includes("invalid type") || s.includes("missing field")) {
    return "The update/release info couldn't be read — it may be temporarily misformatted. Try again later.";
  }
  if (raw.length > 140) {
    return "Something went wrong. Please try again.";
  }
  return raw;
}

const APP_NAME = "NexPass";
const APP_VERSION = "6.0.1";
const APP_ID = "068691";
const APP_AUTHOR = "NexApp";
const APP_AUTHOR_URL = "https://nexappog.vercel.app/";
const APP_DEVELOPERS = "Arabi Islam × MR. ARX";
const APP_DEVELOPER_URL = "https://arabiislam.odoo.com/";
const LOGO_SRC = "/assets/icon.png";
const PIN_LENGTH = 6;
const CLIPBOARD_CLEAR_MS = 15000;
const DAILY_SYNC_KEY = "nexpass.dailySync";
const UPDATE_CHECK_KEY = "nexpass.lastUpdateCheck";
const UPDATE_DISMISS_KEY = "nexpass.dismissedUpdateVersion";
const UPDATE_APPLIED_KEY = "nexpass.lastUpdateApplied";
const UPDATE_FREQUENCY_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

type Screen = "loading" | "create-pin" | "confirm-pin" | "enter-pin" | "vault";
type PanelMode = "none" | "view" | "edit" | "add" | "profile" | "pick-category";
type MainTab = "home" | "favorites" | "categories" | "settings";
type SettingsScreen = "menu" | "general" | "account" | "about" | "trash" | "updates";
type SortMode = "recent" | "name";

interface GoogleSession {
  email: string;
  local_id: string;
  display_name: string | null;
  photo_url: string | null;
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
  category: string;
}

interface EntryFull extends EntrySummary {
  password: string;
  notes: string;
  fields_json: string | null;
}

interface EntryFormState {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  category: string;
}

interface ReleaseNote {
  version: string;
  date: string;
  notes: string;
}

interface Profile {
  name: string | null;
  bio: string | null;
  avatar_path: string | null;
}

interface DailySyncPref {
  enabled: boolean;
  time: string; // "HH:MM"
}

interface UpdateInfo {
  current_version: string;
  version: string;
  changelog: string;
  download_url: string;
}

interface DownloadProgressEvent {
  downloaded: number;
  total: number;
  phase: "downloading" | "done" | "error";
  message: string;
}

interface DownloadedUpdateInfo {
  version: string;
  size_bytes: number;
  downloaded_at: number; // unix seconds
  path: string;
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

const CATEGORIES: { id: string; label: string }[] = [
  { id: "login", label: "Login" },
  { id: "card", label: "Card (Visa/Master)" },
  { id: "mobile_banking", label: "Mobile Banking (Bkash/Nagad/PayPal/Roket)" },
  { id: "api_key", label: "API Keys" },
  { id: "keystore", label: "Keystore" },
  { id: "oauth_client", label: "OAuth Client" },
  { id: "zip", label: "Zip" },
  { id: "backup_codes", label: "Backup Codes" },
];
function categoryLabel(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? "Login";
}

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "select" | "textarea" | "date";
  sensitive?: boolean;
  options?: string[];
}

// Login isn't listed here — it keeps using the classic username/password/
// url/notes columns. Every other category's fields live in the encrypted
// fields_json blob, rendered generically from this schema.
const CATEGORY_FIELD_SCHEMAS: Record<string, FieldDef[]> = {
  card: [
    { key: "cardholder_name", label: "Cardholder Name", type: "text" },
    { key: "card_number", label: "Card Number / PAN", type: "password", sensitive: true },
    { key: "expiry_date", label: "Expiry Date (MM/YY)", type: "text" },
    { key: "cvv", label: "CVV / CVC", type: "password", sensitive: true },
    { key: "card_type", label: "Card Type", type: "select", options: ["Visa", "Mastercard", "American Express", "Discover", "Other"] },
    { key: "card_tier", label: "Card Tier", type: "text" },
    { key: "bank", label: "Bank", type: "text" },
    { key: "currency", label: "Currency", type: "text" },
    { key: "billing_country", label: "Billing Country", type: "text" },
  ],
  mobile_banking: [
    { key: "provider", label: "Provider", type: "select", options: ["bKash", "Nagad", "PayPal", "Rocket", "Other"] },
    { key: "account_number", label: "Account / Wallet Number", type: "text" },
    { key: "account_holder_name", label: "Account Holder Name", type: "text" },
    { key: "account_type", label: "Account Type", type: "select", options: ["Personal", "Merchant"] },
    { key: "country", label: "Country", type: "text" },
    { key: "currency", label: "Currency", type: "text" },
    { key: "account_status", label: "Account Status", type: "select", options: ["Active", "Inactive", "Suspended"] },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
  api_key: [
    { key: "name", label: "Name", type: "text" },
    { key: "provider", label: "Provider", type: "text" },
    { key: "environment", label: "Environment", type: "select", options: ["Development", "Staging", "Production"] },
    { key: "api_key", label: "API Key", type: "password", sensitive: true },
    { key: "base_url", label: "Base URL", type: "text" },
    { key: "expires", label: "Expires", type: "date" },
    { key: "tags", label: "Tags", type: "text" },
  ],
  keystore: [
    { key: "alias", label: "Alias", type: "text" },
    { key: "password", label: "Password", type: "password", sensitive: true },
    { key: "package_id", label: "Package ID", type: "text" },
    { key: "first_name", label: "First Name", type: "text" },
    { key: "last_name", label: "Last Name", type: "text" },
    { key: "organizational_unit", label: "Organizational Unit", type: "text" },
    { key: "organization", label: "Organization", type: "text" },
    { key: "city", label: "City", type: "text" },
    { key: "province", label: "Province", type: "text" },
    { key: "country", label: "Country", type: "text" },
  ],
  oauth_client: [
    { key: "client_name", label: "Client Name", type: "text" },
    { key: "provider", label: "Provider", type: "text" },
    { key: "client_id", label: "Client ID", type: "text" },
    { key: "client_secret", label: "Client Secret", type: "password", sensitive: true },
    { key: "client_type", label: "Client Type", type: "select", options: ["Confidential", "Public"] },
    { key: "environment", label: "Environment", type: "select", options: ["Development", "Staging", "Production"] },
  ],
  zip: [
    { key: "zip_name", label: "Zip Name", type: "text" },
    { key: "password", label: "Password", type: "password", sensitive: true },
    { key: "device", label: "Device", type: "text" },
    { key: "path", label: "Path", type: "text" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
  backup_codes: [
    { key: "name", label: "Name", type: "text" },
    { key: "provider", label: "Provider", type: "text" },
    { key: "account", label: "Account", type: "text" },
    { key: "generated_date", label: "Generated Date", type: "date" },
    // "codes" is handled by a dedicated widget, not this generic renderer.
  ],
};

interface BackupCode {
  code: string;
  used: boolean;
}

function parseFieldsJson(raw: string | null): { fields: Record<string, string>; codes: BackupCode[] } {
  if (!raw) return { fields: {}, codes: [] };
  try {
    const parsed = JSON.parse(raw);
    const codes: BackupCode[] = Array.isArray(parsed.codes) ? parsed.codes : [];
    const fields: Record<string, string> = { ...parsed };
    delete fields.codes;
    return { fields, codes };
  } catch {
    return { fields: {}, codes: [] };
  }
}

function buildFieldsJson(fields: Record<string, string>, codes: BackupCode[]): string | null {
  const hasFields = Object.values(fields).some((v) => v && v.trim() !== "");
  const hasCodes = codes.length > 0;
  if (!hasFields && !hasCodes) return null;
  return JSON.stringify({ ...fields, ...(hasCodes ? { codes } : {}) });
}

const emptyForm: EntryFormState = { title: "", username: "", password: "", url: "", notes: "", category: "login" };

function loadDailySyncPref(): DailySyncPref {
  try {
    const raw = localStorage.getItem(DAILY_SYNC_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { enabled: false, time: "09:00" };
}

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

function normalizedUrl(url: string): string {
  if (!url.trim()) return "";
  return url.startsWith("http") ? url : `https://${url}`;
}

function timeAgo(unixSeconds: number): string {
  if (!unixSeconds) return "Never";
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function formatDateTime(unixSeconds: number): string {
  if (!unixSeconds) return "Never";
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  lock: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  ),
  chevron: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ),
  copy: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  edit: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  trash: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  plus: () => (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  star: ({ filled }: { filled?: boolean }) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  home: ({ filled }: { filled?: boolean }) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11.5L12 4l9 7.5" />
      <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
    </svg>
  ),
  grid: () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  clock: () => (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
    </svg>
  ),
  shield: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  external: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  undo: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  ),
  gear: ({ filled }: { filled?: boolean }) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={filled ? 0 : 2} fillOpacity={filled ? 1 : 0}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" fill={filled ? "currentColor" : "none"} />
      <path stroke="currentColor" strokeWidth="2" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  close: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
  bell: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  link: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  key: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  ),
  user: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
  info: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="11" /><circle cx="12" cy="7.5" r="0.5" fill="currentColor" />
    </svg>
  ),
  fingerprint: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 2a7 7 0 0 0-7 7c0 3.5 1.5 6 2 8" />
      <path d="M12 4a5 5 0 0 0-5 5c0 3.5 1.5 6.5 2.5 9" />
      <path d="M12 6a3 3 0 0 0-3 3c0 4 2 7 3 10" />
      <path d="M15 9a3 3 0 0 0-3-3" /><path d="M17 9c0 5-2 8-3 12" /><path d="M19 8a7 7 0 0 0-1.5-4.5" />
    </svg>
  ),
  logout: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
};

function App() {
  // Desktop targets (Windows/macOS/Linux) get the wide three-column
  // layout (sidebar + list + detail pane); Android's system WebView UA
  // always contains "Android", so this is a reliable, dependency-free
  // way to tell the two apart without touching the Rust side.
  const isDesktop = useMemo(() => !/Android/i.test(navigator.userAgent), []);

  const [screen, setScreen] = useState<Screen>("loading");
  const [pin, setPin] = useState("");
  const [firstPin, setFirstPin] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);

  const [googleSession, setGoogleSession] = useState<GoogleSession | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncProgressEvent | null>(null);
  const [syncStatusInfo, setSyncStatusInfo] = useState<SyncStatus | null>(null);
  const [keyMismatch, setKeyMismatch] = useState(false);
  const [reconcilePin, setReconcilePin] = useState("");
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileError, setReconcileError] = useState("");
  const [debugInfo, setDebugInfo] = useState<VaultKeyDebugInfo | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [dailySync, setDailySync] = useState<DailySyncPref>(loadDailySyncPref);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStage, setUpdateStage] = useState<"idle" | "downloading" | "downloaded" | "installing">("idle");
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressEvent | null>(null);
  const [downloadedApk, setDownloadedApk] = useState<DownloadedUpdateInfo | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [deleteApkBusy, setDeleteApkBusy] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [showRestartPrompt, setShowRestartPrompt] = useState(false);
  const [profile, setProfile] = useState<Profile>({ name: null, bio: null, avatar_path: null });
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [profileBioDraft, setProfileBioDraft] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNote[] | null>(null);
  const [releaseNotesBusy, setReleaseNotesBusy] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);

  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [trashEntries, setTrashEntries] = useState<EntrySummary[]>([]);
  const [entriesError, setEntriesError] = useState("");
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");

  const [mainTab, setMainTab] = useState<MainTab>("home");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [settingsScreen, setSettingsScreen] = useState<SettingsScreen>("menu");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<EntryFull | null>(null);
  const [viewingTrash, setViewingTrash] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("none");
  const [form, setForm] = useState<EntryFormState>(emptyForm);
  const [formFields, setFormFields] = useState<Record<string, string>>({});
  const [formCodes, setFormCodes] = useState<BackupCode[]>([]);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [sensitiveRevealed, setSensitiveRevealed] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [brokenIcons, setBrokenIcons] = useState<Set<string>>(new Set());
  function markIconBroken(url: string) {
    setBrokenIcons((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
  }
  const searchRef = useRef<HTMLInputElement>(null);

  const [appSettings, setAppSettings] = useState({ minimize_to_tray: true, notifications_enabled: true, auto_lock_minutes: 5, biometric_enabled: false, update_check_frequency: "weekly" });
  const [biometricSetupPin, setBiometricSetupPin] = useState("");
  const [biometricSetupOpen, setBiometricSetupOpen] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const biometricTriedRef = useRef(false);
  const lastBackPressRef = useRef(0);
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
    // Fetched here (not gated behind screen === "vault") because the
    // biometric-unlock prompt needs to know biometric_enabled *before*
    // the vault is unlocked, i.e. while still on the enter-pin screen.
    invoke<typeof appSettings>("get_settings").then(setAppSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (screen !== "vault") return;
    invoke<GoogleSession | null>("google_session_status").then(setGoogleSession).catch(() => {});
    invoke<typeof appSettings>("get_settings").then(setAppSettings).catch(() => {});
    invoke<Profile>("get_profile").then(setProfile).catch(() => {});
    loadAll();
    maybeCheckForUpdate();
    // Restores the Install/Delete controls if an update APK is already
    // sitting on disk from a previous session (e.g. downloaded, then the
    // app was closed before installing).
    invoke<DownloadedUpdateInfo | null>("get_downloaded_update_info").then(setDownloadedApk).catch(() => {});
  }, [screen]);

  useEffect(() => {
    const unlistenPromise = listen<DownloadProgressEvent>("update-download-progress", (event) => {
      setDownloadProgress(event.payload);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

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

  useEffect(() => {
    if (screen !== "vault" || !googleSession) return;
    let cancelled = false;
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
            setSyncStatusInfo(s);
            if (s.needs_sync) {
              handleSyncNow(true);
            } else if (!s.last_sync_ok && s.last_sync_at > 0) {
              showToast("Last sync didn't finish — will retry in background", "info");
              handleSyncNow(true);
            }
          })
          .catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, googleSession]);

  // Refresh the sync status snapshot whenever the General settings screen
  // is opened, so "Last Sync" / "Sync Status" reflect reality without
  // needing a manual sync first.
  useEffect(() => {
    if (mainTab === "settings" && settingsScreen === "general" && googleSession) {
      invoke<SyncStatus>("check_sync_status").then(setSyncStatusInfo).catch(() => {});
    }
  }, [mainTab, settingsScreen, googleSession]);

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
      try {
        const status = await invoke<string>("check_cloud_vault_key");
        if (status === "mismatch") {
          setKeyMismatch(true);
        }
      } catch {
        /* non-fatal */
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
    if (syncing) return;
    setSyncing(true);
    setSyncError("");
    try {
      const summary = await invoke<{ pushed: number; pulled: number; skipped: boolean }>("sync_now");
      const msg = `Pushed ${summary.pushed} · Pulled ${summary.pulled}`;
      if (!silent) {
        showToast(summary.pushed || summary.pulled ? `Synced — ${msg}` : "Already up to date", "success");
      } else if (summary.pushed || summary.pulled) {
        showToast(`Synced — ${msg}`, "success", 2000);
      }
      loadAll();
      invoke<SyncStatus>("check_sync_status").then(setSyncStatusInfo).catch(() => {});
    } catch (e) {
      const message = String(e);
      if (message.includes("VAULT_KEY_MISMATCH")) {
        setKeyMismatch(true);
      } else {
        setSyncError(message);
        // Background/auto syncs (silent=true) fail quietly and often —
        // e.g. simply because there's no internet right now. Only a sync
        // the user explicitly triggered should interrupt them with a toast.
        if (!silent) {
          showToast(friendlyError(message), "error", 4000);
        }
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

  // Checked once per app-open, throttled to at most once/day (there's no
  // true background service on Android without native work-manager code,
  // so "daily" here means "at most once per calendar day, whenever the
  // person actually opens the app" rather than a silent background push).
  // force=true (the manual "Check for updates" button) skips the
  // throttle and reports back either way, instead of failing silently —
  // useful both for real users and for testing a freshly-edited manifest.
  async function maybeCheckForUpdate(force = false) {
    if (!force) {
      const lastCheck = Number(localStorage.getItem(UPDATE_CHECK_KEY) || 0);
      const intervalMs = UPDATE_FREQUENCY_MS[appSettings.update_check_frequency] ?? UPDATE_FREQUENCY_MS.weekly;
      if (Date.now() - lastCheck < intervalMs) return;
    }
    localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));
    try {
      const info = await invoke<UpdateInfo | null>("check_for_update");
      if (!info) {
        if (force) showToast("You're on the latest version", "success");
        return;
      }
      const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY);
      if (dismissed === info.version && !force) return; // already said "later" for this exact version
      setUpdateInfo(info);
      // If this exact version's APK is already downloaded (e.g. from a
      // previous session), skip straight to offering Install instead of
      // making the user download it again.
      setUpdateStage(downloadedApk && downloadedApk.version === info.version ? "downloaded" : "idle");
      setDownloadProgress(null);
    } catch (e) {
      if (force) showToast(friendlyError(String(e)), "error", 4000);
      // Otherwise silent — an automatic background check failing (no
      // internet, manifest not reachable) shouldn't interrupt anyone.
    }
  }

  function dismissUpdate() {
    if (updateInfo) localStorage.setItem(UPDATE_DISMISS_KEY, updateInfo.version);
    setUpdateInfo(null);
    setUpdateStage("idle");
    setDownloadProgress(null);
  }

  function lastUpdateApplied(): { version: string; appliedAt: number } | null {
    try {
      const raw = localStorage.getItem(UPDATE_APPLIED_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function loadReleaseNotes() {
    setReleaseNotesOpen((v) => !v);
    if (releaseNotes || releaseNotesBusy) return;
    setReleaseNotesBusy(true);
    try {
      const notes = await invoke<ReleaseNote[]>("fetch_release_notes");
      setReleaseNotes(notes);
    } catch (e) {
      showToast(friendlyError(String(e)), "error");
    } finally {
      setReleaseNotesBusy(false);
    }
  }

  // Step 1: download the APK into the app's internal storage, reporting
  // progress via the "update-download-progress" event (see downloadProgress
  // state). Leaves the APK on disk and switches to the "downloaded" stage
  // instead of auto-installing — the person taps Install separately.
  async function handleDownloadUpdate() {
    if (!updateInfo) return;
    setUpdateBusy(true);
    setUpdateStage("downloading");
    setDownloadProgress(null);
    try {
      await invoke<string>("download_update", { url: updateInfo.download_url, version: updateInfo.version });
      const info = await invoke<DownloadedUpdateInfo | null>("get_downloaded_update_info");
      setDownloadedApk(info);
      setUpdateStage("downloaded");
    } catch (e) {
      showToast(friendlyError(String(e)), "error", 4000);
      setUpdateStage("idle");
    } finally {
      setUpdateBusy(false);
    }
  }

  // Step 2: hand the already-downloaded APK to Android's own package
  // installer (see installer.rs — this goes through a FileProvider
  // content:// URI, not a raw path, or the installer can't read a file
  // that lives in NexPass's own private storage). If NexPass doesn't yet
  // have permission to install from this source, Android's installer
  // screen itself asks for it (a Settings shortcut) — tapping Install
  // again afterwards completes it.
  async function handleInstallDownloadedApk() {
    if (!downloadedApk) return;
    setInstallBusy(true);
    setUpdateStage("installing");
    try {
      localStorage.setItem(UPDATE_APPLIED_KEY, JSON.stringify({ version: downloadedApk.version, appliedAt: Date.now() }));
      await invoke("install_update_apk", { path: downloadedApk.path });
      setUpdateInfo(null);
      setShowRestartPrompt(true);
    } catch (e) {
      showToast(friendlyError(String(e)), "error", 4000);
    } finally {
      setInstallBusy(false);
    }
  }

  // Lets the user reclaim storage from a downloaded-but-not-yet-installed
  // (or already-installed) update APK.
  async function handleDeleteDownloadedApk() {
    setDeleteApkBusy(true);
    try {
      const removed = await invoke<boolean>("delete_downloaded_update");
      if (removed) showToast("Update file deleted — storage freed", "success");
      setDownloadedApk(null);
      setUpdateStage((s) => (s === "downloaded" ? "idle" : s));
    } catch (e) {
      showToast(friendlyError(String(e)), "error");
    } finally {
      setDeleteApkBusy(false);
    }
  }

  // After the OS finishes installing the new APK, the running process is
  // normally the one being replaced — reopening cleanly is the reliable
  // way back in, which is what this triggers.
  async function handleRestartApp() {
    setRestartBusy(true);
    try {
      await relaunch();
    } catch (e) {
      showToast(friendlyError(String(e)), "error");
      setRestartBusy(false);
    }
  }

  async function selectEntry(id: string, fromTrash = false) {
    setSelectedId(id);
    setPasswordVisible(false);
    setSensitiveRevealed(false);
    setViewingTrash(fromTrash);
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
    setFormFields({});
    setFormCodes([]);
    setSelectedId(null);
    setSelectedEntry(null);
    setViewingTrash(false);
    setPanelMode("pick-category");
  }

  function pickCategoryAndAdd(categoryId: string) {
    setForm((f) => ({ ...f, category: categoryId }));
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
      category: selectedEntry.category,
    });
    const parsed = parseFieldsJson(selectedEntry.fields_json);
    setFormFields(parsed.fields);
    setFormCodes(parsed.codes);
    setPanelMode("edit");
  }

  function closePanel() {
    setSelectedId(null);
    setSelectedEntry(null);
    setPanelMode("none");
    setViewingTrash(false);
  }

  function cancelPanel() {
    setPanelMode(selectedEntry ? "view" : "none");
  }

  function openProfile() {
    if (!googleSession) {
      handleGoogleSignIn();
      return;
    }
    setProfileNameDraft(profile.name ?? googleSession.display_name ?? "");
    setProfileBioDraft(profile.bio ?? "");
    setPanelMode("profile");
  }

  function avatarSrc(): string | null {
    if (profile.avatar_path) return convertFileSrc(profile.avatar_path);
    if (googleSession?.photo_url) return googleSession.photo_url;
    return null;
  }

  async function saveProfile() {
    setProfileBusy(true);
    try {
      await invoke("save_profile", { name: profileNameDraft || null, bio: profileBioDraft || null });
      setProfile((p) => ({ ...p, name: profileNameDraft || null, bio: profileBioDraft || null }));
      showToast("Profile updated", "success");
      setPanelMode("none");
    } catch (e) {
      showToast(friendlyError(String(e)), "error");
    } finally {
      setProfileBusy(false);
    }
  }

  async function changeAvatar() {
    try {
      const path = await openFileDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (!path || typeof path !== "string") return;
      await invoke("set_profile_avatar", { path });
      setProfile((p) => ({ ...p, avatar_path: path }));
      showToast("Profile picture updated", "success");
    } catch (e) {
      showToast(friendlyError(String(e)), "error");
    }
  }

  async function removeAvatar() {
    try {
      await invoke("clear_profile_avatar");
      setProfile((p) => ({ ...p, avatar_path: null }));
    } catch (e) {
      showToast(friendlyError(String(e)), "error");
    }
  }

  async function saveForm() {
    if (!form.title.trim()) {
      setEntriesError("Title can't be empty.");
      showToast("Title can't be empty", "error");
      return;
    }
    const wasEdit = panelMode === "edit" && !!selectedId;
    const input = { ...form, fields_json: buildFieldsJson(formFields, formCodes) };
    try {
      if (wasEdit && selectedId) {
        await invoke("update_entry", { id: selectedId, input });
        loadAll();
        selectEntry(selectedId);
      } else {
        const id = await invoke<string>("add_entry", { input });
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
      closePanel();
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
      closePanel();
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
          closePanel();
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

  function openExternal(url: string) {
    const target = normalizedUrl(url);
    openUrl(target).catch(() => {
      // Fallback for desktop/dev contexts where the opener plugin might
      // not be wired up — still better than doing nothing.
      window.open(target, "_blank", "noopener,noreferrer");
    });
  }

  async function updateSetting(patch: Partial<typeof appSettings>) {
    const next = { ...appSettings, ...patch };
    setAppSettings(next);
    invoke("save_settings", { settings: next }).catch(() => {});
  }

  async function handleBiometricToggle(checked: boolean) {
    if (!checked) {
      await invoke("clear_biometric_pin").catch(() => {});
      setBiometricSetupOpen(false);
      setBiometricSetupPin("");
      updateSetting({ biometric_enabled: false });
      return;
    }
    setBiometricBusy(true);
    try {
      const status = await biometricCheckStatus();
      if (!status.isAvailable) {
        showToast("Set up fingerprint or face unlock in your phone's settings first", "error", 3500);
        return;
      }
      await biometricAuthenticate("Enable biometric unlock for NexPass");
      // We only get here after a *successful* prompt — now capture the PIN
      // once so future unlocks can skip straight to biometrics. See
      // biometric_store.rs for what this is (and isn't) protecting.
      setBiometricSetupOpen(true);
    } catch (e) {
      showToast("Biometric check didn't succeed — try again", "error");
    } finally {
      setBiometricBusy(false);
    }
  }

  async function confirmEnableBiometric() {
    if (biometricSetupPin.length < 4) {
      showToast("Enter your PIN to confirm", "error");
      return;
    }
    setBiometricBusy(true);
    try {
      await invoke("set_biometric_pin", { pin: biometricSetupPin });
      await updateSetting({ biometric_enabled: true });
      setBiometricSetupOpen(false);
      setBiometricSetupPin("");
      showToast("Biometric unlock enabled", "success");
    } catch (e) {
      showToast(friendlyError(String(e)), "error");
    } finally {
      setBiometricBusy(false);
    }
  }

  async function tryBiometricUnlock() {
    try {
      const status = await biometricCheckStatus();
      if (!status.isAvailable) return;
      await biometricAuthenticate("Unlock NexPass", { allowDeviceCredential: true, cancelTitle: "Use PIN instead" } as never);
      const storedPin = await invoke<string | null>("get_biometric_pin");
      if (!storedPin) return;
      const ok = await invoke<boolean>("unlock_with_pin", { pin: storedPin });
      if (ok) {
        setPin("");
        setScreen("vault");
      } else {
        // The stored PIN no longer matches the vault (e.g. it was reset
        // some other way) — don't keep prompting with a broken shortcut.
        await invoke("clear_biometric_pin").catch(() => {});
        updateSetting({ biometric_enabled: false });
        showToast("Biometric unlock needs to be re-enabled — please enter your PIN", "info", 3500);
      }
    } catch {
      // User cancelled, or the prompt failed — just stay on the PIN pad,
      // no error needed since "Use PIN instead" is an expected path.
    }
  }

  // Auto-prompt biometrics the moment the enter-pin screen shows up, but
  // only once per visit to that screen (not on every re-render).
  useEffect(() => {
    if (screen === "enter-pin" && appSettings.biometric_enabled && !biometricTriedRef.current) {
      biometricTriedRef.current = true;
      tryBiometricUnlock();
    }
    if (screen !== "enter-pin") {
      biometricTriedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, appSettings.biometric_enabled]);

  function updateDailySync(patch: Partial<DailySyncPref>) {
    const next = { ...dailySync, ...patch };
    setDailySync(next);
    try {
      localStorage.setItem(DAILY_SYNC_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
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
      // A plain <a download> click doesn't reliably save anywhere visible
      // inside the Android WebView — this uses the native save-file picker
      // instead, so the person actually sees (and controls) where it goes.
      const path = await saveFileDialog({
        defaultPath: "nexpass-export.json",
        filters: [{ name: "NexPass export", extensions: ["json"] }],
      });
      if (!path) {
        return; // user cancelled the picker
      }
      await writeTextFile(path, json);
      setExportPassword("");
      setAccountMsg(`Exported to ${path}`);
      showToast(`Credentials exported to ${path}`, "success", 4000);
    } catch (e) {
      setAccountMsg(friendlyError(String(e)));
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
      showToast(`Imported ${n} item(s)`, "success");
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
        setMainTab("home");
        setSettingsScreen("menu");
        setScreen("create-pin");
        setEntries([]);
        setTrashEntries([]);
        setGoogleSession(null);
        closePanel();
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
      setMainTab("home");
      setSettingsScreen("menu");
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
    closePanel();
    setMainTab("home");
    setSettingsScreen("menu");
    setScreen("enter-pin");
  }

  // Auto-lock.
  //
  // Mobile: "Instant" locks the moment the app leaves the foreground —
  // covers switching apps, the screen turning off, or the app closing.
  // Any other setting starts a timer when the app is backgrounded, and
  // cancels it if the app comes back in time. blur/visibilitychange are a
  // reliable "backgrounded" signal there.
  //
  // Desktop: those same events are NOT reliable — a Tauri window's
  // document commonly stays `visibilityState: "visible"` even while the
  // OS window has lost focus, and a quick alt-tab away-and-back cancels
  // the timer via "focus" before it ever gets anywhere. The practical
  // effect was that auto-lock almost never actually fired on desktop.
  // So on desktop, "N minutes" instead means N minutes of no mouse/
  // keyboard activity (the standard behavior for a desktop vault app),
  // while "Instant" still locks on window blur since that's a meaningful
  // signal there (switching to another app).
  useEffect(() => {
    if (screen !== "vault") return;

    if (isDesktop) {
      function resetIdleTimer() {
        if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
        if (appSettings.auto_lock_minutes > 0) {
          lockTimerRef.current = setTimeout(lockNow, appSettings.auto_lock_minutes * 60_000);
        }
      }
      const activityEvents: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"];

      if (appSettings.auto_lock_minutes <= 0) {
        // Use Tauri's native window-focus event rather than the DOM
        // "blur"/"visibilitychange" events — inside a WebView2 host those
        // don't reliably reflect the OS window actually losing focus
        // (alt-tabbing away, clicking another app), which is why
        // "Instant" wasn't firing on desktop before.
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        getCurrentWindow()
          .onFocusChanged(({ payload: focused }) => {
            if (!focused) lockNow();
          })
          .then((fn) => {
            if (cancelled) fn();
            else unlisten = fn;
          })
          .catch(() => {});
        return () => {
          cancelled = true;
          unlisten?.();
        };
      }

      activityEvents.forEach((ev) => window.addEventListener(ev, resetIdleTimer));
      resetIdleTimer();
      return () => {
        activityEvents.forEach((ev) => window.removeEventListener(ev, resetIdleTimer));
        if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
      };
    }

    function scheduleLock() {
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
      if (appSettings.auto_lock_minutes <= 0) {
        lockNow();
      } else {
        lockTimerRef.current = setTimeout(lockNow, appSettings.auto_lock_minutes * 60_000);
      }
    }
    function cancelLock() {
      if (lockTimerRef.current) {
        clearTimeout(lockTimerRef.current);
        lockTimerRef.current = null;
      }
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") scheduleLock();
      else cancelLock();
    }
    window.addEventListener("blur", scheduleLock);
    window.addEventListener("focus", cancelLock);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", scheduleLock);
    return () => {
      window.removeEventListener("blur", scheduleLock);
      window.removeEventListener("focus", cancelLock);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", scheduleLock);
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    };
  }, [screen, appSettings.auto_lock_minutes, isDesktop]);

  async function handleLock() {
    await lockNow();
  }

  function goTab(tab: MainTab) {
    setMainTab(tab);
    setSettingsScreen("menu");
    setCategoryFilter(null);
    closePanel();
  }

  // Hardware/gesture back button (see the "back-requested" emit in
  // lib.rs). One press steps back a single level in-app; a second press
  // within BACK_EXIT_WINDOW_MS while already at the root (Home tab, no
  // panel or settings subpage open) actually quits the app.
  const handleBackRequestedRef = useRef<() => void>(() => {});
  useEffect(() => {
    handleBackRequestedRef.current = () => {
      if (confirmDialog) {
        setConfirmDialog(null);
        return;
      }
      if (keyMismatch) {
        return; // let the user resolve or explicitly cancel this dialog
      }
      if (screen === "vault") {
        if (panelMode === "edit") {
          cancelPanel();
          return;
        }
        if (panelMode === "view" || panelMode === "add") {
          closePanel();
          return;
        }
        if (panelMode === "pick-category") {
          setPanelMode("none");
          return;
        }
        if (panelMode === "profile") {
          setPanelMode("none");
          return;
        }
        if (mainTab === "settings" && settingsScreen !== "menu") {
          setSettingsScreen("menu");
          return;
        }
        if (mainTab === "categories" && categoryFilter) {
          setCategoryFilter(null);
          return;
        }
        if (mainTab !== "home") {
          goTab("home");
          return;
        }
      }
      const now = Date.now();
      if (now - lastBackPressRef.current < BACK_EXIT_WINDOW_MS) {
        invoke("exit_app").catch(() => {});
      } else {
        lastBackPressRef.current = now;
        showToast("Press back again to exit", "info", BACK_EXIT_WINDOW_MS);
      }
    };
  });

  useEffect(() => {
    const unlistenPromise = listen("back-requested", () => handleBackRequestedRef.current());
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const homeList = useMemo(() => entries, [entries]);
  const favoritesList = useMemo(() => entries.filter((e) => e.favorite), [entries]);

  function applySearchAndSort(list: EntrySummary[]) {
    const q = search.trim().toLowerCase();
    let out = !q
      ? list
      : list.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.username.toLowerCase().includes(q) ||
            e.url.toLowerCase().includes(q)
        );
    out = [...out].sort((a, b) => (sortMode === "name" ? a.title.localeCompare(b.title) : b.updated_at - a.updated_at));
    return out;
  }

  const filteredHome = useMemo(() => applySearchAndSort(homeList), [homeList, search, sortMode]);
  const filteredFavorites = useMemo(() => applySearchAndSort(favoritesList), [favoritesList, search, sortMode]);

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

  const fullPageOpen = panelMode !== "none";

  function renderEntryRow(entry: EntrySummary, fromTrash: boolean) {
    const iconUrl = faviconUrl(entry.url);
    const icon = iconUrl && !brokenIcons.has(iconUrl) ? iconUrl : null;
    return (
      <li key={entry.id} className="entry-row" onClick={() => selectEntry(entry.id, fromTrash)}>
        <span className="avatar" style={{ background: icon ? "transparent" : avatarColor(entry.title) }}>
          {icon ? <img src={icon} alt="" onError={() => markIconBroken(icon)} /> : entry.title.charAt(0).toUpperCase() || "?"}
        </span>
        <span className="entry-row-text">
          <span className="entry-row-title">{entry.title}</span>
          <span className="entry-row-sub">{entry.username || entry.url || "—"}</span>
        </span>
        <span className="entry-row-right">
          <span className="entry-row-time">{timeAgo(entry.updated_at)}</span>
          {!fromTrash && (
            <button className={`star-btn ${entry.favorite ? "filled" : ""}`} onClick={(e) => toggleFavorite(entry.id, e)} title="Toggle favorite">
              <Icon.star filled={entry.favorite} />
            </button>
          )}
        </span>
      </li>
    );
  }

  const syncStatusLabel = !googleSession
    ? "Not connected"
    : syncing
    ? "Syncing…"
    : syncStatusInfo?.needs_sync
    ? "Changes pending"
    : syncStatusInfo?.last_sync_ok === false
    ? "Last sync failed"
    : syncStatusInfo
    ? "Up to date"
    : "Unknown";
  const syncStatusTone = !googleSession ? "muted" : syncing ? "info" : syncStatusInfo?.last_sync_ok === false ? "danger" : syncStatusInfo?.needs_sync ? "warn" : "ok";

  return (
    <div className={`app-shell ${isDesktop ? "is-desktop" : "is-mobile"}`}>
      {(screen === "loading" || screen === "create-pin" || screen === "confirm-pin" || screen === "enter-pin") && (
        <div className="centered-content full-bleed">
          {screen === "loading" && <p className="status-text">Loading…</p>}
          {screen !== "loading" && (
            <div className="pin-screen">
              <img src={LOGO_SRC} alt="" className="pin-logo" />
              <h2>{heading}</h2>
              <p className="status-text">{subheading}</p>
              {screen === "enter-pin" && appSettings.biometric_enabled && (
                <button className="biometric-retry-btn" onClick={tryBiometricUnlock} type="button">
                  <Icon.fingerprint /> Use biometrics
                </button>
              )}
              <div className={`pin-dots ${shake ? "shake" : ""}`}>
                {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                  <span key={i} className={`pin-dot ${i < pin.length ? "filled" : ""}`} />
                ))}
              </div>
              {error && <p className="error-text">{friendlyError(error)}</p>}
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
        <div className="mobile-shell">
          {/* ---------- SIDEBAR (desktop) / renders as bottom island nav on mobile via CSS ---------- */}
          <aside className="sidebar">
            <div className="sidebar-brand">
              <img src={LOGO_SRC} className="brand-logo" alt="" />
              <span className="brand-name">{APP_NAME}</span>
            </div>
            <nav className="sidebar-nav">
              <button className={mainTab === "home" ? "active" : ""} onClick={() => goTab("home")}>
                <Icon.home filled={mainTab === "home"} />
                <span>Home</span>
              </button>
              <button className={mainTab === "favorites" ? "active" : ""} onClick={() => goTab("favorites")}>
                <Icon.star filled={mainTab === "favorites"} />
                <span>Favorites</span>
              </button>
              <button className={mainTab === "categories" ? "active" : ""} onClick={() => goTab("categories")}>
                <Icon.grid />
                <span>Categories</span>
              </button>
              <button className={mainTab === "settings" ? "active" : ""} onClick={() => goTab("settings")}>
                <Icon.gear filled={mainTab === "settings"} />
                <span>Settings</span>
              </button>
            </nav>
            <div className="sidebar-footer">
              <div className="vault-status-card compact">
                <span className="shield-icon"><Icon.shield /></span>
                <div>
                  <div className="vault-status-label">Vault Status</div>
                  <div className="vault-status-value">Secure · {entries.length} item{entries.length === 1 ? "" : "s"}</div>
                </div>
              </div>
              <button className="sidebar-profile-btn" onClick={openProfile}>
                <span className="sidebar-profile-avatar">
                  {avatarSrc() ? <img src={avatarSrc()!} alt="" /> : <Icon.user />}
                </span>
                <span>{profile.name || "Profile"}</span>
              </button>
            </div>
          </aside>

          <div className="main-content">
            {/* Shared full-width search bar — sits above BOTH the list and
                detail columns (not the sidebar), matching the wireframe. */}
            {isDesktop && (mainTab === "home" || mainTab === "favorites") && (
              <div className="desktop-topbar">
                <div className="search-bar">
                  <Icon.search />
                  <input
                    placeholder={mainTab === "home" ? "Search credentials…" : "Search favorites…"}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">
                      <Icon.close />
                    </button>
                  )}
                </div>
              </div>
            )}

          <div className={`workspace${isDesktop && mainTab === "home" ? " has-detail" : ""}`}>
          <div className="list-column">
          {/* ---------- HOME ---------- */}
          {mainTab === "home" && (!fullPageOpen || isDesktop) && (
            <div className="tab-screen">
              <div className="brand-header replaced-by-topbar">
                <img src={LOGO_SRC} className="brand-logo" alt="" />
                <span className="brand-name">{APP_NAME}</span>
                <button className="profile-avatar-btn" onClick={openProfile} aria-label="Profile">
                  {avatarSrc() ? (
                    <img src={avatarSrc()!} alt="" />
                  ) : (
                    <Icon.user />
                  )}
                </button>
              </div>
              <div className="search-bar">
                <Icon.search />
                <input ref={searchRef} placeholder="Search credentials…" value={search} onChange={(e) => setSearch(e.target.value)} />
                {search && (
                  <button className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">
                    <Icon.close />
                  </button>
                )}
              </div>
              <div className="toolbar-row">
                <button className="pill-btn" onClick={() => setSortMode((m) => (m === "recent" ? "name" : "recent"))} title="Sort">
                  {sortMode === "recent" ? "Recent" : "A–Z"}
                </button>
                <button className="icon-btn ghost" onClick={handleLock} title="Lock vault">
                  <Icon.lock />
                </button>
                <button className="new-item-btn" onClick={startAdd}>
                  <Icon.plus /> New Item
                </button>
              </div>

              {entriesError && <p className="error-text small">{friendlyError(entriesError)}</p>}

              <div className="list-scroll">
                {!googleSession && (
                  <div className="signin-banner">
                    <span className="signin-banner-icon"><Icon.shield /></span>
                    <div className="signin-banner-text">
                      <div className="signin-banner-title">Keep your data safe</div>
                      <div className="signin-banner-sub">
                        Please complete sign in/up to keep your data safe and accessible from anywhere.
                      </div>
                    </div>
                    <button className="new-item-btn signin-banner-btn" onClick={handleGoogleSignIn} disabled={signingIn}>
                      {signingIn ? "Waiting…" : "Sign in with Google"}
                    </button>
                  </div>
                )}
                {filteredHome.length === 0 ? (
                  <p className="status-text empty-hint">{search ? "No matches." : "No entries yet — add your first one."}</p>
                ) : (
                  <ul className="entry-list">{filteredHome.map((e) => renderEntryRow(e, false))}</ul>
                )}
              </div>
            </div>
          )}

          {/* ---------- FAVORITES ---------- */}
          {mainTab === "favorites" && (!fullPageOpen || isDesktop) && (
            <div className="tab-screen">
              <div className="brand-header replaced-by-topbar">
                <img src={LOGO_SRC} className="brand-logo" alt="" />
                <span className="brand-name">Favorites</span>
              </div>
              <div className="search-bar">
                <Icon.search />
                <input placeholder="Search favorites…" value={search} onChange={(e) => setSearch(e.target.value)} />
                {search && (
                  <button className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">
                    <Icon.close />
                  </button>
                )}
              </div>
              <div className="list-scroll">
                {filteredFavorites.length === 0 ? (
                  <p className="status-text empty-hint">{search ? "No matches." : "No favorites yet — tap the star on an item to add it here."}</p>
                ) : (
                  <ul className="entry-list">{filteredFavorites.map((e) => renderEntryRow(e, false))}</ul>
                )}
              </div>
            </div>
          )}

          {/* ---------- CATEGORIES (coming soon) ---------- */}
          {mainTab === "categories" && (!fullPageOpen || isDesktop) && (
            <div className="tab-screen">
              {!categoryFilter ? (
                <>
                  <div className="brand-header">
                    <img src={LOGO_SRC} className="brand-logo" alt="" />
                    <span className="brand-name">Categories</span>
                  </div>
                  <div className="list-scroll">
                    <div className="category-grid">
                      {CATEGORIES.map((c) => {
                        const count = entries.filter((e) => e.category === c.id).length;
                        return (
                          <button key={c.id} className="category-tile" onClick={() => setCategoryFilter(c.id)}>
                            <span className="category-tile-label">{c.label}</span>
                            <span className="category-tile-count">{count} item{count === 1 ? "" : "s"}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="screen-header">
                    <button className="icon-btn back-btn" onClick={() => setCategoryFilter(null)}><Icon.back /></button>
                    <h2>{categoryLabel(categoryFilter)}</h2>
                  </div>
                  <div className="list-scroll">
                    {(() => {
                      const filtered = entries.filter((e) => e.category === categoryFilter);
                      return filtered.length === 0 ? (
                        <p className="status-text empty-hint">No items in this category yet.</p>
                      ) : (
                        <ul className="entry-list">{filtered.map((e) => renderEntryRow(e, false))}</ul>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---------- SETTINGS ---------- */}
          {mainTab === "settings" && (!fullPageOpen || isDesktop) && (
            <div className="tab-screen">
              {settingsScreen === "menu" && (
                <>
                  <div className="screen-header">
                    <h2>Settings</h2>
                  </div>
                  <div className="list-scroll">
                    <div className="vault-status-card">
                      <span className="shield-icon"><Icon.shield /></span>
                      <div>
                        <div className="vault-status-label">Vault Status</div>
                        <div className="vault-status-value">Secure · {entries.length} item{entries.length === 1 ? "" : "s"} encrypted</div>
                      </div>
                    </div>

                    <div className="settings-menu-list">
                      <button className="settings-menu-row" onClick={() => setSettingsScreen("general")}>
                        <span className="settings-menu-icon"><Icon.gear /></span>
                        <span className="settings-menu-text">
                          <span className="settings-menu-title">General</span>
                          <span className="settings-menu-sub">Auto-lock, notifications, sync</span>
                        </span>
                        <Icon.chevron />
                      </button>
                      <button className="settings-menu-row" onClick={() => setSettingsScreen("account")}>
                        <span className="settings-menu-icon"><Icon.user /></span>
                        <span className="settings-menu-text">
                          <span className="settings-menu-title">Account</span>
                          <span className="settings-menu-sub">Logout, backup, export, delete</span>
                        </span>
                        <Icon.chevron />
                      </button>
                      <button className="settings-menu-row" onClick={() => setSettingsScreen("updates")}>
                        <span className="settings-menu-icon"><Icon.download /></span>
                        <span className="settings-menu-text">
                          <span className="settings-menu-title">Updates</span>
                          <span className="settings-menu-sub">Release notes, software updates</span>
                        </span>
                        {updateInfo && <span className="update-dot" />}
                        <Icon.chevron />
                      </button>
                      <button className="settings-menu-row" onClick={() => setSettingsScreen("about")}>
                        <span className="settings-menu-icon"><Icon.info /></span>
                        <span className="settings-menu-text">
                          <span className="settings-menu-title">About</span>
                          <span className="settings-menu-sub">App info &amp; credits</span>
                        </span>
                        <Icon.chevron />
                      </button>
                    </div>

                    <button className="lock-now-btn" onClick={handleLock}>
                      <Icon.lock /> Lock vault now
                    </button>
                  </div>
                </>
              )}

              {settingsScreen === "general" && (
                <>
                  <div className="screen-header">
                    <button className="icon-btn back-btn" onClick={() => setSettingsScreen("menu")}><Icon.back /></button>
                    <h2>General</h2>
                  </div>
                  <div className="list-scroll settings-body">
                    <div className="settings-section">
                      <div className="settings-section-label">Security</div>
                      <div className="settings-row column">
                        <div className="settings-row-title">Auto Lock</div>
                        <div className="settings-row-sub">
                          Instant locks the moment you switch tabs/apps, the screen turns off, the app closes, or you leave and come back.
                          Otherwise, the vault locks after this many minutes away from the app.
                        </div>
                        <select
                          className="settings-select full"
                          value={appSettings.auto_lock_minutes}
                          onChange={(e) => updateSetting({ auto_lock_minutes: Number(e.target.value) })}
                        >
                          <option value={0}>Instant</option>
                          <option value={5}>5 minutes</option>
                          <option value={10}>10 minutes</option>
                          <option value={15}>15 minutes</option>
                        </select>
                      </div>
                    </div>

                    <div className="settings-section">
                      <div className="settings-section-label">Notifications</div>
                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Notifications</div>
                          <div className="settings-row-sub">Enable app notifications.</div>
                        </div>
                        <label className="switch">
                          <input type="checkbox" checked={appSettings.notifications_enabled} onChange={(e) => updateSetting({ notifications_enabled: e.target.checked })} />
                          <span />
                        </label>
                      </div>
                    </div>

                    <div className="settings-section">
                      <div className="settings-section-label">Security</div>
                      <div className="settings-row column">
                        <div className="settings-row-title-line">
                          <span className="settings-row-title"><Icon.fingerprint /> Biometrics</span>
                          <label className="switch">
                            <input type="checkbox" checked={appSettings.biometric_enabled} disabled={biometricBusy} onChange={(e) => handleBiometricToggle(e.target.checked)} />
                            <span />
                          </label>
                        </div>
                        <div className="settings-row-sub">
                          Unlock instantly with your fingerprint or face — right after opening the app. You can always fall back to your PIN.
                        </div>
                        {biometricSetupOpen && (
                          <div className="settings-inline-form">
                            <input
                              type="password"
                              inputMode="numeric"
                              placeholder="Confirm your PIN to finish setup"
                              value={biometricSetupPin}
                              onChange={(e) => setBiometricSetupPin(e.target.value.replace(/\D/g, ""))}
                            />
                            <button className="settings-btn" disabled={biometricBusy} onClick={confirmEnableBiometric}>
                              Confirm
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="settings-section">
                      <div className="settings-section-label">Sync</div>
                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Linked account</div>
                          <div className="settings-row-sub">{googleSession ? googleSession.email : "No Google account linked"}</div>
                        </div>
                        {!googleSession && (
                          <button className="settings-btn" onClick={handleGoogleSignIn} disabled={signingIn}>
                            {signingIn ? "Waiting…" : "Sign in"}
                          </button>
                        )}
                      </div>
                      {syncError && <p className="error-text small">{friendlyError(syncError)}</p>}

                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Manual sync</div>
                          <div className="settings-row-sub">Push and pull changes right now.</div>
                        </div>
                        <button className="settings-btn" onClick={() => handleSyncNow(false)} disabled={syncing || !googleSession}>
                          <span className={syncing ? "spin" : ""}><Icon.sync /></span> {syncing ? "Syncing…" : "Sync now"}
                        </button>
                      </div>
                      {syncing && syncProgress && (syncProgress.phase === "pushing" || syncProgress.phase === "pulling") && syncProgress.total > 0 && (
                        <div className="sync-progress">
                          <div className="sync-progress-bar">
                            <div className="sync-progress-fill" style={{ width: `${Math.min(100, (syncProgress.done / syncProgress.total) * 100)}%` }} />
                          </div>
                          <span className="settings-row-sub">{syncProgress.message} ({syncProgress.done}/{syncProgress.total})</span>
                        </div>
                      )}

                      <div className="settings-row column">
                        <div className="settings-row-title">Daily sync</div>
                        <div className="settings-row-sub">Automatically sync once a day at a set time.</div>
                        <div className="daily-sync-row">
                          <label className="switch">
                            <input type="checkbox" checked={dailySync.enabled} onChange={(e) => updateDailySync({ enabled: e.target.checked })} />
                            <span />
                          </label>
                          <input
                            type="time"
                            className="time-input"
                            value={dailySync.time}
                            disabled={!dailySync.enabled}
                            onChange={(e) => updateDailySync({ time: e.target.value })}
                          />
                        </div>
                      </div>

                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Last Sync</div>
                          <div className="settings-row-sub">{formatDateTime(syncStatusInfo?.last_sync_at ?? 0)}</div>
                        </div>
                      </div>

                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Sync Status</div>
                        </div>
                        <span className={`status-badge ${syncStatusTone}`}>{syncStatusLabel}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {settingsScreen === "account" && (
                <>
                  <div className="screen-header">
                    <button className="icon-btn back-btn" onClick={() => setSettingsScreen("menu")}><Icon.back /></button>
                    <h2>Account</h2>
                  </div>
                  <div className="list-scroll settings-body">
                    {accountMsg && <p className="status-text">{friendlyError(accountMsg)}</p>}

                    <div className="settings-section">
                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Trash</div>
                          <div className="settings-row-sub">{trashEntries.length} item{trashEntries.length === 1 ? "" : "s"}</div>
                        </div>
                        <button className="settings-btn" onClick={() => setSettingsScreen("trash")}>Open</button>
                      </div>

                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Logout</div>
                          <div className="settings-row-sub">Removes all data from this device.</div>
                        </div>
                        <button className="settings-btn" onClick={handleLogout}><Icon.logout /> Logout</button>
                      </div>

                      <div className="settings-row column">
                        <div className="settings-row-title">Vault key diagnostic</div>
                        <div className="settings-row-sub">
                          Compares this device's key with the account's cloud key — should say "match" on every device signed into the same account.
                        </div>
                        <button
                          className="settings-btn"
                          disabled={debugBusy}
                          onClick={async () => {
                            setDebugBusy(true);
                            try {
                              setDebugInfo(await invoke<VaultKeyDebugInfo>("debug_vault_key_info"));
                            } catch (e) {
                              showToast(friendlyError(String(e)), "error");
                            } finally {
                              setDebugBusy(false);
                            }
                          }}
                        >
                          {debugBusy ? "Checking…" : "Check vault key"}
                        </button>
                        {debugInfo && (
                          <div className="diagnostic-box">
                            Account: {debugInfo.google_email ?? "not signed in"}<br />
                            Local salt: {debugInfo.local_salt_prefix ?? "none"}<br />
                            Cloud salt: {debugInfo.cloud_salt_prefix ?? "none"}<br />
                            <strong style={{ color: debugInfo.salts_match ? "var(--success)" : "var(--error)" }}>
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
                    </div>

                    <div className="settings-section danger-zone">
                      <div className="settings-section-label danger">Danger zone</div>
                      <div className="settings-row column">
                        <div className="settings-row-title">Export credentials &amp; delete account</div>
                        <div className="settings-row-sub">Export your credentials above first — then permanently delete ALL your data from the cloud and this device.</div>
                        {!showDeleteConfirm ? (
                          <button className="settings-btn danger" onClick={() => setShowDeleteConfirm(true)}>Delete account</button>
                        ) : (
                          <div className="delete-confirm">
                            <p className="error-text">
                              If you DELETE YOUR ACCOUNT, ALL OF YOUR DATA WILL BE REMOVED FROM THE CLOUD. Type your email
                              ({googleSession?.email ?? "sign in first"}) to confirm.
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
                  </div>
                </>
              )}

              {settingsScreen === "trash" && (
                <>
                  <div className="screen-header">
                    <button className="icon-btn back-btn" onClick={() => setSettingsScreen("account")}><Icon.back /></button>
                    <h2>Trash</h2>
                  </div>
                  <div className="list-scroll">
                    {trashEntries.length === 0 ? (
                      <p className="status-text empty-hint">Trash is empty.</p>
                    ) : (
                      <ul className="entry-list">{trashEntries.map((e) => renderEntryRow(e, true))}</ul>
                    )}
                  </div>
                </>
              )}

              {settingsScreen === "updates" && (
                <>
                  <div className="screen-header">
                    <button className="icon-btn back-btn" onClick={() => setSettingsScreen("menu")}><Icon.back /></button>
                    <h2>Updates</h2>
                  </div>
                  <div className="list-scroll settings-body">
                    <div className="settings-section">
                      <div className="settings-section-label">Release Notes</div>
                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">What's new</div>
                          <div className="settings-row-sub">See changes across recent versions.</div>
                        </div>
                        <button className="settings-btn" onClick={loadReleaseNotes} disabled={releaseNotesBusy}>
                          {releaseNotesBusy ? "Loading…" : releaseNotesOpen ? "Hide" : "Show Release Notes"}
                        </button>
                      </div>
                      {releaseNotesOpen && (
                        <div className="release-notes-list">
                          {!releaseNotes || releaseNotes.length === 0 ? (
                            <p className="status-text">No release notes available right now.</p>
                          ) : (
                            releaseNotes.map((r) => (
                              <div key={r.version} className="release-note-item">
                                <div className="release-note-header">
                                  <span className="release-note-version">v{r.version}</span>
                                  <span className="release-note-date">{r.date}</span>
                                </div>
                                <p className="release-note-text">{r.notes}</p>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    <div className="settings-section">
                      <div className="settings-section-label">Software Updates</div>
                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Current version</div>
                          <div className="settings-row-sub">V.{APP_VERSION}</div>
                        </div>
                      </div>
                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Last update applied</div>
                          <div className="settings-row-sub">
                            {(() => {
                              const last = lastUpdateApplied();
                              return last ? `v${last.version} — ${new Date(last.appliedAt).toLocaleString()}` : "No update applied via the app yet";
                            })()}
                          </div>
                        </div>
                      </div>
                      <div className="settings-row">
                        <div>
                          <div className="settings-row-title">Manual check</div>
                        </div>
                        <button className="settings-btn" onClick={() => maybeCheckForUpdate(true)}>Check now</button>
                      </div>
                      <div className="settings-row column">
                        <div className="settings-row-title">Auto check</div>
                        <select
                          className="settings-select full"
                          value={appSettings.update_check_frequency}
                          onChange={(e) => updateSetting({ update_check_frequency: e.target.value })}
                        >
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly (default)</option>
                          <option value="monthly">Monthly</option>
                        </select>
                      </div>
                      {updateInfo && (
                        <div className="settings-row column">
                          <div className="settings-row-title">Update available — v{updateInfo.version}</div>
                          {updateStage === "downloading" && (
                            <div className="sync-progress">
                              <div className="sync-progress-bar">
                                <div
                                  className="sync-progress-fill"
                                  style={{
                                    width:
                                      downloadProgress && downloadProgress.total > 0
                                        ? `${Math.min(100, (downloadProgress.downloaded / downloadProgress.total) * 100)}%`
                                        : "100%",
                                  }}
                                />
                              </div>
                              <span className="settings-row-sub">
                                {downloadProgress && downloadProgress.total > 0
                                  ? `Downloading… ${formatBytes(downloadProgress.downloaded)} / ${formatBytes(downloadProgress.total)}`
                                  : "Downloading…"}
                              </span>
                            </div>
                          )}
                          {updateStage === "idle" && (
                            <button className="settings-btn primary" onClick={handleDownloadUpdate} disabled={updateBusy}>
                              Download Update
                            </button>
                          )}
                        </div>
                      )}
                      {downloadedApk && (
                        <div className="settings-row column">
                          <div className="settings-row-title">Downloaded update — v{downloadedApk.version}</div>
                          <div className="settings-row-sub">{formatBytes(downloadedApk.size_bytes)} on this device, not encrypted</div>
                          <div className="settings-btn-group">
                            {updateStage !== "downloading" && (
                              <button className="settings-btn primary" onClick={handleInstallDownloadedApk} disabled={installBusy}>
                                {installBusy ? "Opening installer…" : "Install Now"}
                              </button>
                            )}
                            <button className="settings-btn danger" onClick={handleDeleteDownloadedApk} disabled={deleteApkBusy}>
                              {deleteApkBusy ? "Deleting…" : "Delete APK File"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {settingsScreen === "about" && (
                <>
                  <div className="screen-header">
                    <button className="icon-btn back-btn" onClick={() => setSettingsScreen("menu")}><Icon.back /></button>
                    <h2>About</h2>
                  </div>
                  <div className="list-scroll settings-body">
                    <div className="about-logo-block">
                      <img src={LOGO_SRC} alt="" className="about-logo" />
                      <div className="about-app-name">{APP_NAME}</div>
                      <div className="about-app-version">V.{APP_VERSION}</div>
                    </div>
                    <div className="settings-section">
                      <div className="settings-row">
                        <div><div className="settings-row-title">App Name</div></div>
                        <span>{APP_NAME}</span>
                      </div>
                      <div className="settings-row">
                        <div><div className="settings-row-title">Version</div></div>
                        <span>V.{APP_VERSION}</span>
                      </div>
                      <div className="settings-row">
                        <div><div className="settings-row-title">App ID</div></div>
                        <span className="copyable" onClick={() => copyToClipboard(APP_ID, "App ID")}>{APP_ID}</span>
                      </div>
                      <div className="settings-row">
                        <div><div className="settings-row-title">Author</div></div>
                        <button className="plain-link link-btn" onClick={() => openExternal(APP_AUTHOR_URL)}>{APP_AUTHOR}</button>
                      </div>
                      <div className="settings-row">
                        <div><div className="settings-row-title">Developer</div></div>
                        <button className="plain-link link-btn" onClick={() => openExternal(APP_DEVELOPER_URL)}>{APP_DEVELOPERS}</button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          </div>{/* /list-column */}

          {/* ---------- CREDENTIAL DETAIL (right pane on desktop, full-page on mobile) ---------- */}
          {panelMode === "view" && selectedEntry && (
            <div className={`fullpage view-pane${isDesktop && mainTab === "home" ? " embedded" : ""}`}>
              <div className="screen-header">
                <button className="icon-btn back-btn" onClick={closePanel}><Icon.back /></button>
                <h2 className="truncate">{selectedEntry.title}</h2>
                <div className="screen-header-actions">
                  {!viewingTrash && (
                    <button className={`icon-btn ${selectedEntry.favorite ? "star-active" : ""}`} onClick={() => toggleFavorite(selectedEntry.id)} title="Favorite">
                      <Icon.star filled={selectedEntry.favorite} />
                    </button>
                  )}
                  {viewingTrash ? (
                    <>
                      <button className="icon-btn" onClick={restoreSelected} title="Restore"><Icon.undo /></button>
                      <button className="icon-btn danger" onClick={deleteForever} title="Delete forever"><Icon.trash /></button>
                    </>
                  ) : (
                    <>
                      <button className="icon-btn" onClick={startEdit} title="Edit"><Icon.edit /></button>
                      <button className="icon-btn danger" onClick={moveToTrash} title="Move to Trash"><Icon.trash /></button>
                    </>
                  )}
                </div>
              </div>

              <div className="list-scroll detail-content">
                <div className="detail-avatar-block">
                  {(() => {
                    const detailIconUrl = faviconUrl(selectedEntry.url);
                    const detailIcon = detailIconUrl && !brokenIcons.has(detailIconUrl) ? detailIconUrl : null;
                    return (
                      <span className="avatar large" style={{ background: detailIcon ? "transparent" : avatarColor(selectedEntry.title) }}>
                        {detailIcon ? (
                          <img src={detailIcon} alt="" onError={() => markIconBroken(detailIcon)} />
                        ) : (
                          selectedEntry.title.charAt(0).toUpperCase() || "?"
                        )}
                      </span>
                    );
                  })()}
                  <h1>{selectedEntry.title}</h1>
                </div>

                <div className="field-block">
                  <label>Category</label>
                  <span>{categoryLabel(selectedEntry.category)}</span>
                </div>

                {selectedEntry.category === "login" ? (
                  <>
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
                          <button className="url-link" onClick={() => openExternal(selectedEntry.url)}>{selectedEntry.url}</button>
                          <button className="icon-btn" onClick={() => openExternal(selectedEntry.url)} title="Open in browser"><Icon.external /></button>
                        </div>
                      </div>
                    )}

                    {selectedEntry.notes && (
                      <div className="field-block">
                        <label>Notes</label>
                        <p className="notes-text">{selectedEntry.notes}</p>
                      </div>
                    )}
                  </>
                ) : (
                  (() => {
                    const { fields, codes } = parseFieldsJson(selectedEntry.fields_json);
                    const schema = CATEGORY_FIELD_SCHEMAS[selectedEntry.category] ?? [];
                    const hasSensitive = schema.some((f) => f.sensitive);
                    return (
                      <>
                        {hasSensitive && (
                          <button className="pill-btn reveal-all-btn" onClick={() => setSensitiveRevealed((v) => !v)}>
                            <Icon.eye /> {sensitiveRevealed ? "Hide sensitive fields" : "Show sensitive fields"}
                          </button>
                        )}
                        {schema.map((f) => {
                          const value = fields[f.key];
                          if (!value) return null;
                          const masked = f.sensitive && !sensitiveRevealed;
                          return (
                            <div className="field-block" key={f.key}>
                              <label>{f.label}</label>
                              <div className="field-row">
                                <span className={f.sensitive ? "password-field" : ""}>
                                  {masked ? "•".repeat(Math.max(8, value.length)) : value}
                                </span>
                                <button className="icon-btn" onClick={() => copyToClipboard(value, f.label)}><Icon.copy /></button>
                              </div>
                            </div>
                          );
                        })}
                        {selectedEntry.category === "backup_codes" && codes.length > 0 && (
                          <div className="field-block">
                            <label>Codes</label>
                            <div className="codes-summary">
                              Total: {codes.length} · Used: {codes.filter((c) => c.used).length} · Unused: {codes.filter((c) => !c.used).length}
                            </div>
                            <ul className="codes-view-list">
                              {codes.map((c, i) => (
                                <li key={i} className={c.used ? "used" : ""}>
                                  <span>{c.used ? "☑" : "☐"}</span>
                                  <span className="codes-view-code">{c.code}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    );
                  })()
                )}

                <div className="field-block">
                  <label>Updated</label>
                  <span>{formatDateTime(selectedEntry.updated_at)}</span>
                </div>
              </div>
            </div>
          )}

          {/* ---------- Desktop-only placeholder when nothing is selected (Home tab only — other tabs don't reserve detail space) ---------- */}
          {isDesktop && mainTab === "home" && !(panelMode === "view" && selectedEntry) && (
            <aside className="view-pane detail-empty-pane">
              <div className="detail-empty">
                <Icon.lock />
                <p>Select an item to view its details</p>
              </div>
            </aside>
          )}
          </div>{/* /workspace */}
          </div>{/* /main-content */}

          {/* ---------- FULL-PAGE ADD / EDIT ---------- */}
          {panelMode === "pick-category" && (
            <div className="fullpage">
              <div className="screen-header">
                <button className="icon-btn back-btn" onClick={() => setPanelMode("none")}><Icon.back /></button>
                <h2>Choose a category</h2>
              </div>
              <div className="list-scroll">
                <div className="category-grid">
                  {CATEGORIES.map((c) => (
                    <button key={c.id} className="category-tile" onClick={() => pickCategoryAndAdd(c.id)}>
                      <span className="category-tile-label">{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {(panelMode === "edit" || panelMode === "add") && (
            <div className="fullpage">
              <div className="screen-header">
                <button className="icon-btn back-btn" onClick={cancelPanel}><Icon.back /></button>
                <h2>{panelMode === "edit" ? "Edit item" : `New ${categoryLabel(form.category)}`}</h2>
              </div>
              <div className="list-scroll">
                <form className="entry-form" onSubmit={(e) => { e.preventDefault(); saveForm(); }}>
                  <label className="form-label">Title
                    <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Gmail" autoFocus />
                  </label>
                  {panelMode === "edit" && (
                    <label className="form-label">Category
                      <select className="settings-select full" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                        {CATEGORIES.map((c) => (
                          <option key={c.id} value={c.id}>{c.label}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {form.category === "login" ? (
                    <>
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
                    </>
                  ) : (
                    <>
                      {(CATEGORY_FIELD_SCHEMAS[form.category] ?? []).map((f) => (
                        <label className="form-label" key={f.key}>
                          {f.label}
                          {f.type === "select" ? (
                            <select
                              className="settings-select full"
                              value={formFields[f.key] ?? ""}
                              onChange={(e) => setFormFields({ ...formFields, [f.key]: e.target.value })}
                            >
                              <option value="">—</option>
                              {(f.options ?? []).map((o) => (
                                <option key={o} value={o}>{o}</option>
                              ))}
                            </select>
                          ) : f.type === "textarea" ? (
                            <textarea
                              rows={3}
                              value={formFields[f.key] ?? ""}
                              onChange={(e) => setFormFields({ ...formFields, [f.key]: e.target.value })}
                            />
                          ) : (
                            <input
                              type={f.type === "password" ? "password" : f.type === "date" ? "date" : "text"}
                              value={formFields[f.key] ?? ""}
                              onChange={(e) => setFormFields({ ...formFields, [f.key]: e.target.value })}
                            />
                          )}
                        </label>
                      ))}
                      {form.category === "backup_codes" && (
                        <div className="form-label">
                          Codes
                          <div className="codes-editor">
                            {formCodes.map((c, i) => (
                              <div className="codes-editor-row" key={i}>
                                <input
                                  type="checkbox"
                                  checked={c.used}
                                  onChange={(e) => {
                                    const next = [...formCodes];
                                    next[i] = { ...next[i], used: e.target.checked };
                                    setFormCodes(next);
                                  }}
                                />
                                <input
                                  className="codes-editor-input"
                                  value={c.code}
                                  placeholder="e.g. 4821 7392"
                                  onChange={(e) => {
                                    const next = [...formCodes];
                                    next[i] = { ...next[i], code: e.target.value };
                                    setFormCodes(next);
                                  }}
                                />
                                <button type="button" className="icon-btn danger" onClick={() => setFormCodes(formCodes.filter((_, j) => j !== i))}>
                                  <Icon.close />
                                </button>
                              </div>
                            ))}
                            <button type="button" className="pill-btn" onClick={() => setFormCodes([...formCodes, { code: "", used: false }])}>
                              <Icon.plus /> Add code
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  <div className="form-actions">
                    <button type="button" onClick={cancelPanel}>Cancel</button>
                    <button type="submit" className="primary-btn">Save</button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* ---------- FULL-PAGE PROFILE ---------- */}
          {panelMode === "profile" && (
            <div className="fullpage">
              <div className="screen-header">
                <button className="icon-btn back-btn" onClick={() => setPanelMode("none")}><Icon.back /></button>
                <h2>Profile</h2>
              </div>
              <div className="list-scroll">
                <div className="profile-avatar-block">
                  <span className="profile-avatar-large">
                    {avatarSrc() ? <img src={avatarSrc()!} alt="" /> : <Icon.user />}
                  </span>
                  <div className="settings-btn-group">
                    <button className="settings-btn" onClick={changeAvatar}>Change</button>
                    {profile.avatar_path && (
                      <button className="settings-btn danger" onClick={removeAvatar}>Remove</button>
                    )}
                  </div>
                </div>
                <label className="form-label">Name
                  <input value={profileNameDraft} onChange={(e) => setProfileNameDraft(e.target.value)} placeholder="Your name" />
                </label>
                <label className="form-label">Bio
                  <textarea rows={3} value={profileBioDraft} onChange={(e) => setProfileBioDraft(e.target.value)} placeholder="A short bio" />
                </label>
                <label className="form-label">Email
                  <input value={googleSession?.email ?? ""} disabled />
                </label>
                <div className="form-actions">
                  <button type="button" onClick={() => setPanelMode("none")}>Cancel</button>
                  <button type="button" className="primary-btn" disabled={profileBusy} onClick={saveProfile}>Save</button>
                </div>
              </div>
            </div>
          )}

          {/* ---------- FLOATING BOTTOM ISLAND NAV (mobile only — desktop uses the sidebar) ---------- */}
          {!isDesktop && !fullPageOpen && (
            <nav className="island-nav">
              <button className={mainTab === "home" ? "active" : ""} onClick={() => goTab("home")}>
                <Icon.home filled={mainTab === "home"} />
                <span>Home</span>
              </button>
              <button className={mainTab === "favorites" ? "active" : ""} onClick={() => goTab("favorites")}>
                <Icon.star filled={mainTab === "favorites"} />
                <span>Favorites</span>
              </button>
              <button className={mainTab === "categories" ? "active" : ""} onClick={() => goTab("categories")}>
                <Icon.grid />
                <span>Categories</span>
              </button>
              <button className={mainTab === "settings" ? "active" : ""} onClick={() => goTab("settings")}>
                <Icon.gear filled={mainTab === "settings"} />
                <span>Settings</span>
              </button>
            </nav>
          )}
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
            {reconcileError && <p className="error-text">{friendlyError(reconcileError)}</p>}
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

      {updateInfo && (
        <div className="confirm-overlay">
          <div className="confirm-box update-box" onClick={(e) => e.stopPropagation()}>
            <div className="update-icon"><Icon.download /></div>
            <div className="update-version-line">
              v{updateInfo.current_version} <Icon.chevron /> v{updateInfo.version}
            </div>
            <p className="update-changelog">{updateInfo.changelog}</p>

            {updateStage === "downloading" && (
              <div className="sync-progress">
                <div className="sync-progress-bar">
                  <div
                    className="sync-progress-fill"
                    style={{
                      width:
                        downloadProgress && downloadProgress.total > 0
                          ? `${Math.min(100, (downloadProgress.downloaded / downloadProgress.total) * 100)}%`
                          : "100%",
                    }}
                  />
                </div>
                <span className="settings-row-sub">
                  {downloadProgress && downloadProgress.total > 0
                    ? `${formatBytes(downloadProgress.downloaded)} / ${formatBytes(downloadProgress.total)}`
                    : "Downloading…"}
                </span>
              </div>
            )}

            {updateStage === "downloaded" && (
              <div className="settings-btn-group">
                <button className="settings-btn" onClick={dismissUpdate}>Later</button>
                <button className="settings-btn primary" onClick={handleInstallDownloadedApk} disabled={installBusy}>
                  {installBusy ? "Opening installer…" : "Install Now"}
                </button>
              </div>
            )}

            {updateStage === "idle" && (
              <div className="settings-btn-group">
                <button className="settings-btn" onClick={dismissUpdate}>Later</button>
                <button className="settings-btn primary" onClick={handleDownloadUpdate} disabled={updateBusy}>Download Update</button>
              </div>
            )}
          </div>
        </div>
      )}

      {showRestartPrompt && !updateInfo && (
        <div className="confirm-overlay" onClick={() => setShowRestartPrompt(false)}>
          <div className="confirm-box update-box" onClick={(e) => e.stopPropagation()}>
            <div className="update-icon"><Icon.download /></div>
            <p className="update-changelog">
              Android's installer is opening in the background. Once you confirm the install there, tap below to restart NexPass. (If it doesn't reopen on its own, just launch NexPass again from your home screen.)
            </p>
            <div className="settings-btn-group">
              <button className="settings-btn" onClick={() => setShowRestartPrompt(false)}>Not now</button>
              <button className="settings-btn primary" onClick={handleRestartApp} disabled={restartBusy}>
                {restartBusy ? "Restarting…" : "Restart App"}
              </button>
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
