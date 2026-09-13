import type {
  Allowlist,
  AnyNote,
  AppState,
  CaptureStats,
  DayAnswer,
  DisplayInfo,
  FrameRow,
  GateAnswer,
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
  WakeupView,
} from './types.js';

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
  /** The HUD measures its own content and asks for the height; a fixed window
   *  would either clip the live feed or float a pill in a 420px void. */
  hudResize(height: number): Promise<void>;
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
  onHudShown(fn: () => void): () => void;
  onHudHidden(fn: () => void): () => void;
}
