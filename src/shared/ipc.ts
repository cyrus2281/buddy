import type {
  Allowlist,
  AnyNote,
  AppState,
  CaptureStats,
  DayAnswer,
  DisplayInfo,
  FactKind,
  FactView,
  MemoryHit,
  MemoryOverview,
  TeachResult,
  FrameRow,
  GateAnswer,
  GhostIntent,
  InferenceState,
  LogEntry,
  NoteDetail,
  NoteSearchHit,
  NoteType,
  NotesStats,
  ObservationRow,
  OperatorAvailability,
  PendingGate,
  Permissions,
  ProviderStatus,
  ProviderTestResult,
  ProviderId,
  RunBudgets,
  RunStep,
  RunView,
  SecretsStatus,
  Settings,
  SidecarStatus,
  SpendReport,
  StartRunRequest,
  TaskScope,
  TaskStatus,
  TimelineDay,
  VoiceCommand,
  VoiceStatus,
  WakeupView,
} from './types.js';

import type { IslandNotice, IslandPlacement } from './island.js';
import type { RestoreItem, RestorePlan } from './workspace.js';
import type { TrustCluster } from './trust.js';

/// The IPC contract, written once and imported by main, preload, and renderer.
/// Channel names live here as constants so a typo is a compile error rather
/// than a listener that never fires.

export const CH = {
  // renderer → main (invoke)
  getSnapshot: 'buddy:getSnapshot',
  getSettings: 'buddy:getSettings',
  updateSettings: 'buddy:updateSettings',
  getPermissions: 'buddy:getPermissions',
  requestPermission: 'buddy:requestPermission',
  openPermissionSettings: 'buddy:openPermissionSettings',
  getStats: 'buddy:getStats',
  getRecentFrames: 'buddy:getRecentFrames',
  setSecret: 'buddy:setSecret',
  clearSecret: 'buddy:clearSecret',
  getSecretsStatus: 'buddy:getSecretsStatus',
  setPaused: 'buddy:setPaused',
  purgeNow: 'buddy:purgeNow',
  purgeAll: 'buddy:purgeAll',
  restartSidecar: 'buddy:restartSidecar',
  getLogs: 'buddy:getLogs',
  hideHud: 'buddy:hideHud',
  openHome: 'buddy:openHome',
  revealFrames: 'buddy:revealFrames',

  // M2 — the Operator
  startRun: 'buddy:startRun',
  stopRun: 'buddy:stopRun',
  resolveGate: 'buddy:resolveGate',
  getActiveRun: 'buddy:getActiveRun',
  getRuns: 'buddy:getRuns',
  getRunSteps: 'buddy:getRunSteps',
  deleteRun: 'buddy:deleteRun',
  readFrame: 'buddy:readFrame',
  armHud: 'buddy:armHud',
  hudResize: 'buddy:hudResize',
  cancelArm: 'buddy:cancelArm',

  // M3 — the memory
  getNotes: 'buddy:getNotes',
  searchNotes: 'buddy:searchNotes',
  getNoteDetail: 'buddy:getNoteDetail',
  updateNote: 'buddy:updateNote',
  deleteNote: 'buddy:deleteNote',
  setTaskStatus: 'buddy:setTaskStatus',
  setTaskScope: 'buddy:setTaskScope',
  getNotesStats: 'buddy:getNotesStats',
  getTodayRecap: 'buddy:getTodayRecap',
  getOpenTasks: 'buddy:getOpenTasks',
  getObservations: 'buddy:getObservations',
  getSpend: 'buddy:getSpend',
  resetSpend: 'buddy:resetSpend',
  observeNow: 'buddy:observeNow',
  rollupNow: 'buddy:rollupNow',
  getInference: 'buddy:getInference',
  activate: 'buddy:activate',
  readVaultFrame: 'buddy:readVaultFrame',

  // M4 — standby, the Timeline, providers, and ask-about-my-day
  getWakeups: 'buddy:getWakeups',
  cancelWakeup: 'buddy:cancelWakeup',
  checkWakeupsNow: 'buddy:checkWakeupsNow',
  getTimelineDays: 'buddy:getTimelineDays',
  getFramesForDay: 'buddy:getFramesForDay',
  deleteDay: 'buddy:deleteDay',
  askAboutMyDay: 'buddy:askAboutMyDay',
  getProviders: 'buddy:getProviders',
  testProvider: 'buddy:testProvider',

  // M5 — buddy learns you
  getMemory: 'buddy:getMemory',
  searchMemory: 'buddy:searchMemory',
  teach: 'buddy:teach',
  confirmFact: 'buddy:confirmFact',
  rejectFact: 'buddy:rejectFact',
  restoreFact: 'buddy:restoreFact',
  editFact: 'buddy:editFact',
  forgetFact: 'buddy:forgetFact',
  forgetLearned: 'buddy:forgetLearned',
  rebuildMemoryIndex: 'buddy:rebuildMemoryIndex',

  // "Where was I?" and shadow mode
  getRestorePlan: 'buddy:getRestorePlan',
  restoreWorkspace: 'buddy:restoreWorkspace',
  forgetWorkspace: 'buddy:forgetWorkspace',
  getTrust: 'buddy:getTrust',

  // The island and the ghost cursor
  setIslandInteractive: 'buddy:setIslandInteractive',
  getIsland: 'buddy:getIsland',
  showHud: 'buddy:showHud',
  islandAction: 'buddy:islandAction',

  // Voice — "hey buddy"
  getVoiceStatus: 'buddy:getVoiceStatus',
  requestVoicePermission: 'buddy:requestVoicePermission',
  openVoicePermissionSettings: 'buddy:openVoicePermissionSettings',

  // main → renderer (send)
  onStats: 'buddy:stats',
  onFrame: 'buddy:frame',
  onFramesPurged: 'buddy:framesPurged',
  onPermissions: 'buddy:permissions',
  onSidecar: 'buddy:sidecar',
  onSettings: 'buddy:settings',
  onState: 'buddy:state',
  onLog: 'buddy:log',
  onHotkeyIssues: 'buddy:hotkeyIssues',
  onRun: 'buddy:run',
  onRunStep: 'buddy:runStep',
  onGate: 'buddy:gate',
  onNarration: 'buddy:narration',
  onInference: 'buddy:inference',
  onNotesStats: 'buddy:notesStats',
  onSpend: 'buddy:spend',
  onNotesChanged: 'buddy:notesChanged',
  onWakeups: 'buddy:wakeups',
  onVoice: 'buddy:voice',
  onVoiceCommand: 'buddy:voiceCommand',
  onMemoryChanged: 'buddy:memoryChanged',
  onWorkspace: 'buddy:workspace',
  onIntent: 'buddy:intent',
  onIslandPlacement: 'buddy:islandPlacement',
  onIslandNotice: 'buddy:islandNotice',
  hudShown: 'hud:shown',
  hudHidden: 'hud:hidden',
} as const;

