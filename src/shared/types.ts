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
  /** PRD §7.1. Until this is on, `leashless` is not offered in the HUD and a
   *  run that asks for it is refused. Turning it on is the deliberate act;
   *  choosing it per run is then one click, which is the right shape — the
   *  dangerous decision should be made once, calmly, in Settings. */
  leashlessEnabled: boolean;
  exclusions: ExclusionRule[];
  reducedMotion: boolean;

  // M3 — the Observer's upper tiers (PRD §5).
  /** T2 cadence. PRD §5 says every 3 minutes. */
  observeIntervalMs: number;
  /** A context switch triggers T2 out of band, but not more often than this.
   *  Without a floor, alt-tabbing between two windows would bill an observation
   *  per switch and defeat the whole tiering. */
  observeMinGapMs: number;
  /** T3 cadence. Session end and midnight also trigger it. */
  rollupIntervalMs: number;
  /** A contiguous run of activity ends after this much idle (PRD §4.1). */
  sessionIdleMs: number;
  /** PRD R5. Hitting it pauses T2 and T3 for the rest of the day. It never
   *  blocks goal inference or a run — those are things the user asked for. */
  dailyCapUsd: number;
  /** Turns off T2/T3 entirely, leaving capture and the typed-goal path. The
   *  honest setting for someone who wants the Operator and not the memory. */
  notesEnabled: boolean;

  // M4 — standby, the allowlists, the budgets, and the providers (PRD §6.6, §8.6, §9.1).
  /** Apps a run may touch when goal inference has not seeded the list. Editable
   *  in Settings; `target_apps` still overrides it per run (PRD §6.1). */
  allowlistApps: string[];
  /** Hostnames, matched on suffix so `notion.so` covers `www.notion.so`. */
  allowlistDomains: string[];
  /** The profile the HUD starts on when inference proposes nothing. Never
   *  `leashless`: §7.1 says buddy never suggests it, and a default is a
   *  suggestion made once and then forgotten. */
  defaultProfile: Exclude<RunProfile, 'leashless'>;
  budgetMaxSteps: number;
  budgetMaxWallClockMs: number;
  budgetMaxCostUsd: number;
  /** How often the standby manager looks for a due wakeup. A poll rather than a
   *  timer per wakeup, because a Mac that sleeps for two hours does not fire the
   *  timers it slept through (PRD §6.6). */
  wakePollMs: number;
  /** Which provider serves T2/T3. Anthropic unless the user changes it. */
  observerProvider: ProviderId;
  /** Which provider answers "what did I do this morning?". */
  qaProvider: ProviderId;
  /** The model id used when `openai` is selected. */
  openaiModel: string;
  /** OpenAI-compatible endpoint for a local runtime (Ollama's is
   *  http://localhost:11434/v1). */
  localBaseUrl: string;
  localModel: string;
}

