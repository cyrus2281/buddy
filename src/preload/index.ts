import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CH, type BuddyApi } from '../shared/ipc.js';

/// The only bridge between the renderer and anything privileged.
/// `contextIsolation` is on, so this explicit surface is the whole API — the
/// renderer gets no `require`, no `ipcRenderer`, and no ambient node.

function subscribe<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: BuddyApi = {
  getSnapshot: () => ipcRenderer.invoke(CH.getSnapshot),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(CH.updateSettings, patch),
  getPermissions: () => ipcRenderer.invoke(CH.getPermissions),
  requestPermission: (kind) => ipcRenderer.invoke(CH.requestPermission, kind),
  openPermissionSettings: (kind) => ipcRenderer.invoke(CH.openPermissionSettings, kind),
  getStats: () => ipcRenderer.invoke(CH.getStats),
  getRecentFrames: (limit) => ipcRenderer.invoke(CH.getRecentFrames, limit),
  setSecret: (name, value) => ipcRenderer.invoke(CH.setSecret, name, value),
  clearSecret: (name) => ipcRenderer.invoke(CH.clearSecret, name),
  getSecretsStatus: () => ipcRenderer.invoke(CH.getSecretsStatus),
  setPaused: (paused) => ipcRenderer.invoke(CH.setPaused, paused),
  purgeNow: () => ipcRenderer.invoke(CH.purgeNow),
  purgeAll: () => ipcRenderer.invoke(CH.purgeAll),
  restartSidecar: () => ipcRenderer.invoke(CH.restartSidecar),
  getLogs: (limit) => ipcRenderer.invoke(CH.getLogs, limit),
  hideHud: () => ipcRenderer.invoke(CH.hideHud),
  openHome: () => ipcRenderer.invoke(CH.openHome),
  revealFrames: () => ipcRenderer.invoke(CH.revealFrames),

  startRun: (req) => ipcRenderer.invoke(CH.startRun, req),
  stopRun: () => ipcRenderer.invoke(CH.stopRun),
  resolveGate: (answer) => ipcRenderer.invoke(CH.resolveGate, answer),
  getActiveRun: () => ipcRenderer.invoke(CH.getActiveRun),
  getRuns: (limit) => ipcRenderer.invoke(CH.getRuns, limit),
  getRunSteps: (runId) => ipcRenderer.invoke(CH.getRunSteps, runId),
  deleteRun: (runId) => ipcRenderer.invoke(CH.deleteRun, runId),
  readFrame: (path) => ipcRenderer.invoke(CH.readFrame, path),
  armHud: () => ipcRenderer.invoke(CH.armHud),
  hudResize: (height) => ipcRenderer.invoke(CH.hudResize, height),
  cancelArm: () => ipcRenderer.invoke(CH.cancelArm),

  onStats: (fn) => subscribe(CH.onStats, fn),
  onFrame: (fn) => subscribe(CH.onFrame, fn),
  onFramesPurged: (fn) => subscribe(CH.onFramesPurged, fn),
  onPermissions: (fn) => subscribe(CH.onPermissions, fn),
  onSidecar: (fn) => subscribe(CH.onSidecar, fn),
  onSettings: (fn) => subscribe(CH.onSettings, fn),
  onState: (fn) => subscribe(CH.onState, fn),
  onLog: (fn) => subscribe(CH.onLog, fn),
  onHotkeyIssues: (fn) => subscribe(CH.onHotkeyIssues, fn),
  onRun: (fn) => subscribe(CH.onRun, fn),
  onRunStep: (fn) => subscribe(CH.onRunStep, fn),
  onGate: (fn) => subscribe(CH.onGate, fn),
  onNarration: (fn) => subscribe(CH.onNarration, fn),
  onHudShown: (fn) => subscribe(CH.hudShown, fn),
  onHudHidden: (fn) => subscribe(CH.hudHidden, fn),
};

contextBridge.exposeInMainWorld('buddy', api);