export interface RunSummary {
  id: number;
  goal: string;
  profile: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  steps: number;
  costUsd: number;
  outcome: unknown;
  handsOff: boolean;
}

/** What a purge removed. Mirrors the main process's `PurgeReport`, declared
 *  here so the renderer never imports across the main-process boundary. */
export interface PurgeSummary {
  expiredFrames: number;
  orphanFiles: number;
  emptyDirs: number;
  staleStaging: number;
  ranAt: number;
}

/** Everything the renderer needs on mount, in one round trip. */
export interface Snapshot {
  state: AppState;
  settings: Settings;
  permissions: Permissions;
  sidecar: SidecarStatus;
  stats: CaptureStats;
  secrets: SecretsStatus;
  displays: DisplayInfo[];
  version: string;
  framesDir: string;
  /** Non-null when a display needs a coordinate scale other than 1.0 — §6.2's
   *  startup assertion, surfaced in the UI rather than only in a log. */
  scaleWarning: string | null;
  /** The live run, when one is going. The HUD opens straight into it rather
   *  than showing an activation prompt over a run in progress. */
  activeRun: RunView | null;
  /** Hotkeys that would not register — another app owns the combination, or the
   *  stored accelerator is not one Electron accepts. Surfaced rather than
   *  logged, because one of these is a kill switch (PRD §7.3). */
  hotkeyIssues: { label: string; accelerator: string }[];
  defaultBudgets: RunBudgets;
  defaultAllowlist: Allowlist;
  /** The live activation reading, so a HUD opened over one in flight shows it
   *  rather than an empty prompt. */
  inference: InferenceState;
  notesStats: NotesStats;
  spend: SpendReport;
  /** Pending standby checks (PRD §6.6), so a window opened after a restart
   *  shows what buddy is still waiting for rather than nothing. */
  wakeups: WakeupView[];
  /** §9.1's matrix, and whether the hotkey can actually run something. Carried
   *  in the snapshot so the UI never has to guess at capability. */
  providers: ProviderStatus[];
  operator: OperatorAvailability;
  /** Whether buddy is listening for "hey buddy", and if it should be and is
   *  not, why. */
  voice: VoiceStatus;
}