export interface SecretsStatus {
  encryptionAvailable: boolean;
  anthropic: boolean;
  openai: boolean;
  /** Keys that are stored but will not decrypt — almost always because the app
   *  was re-signed since they were saved. Surfaced so the UI can say what to do
   *  rather than showing a stored key that nothing can read. */
  undecryptable: ('anthropic' | 'openai')[];
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
  leashlessEnabled: false,
  reducedMotion: false,
  observeIntervalMs: 180_000,
  observeMinGapMs: 45_000,
  rollupIntervalMs: 3_600_000,
  sessionIdleMs: 600_000,
  dailyCapUsd: 2.5,
  notesEnabled: true,
  allowlistApps: [
    'com.apple.Safari',
    'com.google.Chrome',
    'com.apple.TextEdit',
    'com.apple.Notes',
    'com.apple.finder',
    'com.microsoft.VSCode',
  ],
  allowlistDomains: [],
  defaultProfile: 'attended',
  budgetMaxSteps: 60,
  budgetMaxWallClockMs: 10 * 60_000,
  budgetMaxCostUsd: 2.0,
  wakePollMs: 15_000,
  observerProvider: 'anthropic',
  qaProvider: 'anthropic',
  openaiModel: 'gpt-5',
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: 'llama3.2-vision',
  exclusions: [
    { label: '1Password', bundleId: 'com.1password.1password', builtin: true, enabled: true },
    { label: '1Password 7', bundleId: 'com.agilebits.onepassword7', builtin: true, enabled: true },
    { label: 'Keychain Access', bundleId: 'com.apple.keychainaccess', builtin: true, enabled: true },
    { label: 'Passwords', bundleId: 'com.apple.Passwords', builtin: true, enabled: true },
    { label: 'Private / Incognito windows', titlePattern: '(Private Browsing|Incognito)', builtin: true, enabled: true },
    // Added after watching buddy observe a real machine: a billing page was on
    // screen, and the observation it produced quoted the card's last four
    // digits back. Nothing was doing anything wrong — §5.2 says plainly that
    // frames go to a model — but a payment page is credential-adjacent in the
    // same way a password manager is, and it is cheap to leave out. Disable it
    // like any other rule if you want buddy to see checkout flows.
    { label: 'Billing and payment pages', titlePattern: '(Billing|Payment|Checkout|Card details|Add a card)', builtin: true, enabled: true },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// M2 — the Operator (PRD §6, §7)
// ─────────────────────────────────────────────────────────────────────────────

/** Decided before the loop starts and immutable for the run. A run cannot
 *  escalate its own permissions (PRD §6.1).
 *
 *  `leashless` is unattended with every gate open — see PRD §7.1. It is off by
 *  default, has to be turned on in Settings before the HUD will even offer it,
 *  and is the one profile where buddy will send, delete, install, spend, and
 *  type credentials without asking anyone. It exists because the user asked for
 *  it to exist, knowing what it is. */
export type RunProfile = 'attended' | 'unattended' | 'leashless';

export const RUN_PROFILES: RunProfile[] = ['attended', 'unattended', 'leashless'];

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

/** What the user said at a confirm gate.
 *
 *  `approve-session` is `approve` plus "and stop asking me about this kind of
 *  action in this app for the rest of the run" — the answer to a task that
 *  sends fifteen Slack messages and would otherwise ask fifteen times. Scoped
 *  to the run, never persisted: a standing grant is config nobody maintains,
 *  which is the thing PRD §6.1 argues against for allowlists. */
export type GateAnswer = 'approve' | 'approve-session' | 'deny' | 'stop';

export interface GuardVerdict {
  decision: Decision;
  class: ActionClass;
  /** One sentence, shown verbatim in the confirm gate and the run log. */
  reason: string;
  /** Which of §7.2's three signals produced this, in descending trust. */
  signal: 'ax-tree' | 'app-domain' | 'keystroke-content' | 'action-kind';
  /** What the action targets, for the gate copy: "the Send button", "notion.so". */
  target: string;
  /** The frontmost app's bundle id at dispatch time. Half of a session grant's
   *  key: approving one Slack message must not pre-approve an email. */
  appKey: string;
  /** The same app in the user's words, for the grant's copy. */
  appName: string;
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
  /** What "allow for the rest of this run" would cover, in the user's words:
   *  "sending in Slack". Shown on the button, because a blanket grant whose
   *  scope is not on its face is a blanket grant people click by accident. */
  sessionScope: string;
  /** How many times this exact grant has already been asked for. A second ask
   *  is what makes "stop asking" worth offering. */
  askedBefore: number;
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
  /** How many times the user touched the keyboard or mouse during the run.
   *  Recorded, never acted on: §7.3 makes stopping an explicit act. */
  humanInputs: number;
  /** Grants the user gave at a gate with "allow for the rest of this run",
   *  in their display form. Shown in the HUD and the run log, because a
   *  confirmation the user stopped seeing should still be visible somewhere. */
  sessionGrants: string[];
  /** How many times this run has come back from standby (PRD §6.6). Zero on a
   *  first attempt. The budgets restart on each resume, so this is what makes
   *  the run row's cumulative steps and cost explicable. */
  resumes: number;
}

export interface StartRunRequest {
  goal: string;
  profile: RunProfile;
  allowlist: Allowlist;
  budgets?: Partial<RunBudgets>;
}

/** PRD §7.3. Touching the keyboard is deliberately not one of these: stopping
 *  a run is always an explicit act. See `killswitch.ts`. */
export type KillSwitch = 'hotkey' | 'sentinel' | 'stop-button';

// ─────────────────────────────────────────────────────────────────────────────
// M3 — the Observer's memory (PRD §4, §5)
// ─────────────────────────────────────────────────────────────────────────────

export type NoteType = 'recap' | 'relation' | 'task';
export type TaskStatus = 'open' | 'blocked' | 'waiting' | 'done';
export type TaskScope = 'session' | 'day' | 'week';
export type RelationKind = 'person' | 'app' | 'product' | 'customer' | 'tool';

/** Which tier of the Observer spent the money. The spend meter is per-tier
 *  because "observation cost ran away" (R5) and "one expensive run" are
 *  different problems with different fixes. */
export type SpendTier = 't2' | 't3' | 'inference' | 'operator' | 'wake-check' | 'qa';

/** An entity T2 saw on screen. Raw material for T3's relation merge — not yet
 *  deduped, and deliberately so: T2 is the cheap tier and should not be asked
 *  to remember what it saw an hour ago. */
export interface ObservedEntity {
  kind: RelationKind;
  name: string;
  /** A handle, email, bundle id, ticket key — whatever makes it identifiable. */
  identifier?: string;
  detail?: string;
}

export interface ObservationRow {
  id: number;
  tsStart: number;
  tsEnd: number;
  summary: string;
  apps: string[];
  entities: ObservedEntity[];
  confidence: number;
  frameIds: number[];
}

export interface NoteRow {
  id: number;
  type: NoteType;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  salience: number;
  sourceObs: number[];
}

export interface RelationRow extends NoteRow {
  type: 'relation';
  kind: RelationKind;
  /** Canonical, normalized. Unique with `kind`. */
  identifier: string;
  displayName: string;
  aliases: string[];
  frequency: number;
  lastSeenAt: number;
}

export interface TaskRow extends NoteRow {
  type: 'task';
  status: TaskStatus;
  scope: TaskScope;
  lastSeenAt: number;
  nextCheckAt: number | null;
  artifacts: string[];
}

export type AnyNote = NoteRow | RelationRow | TaskRow;

/** A frame a note cites. `expired` is the interesting case: the note outlives
 *  the screenshot by design (§5.1), and the UI has to say so rather than
 *  showing a broken image. */
export interface NoteFrameRef {
  id: number;
  ts: number;
  appName: string;
  windowTitle: string;
  path: string | null;
  expired: boolean;
}

export interface NoteDetail {
  note: AnyNote;
  linked: { note: AnyNote; kind: string }[];
  frames: NoteFrameRef[];
  observations: ObservationRow[];
}

export interface NoteSearchHit {
  note: AnyNote;
  /** FTS5 snippet with the match marked by «». */
  snippet: string;
}

/** The live spend picture (PRD R5). One day, because the cap is daily. */
export interface SpendReport {
  day: string;
  total: number;
  byTier: Record<SpendTier, number>;
  calls: number;
  capUsd: number;
  /** True once the cap is hit: T2 and T3 stop until tomorrow or until the cap
   *  is raised. User-initiated work is never blocked by it. */
  capped: boolean;
  /** The seven most recent days, oldest first, for the sparkline. */
  history: { day: string; total: number }[];
}

export interface NotesStats {
  observations: number;
  recaps: number;
  relations: number;
  tasks: number;
  openTasks: number;
  lastObservationAt: number | null;
  lastRollupAt: number | null;
  /** Null when no session is running (idle, paused, or never started). */
  sessionStartedAt: number | null;
}

/** What the HUD shows while goal inference is in flight. The provisional goal
 *  lands in ~200 ms from a local query; the reading takes 8.6 s median and up
 *  to 22 s (PRD §6.7), which is why these are separate phases and not one. */
export type InferencePhase = 'idle' | 'provisional' | 'ready' | 'error';

export interface GoalAlternative {
  goal: string;
  confidence: number;
}

/** The structured reading, mirrored from `prompts/goal-inference.schema.ts`.
 *  Duplicated here because this crosses the IPC boundary and the renderer has
 *  no business importing zod. The two are pinned together by a check. */
export interface GoalReading {
  goal: string;
  confidence: number;
  alternatives: GoalAlternative[];
  evidence: string[];
  already_done: string[];
  first_steps: string[];
  proposed_profile: RunProfile;
  risk_flags: string[];
  target_apps: string[];
  injection_notice: string | null;
}

export interface InferenceState {
  phase: InferencePhase;
  /** Always present from the first ~200 ms: the local guess, then the model's. */
  goal: string | null;
  /** Where the current goal came from, so the HUD can say "still reading…". */
  source: 'task-note' | 'observation' | 'window-title' | 'model' | 'none';
  reading: GoalReading | null;
  error: string | null;
  ms: number | null;
  costUsd: number | null;
  /** Bumped per activation so a stale response cannot overwrite a newer one. */
  requestId: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// M4 — standby, the Timeline, providers, and ask-about-my-day (PRD §6.6, §8.4, §9)
// ─────────────────────────────────────────────────────────────────────────────

/** PRD §9.1. Exactly one of these has `computerUse`, and the UI has to say so
 *  rather than letting someone configure OpenAI and wonder why the hotkey is
 *  greyed out. */
export type ProviderId = 'anthropic' | 'openai' | 'local';

export interface ProviderCapabilities {
  /** `computer_toolset_20260801` and an equivalent. Anthropic only, and this is
   *  not a gap waiting to be filled — there is no equivalent elsewhere. */
  computerUse: boolean;
  /** Images in, which T2, goal inference, and the wake check all require. */
  vision: boolean;
  /** Schema-constrained output. Every tier buddy has depends on it. */
  structuredOutput: boolean;
  /** Cheap enough to run every three minutes all day. */
  cheapBulk: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  /** Whether a key (or, for a local runtime, an endpoint) is configured. */
  configured: boolean;
  /** One sentence for the UI when this provider cannot do something. */
  note: string;
  /** What the provider would actually be asked to run, per role. */
  models: { observe: string; rollup: string; qa: string };
}

/** The state of the Operator's availability, so Settings and the HUD say the
 *  same thing `orchestrator.start()` would throw (PRD §9.1). */
export interface OperatorAvailability {
  available: boolean;
  /** Null when available; otherwise the exact sentence to show the user. */
  reason: string | null;
}

/** A scheduled standby check (PRD §6.6), as the UI sees it. */
export interface WakeupView {
  id: number;
  runId: number;
  goal: string;
  fireAt: number;
  condition: string;
  intervalS: number;
  attempts: number;
  maxAttempts: number;
  /** The run's status, so a wakeup whose run was deleted or parked is visible
   *  as such rather than as a pending check that will never resolve. */
  runStatus: RunStatus;
}

/** What one cheap check decided. Recorded as a run step so the Run Log shows
 *  the waiting as well as the working (PRD §8.5). */
export interface WakeCheckResult {
  met: boolean;
  why: string;
  costUsd: number;
  ms: number;
}

/** A day in the Timeline (PRD §8.4). */
export interface TimelineDay {
  /** `YYYY-MM-DD`, local time — the same key the frame vault's directories use. */
  day: string;
  frames: number;
  bytes: number;
  /** When the newest frame of this day expires. The countdown §8.4 asks for. */
  expiresAt: number;
  apps: { bundleId: string; appName: string; count: number }[];
}

/** An answer to "what did I do this morning?" (PRD §9, ask-about-my-day).
 *  v1 is FTS5 + the notes into context; swapping in RAG is a `NoteSearch`
 *  implementation change and nothing else. */
export interface DayAnswer {
  question: string;
  answer: string;
  /** The notes the answer drew on, so it can be checked rather than believed. */
  cited: { id: number; type: NoteType; title: string }[];
  costUsd: number;
  ms: number;
  provider: ProviderId;
  model: string;
}
