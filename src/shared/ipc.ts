import type {
  AppState,
  CaptureStats,
  DisplayInfo,
  FrameRow,
  LogEntry,
  Permissions,
  SecretsStatus,
  Settings,
  SidecarStatus,
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

  // main → renderer (send)
  onStats: 'buddy:stats',
  onFrame: 'buddy:frame',
  onPermissions: 'buddy:permissions',
  onSidecar: 'buddy:sidecar',
  onSettings: 'buddy:settings',
  onState: 'buddy:state',
  onLog: 'buddy:log',
  hudShown: 'hud:shown',
  hudHidden: 'hud:hidden',
} as const;

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

  onStats(fn: (s: CaptureStats) => void): () => void;
  onFrame(fn: (f: FrameRow) => void): () => void;
  onPermissions(fn: (p: Permissions) => void): () => void;
  onSidecar(fn: (s: SidecarStatus) => void): () => void;
  onSettings(fn: (s: Settings) => void): () => void;
  onState(fn: (s: AppState) => void): () => void;
  onLog(fn: (e: LogEntry) => void): () => void;
  onHudShown(fn: () => void): () => void;
  onHudHidden(fn: () => void): () => void;
}