export interface BuddyApi {
  getSnapshot(): Promise<Snapshot>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  getPermissions(): Promise<Permissions>;
  requestPermission(kind: 'screenRecording' | 'accessibility'): Promise<Permissions>;
  openPermissionSettings(kind: 'screenRecording' | 'accessibility'): Promise<void>;
  getStats(): Promise<CaptureStats>;
  getRecentFrames(limit?: number): Promise<FrameRow[]>;
  setSecret(name: 'anthropic' | 'openai', value: string): Promise<SecretsStatus>;
  clearSecret(name: 'anthropic' | 'openai'): Promise<SecretsStatus>;
  getSecretsStatus(): Promise<SecretsStatus>;
  setPaused(paused: boolean): Promise<Settings>;
  purgeNow(): Promise<{ expiredFrames: number; orphanFiles: number }>;
  purgeAll(): Promise<{ expiredFrames: number }>;
  restartSidecar(): Promise<SidecarStatus>;
  getLogs(limit?: number): Promise<LogEntry[]>;
  hideHud(): Promise<void>;
  openHome(): Promise<void>;
  revealFrames(): Promise<void>;

  startRun(req: StartRunRequest): Promise<RunView>;
  stopRun(): Promise<boolean>;
  resolveGate(answer: GateAnswer): Promise<boolean>;
  getActiveRun(): Promise<RunView | null>;
  getRuns(limit?: number): Promise<RunSummary[]>;
  getRunSteps(runId: number): Promise<RunStep[]>;
  deleteRun(runId: number): Promise<void>;
  /** A run-step screenshot as a data URL. Run frames live outside the frame
   *  vault, and the renderer has no filesystem access. */
  readFrame(path: string): Promise<string | null>;
  armHud(): Promise<void>;
  /** The hotkey path, reachable from the UI too (Home's Activate button).
   *  Returns the provisional reading synchronously; the model's lands on
   *  `onInference`. */
  activate(): Promise<InferenceState>;
  getInference(): Promise<InferenceState>;

  getNotes(type: NoteType, limit?: number): Promise<AnyNote[]>;
  searchNotes(query: string, type?: NoteType): Promise<NoteSearchHit[]>;
  getNoteDetail(id: number): Promise<NoteDetail | null>;
  updateNote(id: number, patch: { title?: string; body?: string }): Promise<AnyNote | null>;
  deleteNote(id: number): Promise<void>;
  setTaskStatus(id: number, status: TaskStatus): Promise<AnyNote | null>;
  setTaskScope(id: number, scope: TaskScope): Promise<AnyNote | null>;
  getNotesStats(): Promise<NotesStats>;
  getTodayRecap(): Promise<AnyNote | null>;
  getOpenTasks(): Promise<AnyNote[]>;
  getObservations(limit?: number): Promise<ObservationRow[]>;
  getSpend(): Promise<SpendReport>;
  resetSpend(): Promise<SpendReport>;
  /** Settings' "observe now" / "roll up now": the tiers are invisible by
   *  design, and a user who cannot make one happen cannot tell whether it works. */
  observeNow(): Promise<boolean>;
  rollupNow(): Promise<boolean>;
  /** A vault frame as a data URL, for the note detail view. Separate from
   *  `readFrame` because the two directories have different lifetimes and one
   *  confinement check that covered both would be easy to widen by accident. */
  readVaultFrame(path: string): Promise<string | null>;

  /** PRD §6.6. What buddy is waiting for, and the two things a person can do
   *  about it: stop waiting, or make it look now. */
  getWakeups(): Promise<WakeupView[]>;
  cancelWakeup(id: number): Promise<boolean>;
  checkWakeupsNow(): Promise<number>;
  /** PRD §8.4. */
  getTimelineDays(): Promise<TimelineDay[]>;
  getFramesForDay(day: string, bundleId?: string | null): Promise<FrameRow[]>;
  deleteDay(day: string): Promise<number>;
  /** PRD §8.2 / §9: FTS5 over the notes, plus the notes, into context. */
  askAboutMyDay(question: string): Promise<DayAnswer>;
  getProviders(): Promise<{ providers: ProviderStatus[]; operator: OperatorAvailability }>;
  /** Settings' Test button: one tiny real call per model id, through the
   *  configured host and key, with any failure explained. Metered. */
  testProvider(id: ProviderId): Promise<ProviderTestResult>;

