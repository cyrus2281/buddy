/// Types shared across main, preload, and renderer. Kept in one file because
/// every one of them crosses the IPC boundary and drifting copies would be
/// invisible until runtime.

export type AppState =
  | 'IDLE'
  | 'OBSERVING'
  | 'ARMED'
  | 'ACTING'
  | 'STANDBY'
  | 'NEEDS_HUMAN'
  | 'PAUSED';

export interface Permissions {
  screenRecording: boolean;
  accessibility: boolean;
}

export interface FrontmostSnapshot {
  bundleId: string;
  appName: string;
  pid: number;
  windowTitle: string;
  idleSeconds: number;
  secureInput: boolean;
  displayCount: number;
}

export interface CaptureResult {
  path: string;
  bytes: number;
  pixelWidth: number;
  pixelHeight: number;
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
  /** screenPoint = modelCoord / scale. 1.0 on the common path (PRD §6.2). */
  scale: number;
  phash: string;
  displayId: number;
}

export interface DisplayInfo {
  id: number;
  width: number;
  height: number;
  backingScaleFactor: number;
  modelScale: number;
  isMain: boolean;
}

export interface FrameRow {
  id: number;
  ts: number;
  display_id: number;
  path: string;
  w: number;
  h: number;
  bundle_id: string;
  app_name: string;
  window_title: string;
  phash: string;
  ocr_text: string | null;
  expires_at: number;
  deleted_at: number | null;
}

export interface CaptureStats {
  /** Since the current app launch. The keep rate is the number that tells you
   *  whether dedupe is doing anything; PRD §5 expects 20–35%. */
  considered: number;
  kept: number;
  skippedDuplicate: number;
  skippedExcluded: number;
  skippedSecureInput: number;
  skippedIdle: number;
  errors: number;
  lastCaptureAt: number | null;
  lastKeptAt: number | null;
  framesOnDisk: number;
  bytesOnDisk: number;
  observingSinceMs: number | null;
}

export interface ExclusionRule {
  /** Bundle id, exact match. */
  bundleId?: string;
  /** JS regex source, tested against the window title. */
  titlePattern?: string;
  label: string;
  /** Shipped defaults cannot be deleted, only disabled — a user who removes
   *  1Password by accident would not find out until a password was on disk. */
  builtin: boolean;
  enabled: boolean;
}

export interface Settings {
  captureIntervalMs: number;
  signalIntervalMs: number;
  retentionDays: number;
  /** pHash Hamming distance below which a frame is a duplicate (PRD §5). */
  phashThreshold: number;
  /** Skip capture entirely once the user has been idle this long. */
  idleSkipSeconds: number;
  hotkey: string;
  abortHotkey: string;
  paused: boolean;
  exclusions: ExclusionRule[];
  reducedMotion: boolean;
}

export interface SecretsStatus {
  encryptionAvailable: boolean;
  anthropic: boolean;
  openai: boolean;
}

export interface SidecarStatus {
  running: boolean;
  pid: number | null;
  version: string | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
  /** Which implementation is actually serving `capture` — the R1 outcome
   *  decides this at runtime rather than at build time. */
  captureBackend: 'sidecar' | 'electron' | 'none';
}

export interface LogEntry {
  t: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export type HudState = { state: AppState; provisionalGoal: string | null };

export const DEFAULT_SETTINGS: Settings = {
  captureIntervalMs: 15_000,
  signalIntervalMs: 2_000,
  retentionDays: 1,
  phashThreshold: 8,
  idleSkipSeconds: 120,
  hotkey: 'Alt+Command+Space',
  abortHotkey: 'Alt+Command+.',
  paused: false,
  reducedMotion: false,
  exclusions: [
    { label: '1Password', bundleId: 'com.1password.1password', builtin: true, enabled: true },
    { label: '1Password 7', bundleId: 'com.agilebits.onepassword7', builtin: true, enabled: true },
    { label: 'Keychain Access', bundleId: 'com.apple.keychainaccess', builtin: true, enabled: true },
    { label: 'Passwords', bundleId: 'com.apple.Passwords', builtin: true, enabled: true },
    { label: 'Private / Incognito windows', titlePattern: '(Private Browsing|Incognito)', builtin: true, enabled: true },
  ],
};
