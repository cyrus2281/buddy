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
  /** The display's top-left in the global CGEvent coordinate space. Zero on a
   *  single-display Mac; the offset the executor adds on a second one. */
  originX: number;
  originY: number;
}

export interface DisplayInfo {
  id: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// M2 — the Operator (PRD §6, §7)
// ─────────────────────────────────────────────────────────────────────────────

/** Decided before the loop starts and immutable for the run. A run cannot
 *  escalate its own permissions (PRD §6.1). */
export type RunProfile = 'attended' | 'unattended';

export type RunStatus =
  | 'confirming'
  | 'running'
  | 'gated'
  | 'done'
  | 'waiting'
  | 'needs_human'
  | 'cancelled';

/** What a `deny` or `confirm` is *about*. The policy matrix in PRD §7.1 is
 *  keyed on this, so adding a profile is a row, not an implementation. */
export type ActionClass =
  | 'read'
  | 'type_editor'
  | 'send'
  | 'purchase'
  | 'credentials'
  | 'delete'
  | 'install'
  | 'system_settings'
  | 'off_allowlist';

export type Decision = 'allow' | 'confirm' | 'deny';

export interface GuardVerdict {
  decision: Decision;
  class: ActionClass;
  /** One sentence, shown verbatim in the confirm gate and the run log. */
  reason: string;
  /** Which of §7.2's three signals produced this, in descending trust. */
  signal: 'ax-tree' | 'app-domain' | 'keystroke-content' | 'action-kind';
  /** What the action targets, for the gate copy: "the Send button", "notion.so". */
  target: string;
}

export interface RunBudgets {
  maxSteps: number;
  maxWallClockMs: number;
  maxCostUsd: number;
}

export const DEFAULT_BUDGETS: RunBudgets = {
  maxSteps: 60,
  maxWallClockMs: 10 * 60_000,
  maxCostUsd: 2.0,
};

export interface BudgetUsage {
  steps: number;
  elapsedMs: number;
  costUsd: number;
  /** Non-null once a budget is blown; names which one. */
  exceeded: 'steps' | 'time' | 'cost' | null;
}

export interface Allowlist {
  /** macOS bundle IDs. Seeded from the goal's target apps and confirmed by the
   *  user in the same keystroke as the goal (PRD §6.1). */
  apps: string[];
  /** Hostnames, matched on suffix so `notion.so` covers `www.notion.so`. */
  domains: string[];
}

export interface RunStep {
  runId: number;
  idx: number;
  tool: string;
  input: unknown;
  result: unknown;
  framePath: string | null;
  isError: boolean;
  ts: number;
  /** Present on every step: null when nothing was classified (a custom tool). */
  verdict: GuardVerdict | null;
  /** §6.2's scale factor, recorded per step so a misplaced click is diagnosable
   *  from the log rather than by re-deriving what the display was doing. */
  scale: number | null;
}

export interface RunOutcome {
  status: 'done' | 'waiting' | 'needs_human';
  summary: string;
  wake?: { after_s: number; condition: string; max_attempts: number };
}

export interface RunRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  profile: RunProfile;
  goal: string;
  status: RunStatus;
  steps: number;
  cost_usd: number;
  outcome_json: string | null;
}

/** The pending confirm gate (PRD §8.1). Only ever one at a time: the loop is
 *  blocked while it is open. */
export interface PendingGate {
  runId: number;
  stepIdx: number;
  action: string;
  verdict: GuardVerdict;
}

export interface RunView {
  id: number;
  goal: string;
  profile: RunProfile;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  budgets: RunBudgets;
  usage: BudgetUsage;
  allowlist: Allowlist;
  steps: RunStep[];
  outcome: RunOutcome | null;
  /** Why the run stopped, when it stopped for a reason other than finishing. */
  haltReason: string | null;
  gate: PendingGate | null;
  /** Live cache telemetry — a persistent zero means a silent invalidator
   *  (PRD §6.5). */
  cacheReadTokens: number;
}

export interface StartRunRequest {
  goal: string;
  profile: RunProfile;
  allowlist: Allowlist;
  budgets?: Partial<RunBudgets>;
}

export type KillSwitch = 'hotkey' | 'sentinel' | 'human-takeover' | 'stop-button';
