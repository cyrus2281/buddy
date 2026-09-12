import type {
  Allowlist,
  AppState,
  CaptureStats,
  DisplayInfo,
  FrameRow,
  LogEntry,
  PendingGate,
  Permissions,
  RunBudgets,
  RunStep,
  RunView,
  SecretsStatus,
  Settings,
  SidecarStatus,
  StartRunRequest,
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

  // main → renderer (send)
  onStats: 'buddy:stats',
  onFrame: 'buddy:frame',
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
  resolveGate(answer: 'approve' | 'deny' | 'stop'): Promise<boolean>;
  getActiveRun(): Promise<RunView | null>;
  getRuns(limit?: number): Promise<RunSummary[]>;
  getRunSteps(runId: number): Promise<RunStep[]>;
  deleteRun(runId: number): Promise<void>;
  /** A run-step screenshot as a data URL. Run frames live outside the frame
   *  vault, and the renderer has no filesystem access. */
  readFrame(path: string): Promise<string | null>;
  armHud(): Promise<void>;
  /** The HUD measures its own content and asks for the height; a fixed window
   *  would either clip the live feed or float a pill in a 420px void. */
  hudResize(height: number): Promise<void>;
  cancelArm(): Promise<void>;

  onStats(fn: (s: CaptureStats) => void): () => void;
  onFrame(fn: (f: FrameRow) => void): () => void;
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
  onHudShown(fn: () => void): () => void;
  onHudHidden(fn: () => void): () => void;
}