  /** M5. Everything the "You" screen shows, in one round trip. */
  getMemory(): Promise<MemoryOverview>;
  /** Keywords and meaning, across every kind of memory. */
  searchMemory(query: string): Promise<MemoryHit[]>;
  /** "Remember that …" from the Ask box. */
  teach(text: string): Promise<TeachResult>;
  confirmFact(id: number): Promise<FactView | null>;
  /** "That's wrong." Kept, so buddy never learns it again. */
  rejectFact(id: number): Promise<FactView | null>;
  restoreFact(id: number): Promise<FactView | null>;
  editFact(id: number, patch: { statement?: string; kind?: FactKind }): Promise<FactView | null>;
  /** Gone, including from the list of things not to re-learn. */
  forgetFact(id: number): Promise<void>;
  /** Every fact, run episode and hour of app time. Notes are untouched. */
  forgetLearned(): Promise<void>;
  rebuildMemoryIndex(): Promise<void>;

  getVoiceStatus(): Promise<VoiceStatus>;
  /** Raises the system prompt where macOS still allows one, then re-checks. */
  requestVoicePermission(kind: 'microphone' | 'speech'): Promise<VoiceStatus>;
  openVoicePermissionSettings(kind: 'microphone' | 'speech'): Promise<void>;
  /** The HUD measures its own content and asks for the height; a fixed window
   *  would either clip the live feed or float a pill in a 420px void. */
  hudResize(height: number): Promise<void>;
  /** The island, as the pointer enters or leaves the shape it draws: it is
   *  click-through everywhere else. */
  /** What buddy would open to put your last arrangement back, against what is
   *  open now. */
  getRestorePlan(): Promise<RestorePlan>;
  /** Open them. Only the items that are not already there. */
  restoreWorkspace(items: RestoreItem[]): Promise<{ opened: number; failed: { label: string; why: string }[] }>;
  /** Forget every arrangement buddy has recorded. */
  forgetWorkspace(): Promise<void>;
  /** Shadow mode: every kind of task buddy has done, and how often you took
   *  its read. */
  getTrust(): Promise<TrustCluster[]>;
  setIslandInteractive(on: boolean): Promise<void>;
  /** Where the island is and any notice it is holding, pulled on mount: a push
   *  sent at `did-finish-load` can arrive before React has subscribed. */
  getIsland(): Promise<{ placement: IslandPlacement | null; notice: IslandNotice | null }>;
  /** Open the HUD with focus — from a click on the island, which is the person
   *  asking to see it. */
  showHud(): Promise<void>;
  /** A notice's button, by name. */
  islandAction(action: string): Promise<void>;
  /** A new snapshot, a restore, or a forget: anything showing the arrangement
   *  should re-read it. */
  onWorkspace(fn: () => void): () => void;
  onIntent(fn: (i: GhostIntent) => void): () => void;
  onIslandPlacement(fn: (p: IslandPlacement) => void): () => void;
  onIslandNotice(fn: (n: IslandNotice | null) => void): () => void;
  cancelArm(): Promise<void>;

  onStats(fn: (s: CaptureStats) => void): () => void;
  onFrame(fn: (f: FrameRow) => void): () => void;
  /** Fires after any retention sweep or manual purge, so a view holding a list
   *  of frames knows its thumbnails now point at unlinked files. */
  onFramesPurged(fn: (r: PurgeSummary) => void): () => void;
  onPermissions(fn: (p: Permissions) => void): () => void;
  onSidecar(fn: (s: SidecarStatus) => void): () => void;
  onSettings(fn: (s: Settings) => void): () => void;
  onState(fn: (s: AppState) => void): () => void;
  onLog(fn: (e: LogEntry) => void): () => void;
  onHotkeyIssues(fn: (i: { label: string; accelerator: string }[]) => void): () => void;
  onRun(fn: (v: RunView) => void): () => void;
  onRunStep(fn: (s: RunStep) => void): () => void;
  onGate(fn: (g: PendingGate) => void): () => void;
  onNarration(fn: (n: { runId: number; text: string }) => void): () => void;
  onInference(fn: (s: InferenceState) => void): () => void;
  onNotesStats(fn: (s: NotesStats) => void): () => void;
  onSpend(fn: (s: SpendReport) => void): () => void;
  onNotesChanged(fn: () => void): () => void;
  onWakeups(fn: (w: WakeupView[]) => void): () => void;
  onVoice(fn: (v: VoiceStatus) => void): () => void;
  /** A go-ahead or a dismissal heard while the HUD was up. The HUD decides
   *  what it means (see `shared/voice.ts`). */
  onVoiceCommand(fn: (c: VoiceCommand) => void): () => void;
  /** Something the "You" screen shows changed: a fact learned, a run
   *  recorded, the index caught up. */
  onMemoryChanged(fn: () => void): () => void;
  onHudShown(fn: () => void): () => void;
  onHudHidden(fn: () => void): () => void;
}
