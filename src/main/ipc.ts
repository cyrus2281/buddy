import { ipcMain, app, shell } from 'electron';
import { CH, type Snapshot } from '../shared/ipc.js';
import { settings } from './settings.js';
import { secrets } from './secrets.js';
import { permissions } from './permissions.js';
import { sidecar } from './sidecar/supervisor.js';
import { retention } from './store/retention.js';
import { frames } from './store/frames.js';
import { paths } from './paths.js';
import { log } from './log.js';
import { broadcast, createHome, hideHud, resizeHud, showHud } from './windows.js';
import { island } from './island.js';
import { operator } from './agent/orchestrator.js';
import { runs } from './store/runs.js';
import fs from 'node:fs';
import path from 'node:path';
import { notes, observations, relations, tasks } from './store/notes.js';
import { timeline } from './store/timeline.js';
import { askAboutMyDay } from './notes/ask.js';
import { memory } from './memory/service.js';
import { semanticNotes } from './memory/recall.js';
import { operatorAvailability, providerStatuses, testProvider } from './providers.js';
import type { NotesEngine } from './notes/engine.js';
import type { Activation } from './agent/activation.js';
import type { StandbyManager } from './agent/standby.js';
import type { VoiceListener } from './voice/listener.js';
import type { WorkspaceTracker } from './workspace/tracker.js';
import { shadow } from './shadow/trust.js';
import type { RestoreItem } from '../shared/workspace.js';
import type { CaptureScheduler } from './capture/scheduler.js';
import {
  type Allowlist,
  type AppState,
  type DisplayInfo,
  type FactKind,
  type NoteSearchHit,
  type NoteType,
  type ProviderId,
  type RunBudgets,
  type StartRunRequest,
  type TaskScope,
  type TaskStatus,
} from '../shared/types.js';

/** The allowlist a run starts from when there is nothing to seed it with —
 *  a typed goal, or an activation whose reading has not landed yet. When a
 *  reading is available, `target_apps` replaces this and the user confirms the
 *  app set in the same keystroke as the goal (PRD §6.1).
 *
 *  M4 made it editable in Settings, so it is read from there rather than being
 *  a constant: §8.6 lists allowlists as a settings surface, and a default list
 *  nobody can change is not one. */
export const defaultAllowlist = (): Allowlist => ({
  apps: [...settings.get().allowlistApps],
  domains: [...settings.get().allowlistDomains],
});

/** Likewise the budgets: §6.5 says all three are configurable, and until M4
 *  they were configurable only by editing `DEFAULT_BUDGETS`. */
export const defaultBudgets = (): RunBudgets => ({
  maxSteps: settings.get().budgetMaxSteps,
  maxWallClockMs: settings.get().budgetMaxWallClockMs,
  maxCostUsd: settings.get().budgetMaxCostUsd,
});

/// Every renderer-reachable operation, registered in one place. Handlers are
/// deliberately thin: they translate and delegate, so the behaviour under test
/// lives in the modules rather than in the IPC layer.

interface Ctx {
  scheduler: CaptureScheduler;
  engine: NotesEngine;
  activation: Activation;
  standby: StandbyManager;
  voice: VoiceListener;
  workspace: WorkspaceTracker;
  getState: () => AppState;
  setState: (s: AppState) => void;
}

let displaysCache: DisplayInfo[] = [];
let scaleWarning: string | null = null;
let hotkeyIssues: { label: string; accelerator: string }[] = [];

/** Set by `bindHotkeys()` after every registration attempt. */
export function setHotkeyIssues(issues: { label: string; accelerator: string }[]) {
  hotkeyIssues = issues;
  broadcast(CH.onHotkeyIssues, issues);
}

/// PRD §6.2 / R3: a startup assertion that logs loudly when the coordinate
/// scale is not 1.0, so a 4K display in "More Space" is a visible caveat rather
/// than clicks landing in the wrong place.
export async function assertCoordinateScale(): Promise<string | null> {
  try {
    const { displays } = await sidecar.displays();
    displaysCache = displays;
    const off = displays.filter((d) => d.modelScale !== 1);
    if (off.length === 0) {
      log.info('displays', 'coordinate scale 1.0 on all displays', {
        displays: displays.map((d) => `${d.width}x${d.height}`),
      });
      scaleWarning = null;
      return null;
    }
    scaleWarning =
      `Coordinate scale is not 1.0 on ${off.length} display(s): ` +
      off.map((d) => `${d.width}x${d.height} → ${d.modelScale.toFixed(4)}`).join(', ') +
      '. The executor must divide model coordinates by this factor.';
    log.warn('displays', scaleWarning, { displays: off });
    return scaleWarning;
  } catch (e) {
    log.warn('displays', 'could not enumerate displays', { error: (e as Error).message });
    return null;
  }
}

export function registerIpc(ctx: Ctx) {
  const snapshot = async (): Promise<Snapshot> => ({
    state: ctx.getState(),
    settings: settings.get(),
    permissions: permissions.current(),
    sidecar: sidecar.status(),
    stats: ctx.scheduler.getStats(),
    secrets: secrets.status(),
    displays: displaysCache,
    version: app.getVersion(),
    framesDir: paths.frames(),
    scaleWarning,
    activeRun: operator.active(),
    hotkeyIssues,
    defaultBudgets: defaultBudgets(),
    defaultAllowlist: defaultAllowlist(),
    inference: ctx.activation.current(),
    notesStats: ctx.engine.stats(),
    spend: ctx.engine.spend.report(),
    wakeups: ctx.standby.pending(),
    providers: providerStatuses(),
    operator: operatorAvailability(),
    voice: ctx.voice.current(),
  });

  ipcMain.handle(CH.getSnapshot, snapshot);
  ipcMain.handle(CH.getSettings, () => settings.get());
  ipcMain.handle(CH.updateSettings, (_e, patch) => settings.update(patch));
  ipcMain.handle(CH.getPermissions, () => permissions.poll());
  ipcMain.handle(CH.requestPermission, (_e, kind) => permissions.request(kind));
  ipcMain.handle(CH.openPermissionSettings, (_e, kind) => permissions.openSettings(kind));
  ipcMain.handle(CH.getStats, () => ctx.scheduler.getStats());
  ipcMain.handle(CH.getRecentFrames, (_e, limit = 50) => frames.recent(limit));
  ipcMain.handle(CH.getSecretsStatus, () => secrets.status());
  ipcMain.handle(CH.getLogs, (_e, limit = 200) => log.recent(limit));

  ipcMain.handle(CH.setSecret, (_e, name, value) => {
    secrets.set(name, value);
    const s = secrets.status();
    broadcast(CH.onSettings, settings.get());
    return s;
  });
  ipcMain.handle(CH.clearSecret, (_e, name) => {
    secrets.clear(name);
    return secrets.status();
  });

  ipcMain.handle(CH.setPaused, (_e, paused: boolean) => {
    const next = settings.update({ paused });
    ctx.setState(paused ? 'PAUSED' : 'OBSERVING');
    return next;
  });

  ipcMain.handle(CH.purgeNow, () => {
    const r = retention.sweep();
    ctx.scheduler.refreshDiskStats();
    return r;
  });
  ipcMain.handle(CH.purgeAll, () => {
    const r = retention.purgeAll();
    ctx.scheduler.refreshDiskStats();
    return r;
  });

  ipcMain.handle(CH.restartSidecar, async () => {
    await sidecar.restartNow();
    await permissions.poll();
    return sidecar.status();
  });

  // ── M2 — the Operator ───────────────────────────────────────────────────

  ipcMain.handle(CH.startRun, async (_e, req: StartRunRequest) => {
    // M5: what the HUD was offering, captured before the run replaces it, so
    // the run's end can say whether the person took buddy's goal or overrode
    // it. The comparison is the most useful thing buddy learns all day.
    memory.expectRun(req.goal, ctx.activation.current());
    ctx.setState('ACTING');
    try {
      const view = await operator.start({
        ...req,
        allowlist: req.allowlist ?? defaultAllowlist(),
        budgets: req.budgets ?? defaultBudgets(),
      });
      // The run's own terminal state decides where the app lands, so a parked
      // run leaves a visible NEEDS_HUMAN rather than quietly resuming.
      ctx.setState(view.status === 'needs_human' ? 'NEEDS_HUMAN' : view.status === 'waiting' ? 'STANDBY' : 'OBSERVING');
      return view;
    } catch (e) {
      ctx.setState('OBSERVING');
      throw e;
    }
  });

  ipcMain.handle(CH.stopRun, () => operator.stop('stop-button'));
  ipcMain.handle(CH.resolveGate, (_e, answer) => operator.resolveGate(answer));
  ipcMain.handle(CH.getActiveRun, () => operator.active());
  ipcMain.handle(CH.getRuns, (_e, limit = 50) => operator.history(limit));
  ipcMain.handle(CH.getRunSteps, (_e, runId: number) => operator.stepsFor(runId));
  ipcMain.handle(CH.deleteRun, (_e, runId: number) => operator.deleteRun(runId));
  ipcMain.handle(CH.armHud, () => ctx.setState('ARMED'));
  ipcMain.handle(CH.hudResize, (_e, height: number) => resizeHud(height));
  // ── "Where was I?" and shadow mode ──────────────────────────────────────

  ipcMain.handle(CH.getRestorePlan, () => ctx.workspace.plan());
  ipcMain.handle(CH.restoreWorkspace, (_e, items: RestoreItem[]) =>
    ctx.workspace.restore(Array.isArray(items) ? items : []),
  );
  ipcMain.handle(CH.forgetWorkspace, () => ctx.workspace.forget());
  ipcMain.handle(CH.getTrust, () => (settings.get().shadowTrust ? shadow.clusters() : []));

  ipcMain.handle(CH.setIslandInteractive, (_e, on: boolean) => island.setInteractive(!!on));
  ipcMain.handle(CH.getIsland, () => island.current());
  ipcMain.handle(CH.showHud, () => showHud());
  ipcMain.handle(CH.islandAction, (_e, action: string) => island.runAction(String(action)));
  ipcMain.handle(CH.cancelArm, () => {
    if (!operator.isRunning()) ctx.setState(ctx.scheduler.isRunning() ? 'OBSERVING' : 'IDLE');
  });

  /** Run-step screenshots live with the run, outside the frame vault, and the
   *  renderer has no filesystem access — so it asks for the bytes. Reads are
   *  confined to the runs directory: a path from the renderer is untrusted
   *  input like any other. */
  ipcMain.handle(CH.readFrame, (_e, p: string) => {
    const root = path.join(paths.root(), 'runs');
    const resolved = path.resolve(p);
    if (!resolved.startsWith(root + path.sep)) {
      log.warn('ipc', 'refused a frame read outside the runs directory', { path: resolved });
      return null;
    }
    try {
      return `data:image/png;base64,${fs.readFileSync(resolved).toString('base64')}`;
    } catch {
      return null;
    }
  });

  // ── M3 — the memory (PRD §4, §5, §8.3) ──────────────────────────────────

  ipcMain.handle(CH.activate, () => ctx.activation.begin());
  ipcMain.handle(CH.getInference, () => ctx.activation.current());

  ipcMain.handle(CH.getNotes, (_e, type: NoteType, limit = 200) => notes.list(type, limit));
  /** Keyword hits first, with their highlighted snippets; then (M5) notes
   *  that match by meaning and share no word with the query, marked as such.
   *  A search box that says "nothing matching" for "lunch" when a note says
   *  "midday break" is the failure this widening is for. */
  ipcMain.handle(CH.searchNotes, (_e, query: string, type?: NoteType): NoteSearchHit[] => {
    const words = notes.search(query, type);
    const seen = new Set(words.map((h) => h.note.id));
    const meaning = semanticNotes(query, type, seen).map((note) => ({
      note,
      snippet: `≈ ${note.body.slice(0, 160)}`,
    }));
    return [...words, ...meaning];
  });
  ipcMain.handle(CH.getNoteDetail, (_e, id: number) => notes.detail(id));
  ipcMain.handle(CH.updateNote, (_e, id: number, patch: { title?: string; body?: string }) => {
    const n = notes.update(id, patch);
    memory.touched();
    broadcast(CH.onNotesChanged, null);
    return n;
  });
  ipcMain.handle(CH.deleteNote, (_e, id: number) => {
    notes.delete(id);
    memory.touched();
    broadcast(CH.onNotesChanged, null);
    broadcast(CH.onNotesStats, ctx.engine.stats());
  });
  ipcMain.handle(CH.setTaskStatus, (_e, id: number, status: TaskStatus) => {
    const t = tasks.setStatus(id, status);
    broadcast(CH.onNotesChanged, null);
    broadcast(CH.onNotesStats, ctx.engine.stats());
    return t;
  });
  ipcMain.handle(CH.setTaskScope, (_e, id: number, scope: TaskScope) => {
    const t = tasks.setScope(id, scope);
    broadcast(CH.onNotesChanged, null);
    return t;
  });
  ipcMain.handle(CH.getNotesStats, () => ctx.engine.stats());
  ipcMain.handle(CH.getOpenTasks, () => tasks.open());
  ipcMain.handle(CH.getObservations, (_e, limit = 50) => observations.recent(limit));
  ipcMain.handle(CH.getTodayRecap, () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return (
      notes
        .list('recap', 50)
        .find((n) => n.updatedAt >= start.getTime()) ?? null
    );
  });
  ipcMain.handle(CH.getSpend, () => ctx.engine.spend.report());
  ipcMain.handle(CH.resetSpend, () => {
    ctx.engine.spend.resetToday();
    return ctx.engine.spend.report();
  });
  ipcMain.handle(CH.observeNow, () => ctx.engine.maybeObserve('manual'));
  ipcMain.handle(CH.rollupNow, () => {
    const now = Date.now();
    return ctx.engine.runRollup('manual', { from: now - 86_400_000, to: now });
  });

  /** The note detail view shows the frames a note came from, while they still
   *  exist. Same confinement rule as `readFrame`, against the vault instead of
   *  the runs directory — two checks rather than one widened one, because the
   *  two directories have different lifetimes and widening is a one-character
   *  mistake. */
  ipcMain.handle(CH.readVaultFrame, (_e, p: string) => {
    const root = paths.frames();
    const resolved = path.resolve(p);
    if (!resolved.startsWith(root + path.sep)) {
      log.warn('ipc', 'refused a frame read outside the vault', { path: resolved });
      return null;
    }
    try {
      return `data:image/png;base64,${fs.readFileSync(resolved).toString('base64')}`;
    } catch {
      // Expired between the list and the read. The UI already knows how to say so.
      return null;
    }
  });

  // ── M4 — standby, the Timeline, providers, Q&A ──────────────────────────

  ipcMain.handle(CH.getWakeups, () => ctx.standby.pending());
  ipcMain.handle(CH.cancelWakeup, (_e, id: number) => {
    const ok = ctx.standby.cancel(id);
    if (ok && ctx.getState() === 'STANDBY') {
      ctx.setState(ctx.scheduler.isRunning() ? 'OBSERVING' : 'IDLE');
    }
    return ok;
  });
  ipcMain.handle(CH.checkWakeupsNow, async () => {
    // Standby is invisible by design — it is a row in a table and a poll. A
    // user who cannot make one happen cannot tell whether it works, which is
    // the same argument as Settings' "observe now".
    //
    // The attempt is *not* skipped. A check the user asked for is still a
    // check: it costs the same fraction of a cent and it answers the same
    // question, and letting this button poll past `max_attempts` by hand would
    // make the limit a suggestion. `makeDue` moves the clock and nothing else;
    // the tick that follows is what spends the attempt.
    for (const w of ctx.standby.pending()) {
      if (w.runStatus === 'waiting') runs.makeDue(w.id, Date.now() - 1);
    }
    return ctx.standby.tick();
  });

  ipcMain.handle(CH.getTimelineDays, () => timeline.days());
  ipcMain.handle(CH.getFramesForDay, (_e, day: string, bundleId?: string | null) =>
    timeline.framesFor(day, bundleId),
  );
  ipcMain.handle(CH.deleteDay, (_e, day: string) => {
    const n = timeline.deleteDay(day);
    ctx.scheduler.refreshDiskStats();
    broadcast(CH.onFramesPurged, {
      expiredFrames: n,
      orphanFiles: 0,
      emptyDirs: 0,
      staleStaging: 0,
      ranAt: Date.now(),
    });
    return n;
  });

  ipcMain.handle(CH.askAboutMyDay, async (_e, question: string) => {
    const answer = await askAboutMyDay(question);
    ctx.engine.spend.record('qa', answer.costUsd);
    return answer;
  });

  ipcMain.handle(CH.getProviders, () => ({
    providers: providerStatuses(),
    operator: operatorAvailability(),
  }));
  ipcMain.handle(CH.testProvider, (_e, id: ProviderId) =>
    testProvider(id, { record: (usd) => ctx.engine.spend.record('test', usd) }),
  );

  // ── M5 — buddy learns you ───────────────────────────────────────────────

  ipcMain.handle(CH.getMemory, () => memory.overview());
  ipcMain.handle(CH.searchMemory, (_e, query: string) => memory.search(query));
  ipcMain.handle(CH.teach, (_e, text: string) => memory.teach(text));
  ipcMain.handle(CH.confirmFact, (_e, id: number) => memory.confirm(id));
  ipcMain.handle(CH.rejectFact, (_e, id: number) => memory.reject(id));
  ipcMain.handle(CH.restoreFact, (_e, id: number) => memory.restore(id));
  ipcMain.handle(CH.editFact, (_e, id: number, patch: { statement?: string; kind?: FactKind }) =>
    memory.edit(id, patch),
  );
  ipcMain.handle(CH.forgetFact, (_e, id: number) => memory.forget(id));
  ipcMain.handle(CH.forgetLearned, () => memory.forgetEverything());
  ipcMain.handle(CH.rebuildMemoryIndex, () => memory.rebuildIndex());
  memory.on('changed', () => broadcast(CH.onMemoryChanged, null));

  // ── Voice ───────────────────────────────────────────────────────────────

  ipcMain.handle(CH.getVoiceStatus, () => ctx.voice.current());
  ipcMain.handle(CH.requestVoicePermission, (_e, kind: 'microphone' | 'speech') => ctx.voice.request(kind));
  ipcMain.handle(CH.openVoicePermissionSettings, (_e, kind: 'microphone' | 'speech') =>
    shell.openExternal(
      kind === 'microphone'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
    ),
  );
  ctx.voice.on('status', (v) => broadcast(CH.onVoice, v));

  ctx.standby.on('change', (w) => broadcast(CH.onWakeups, w));
  ctx.standby.on('checked', () => broadcast(CH.onWakeups, ctx.standby.pending()));
  ctx.standby.on('exhausted', () => broadcast(CH.onWakeups, ctx.standby.pending()));

  ipcMain.handle(CH.hideHud, () => hideHud());
  ipcMain.handle(CH.openHome, () => {
    createHome();
  });
  ipcMain.handle(CH.revealFrames, () => shell.openPath(paths.frames()));

  operator.on('update', (v) => broadcast(CH.onRun, v));
  operator.on('step', (s) => broadcast(CH.onRunStep, s));
  operator.on('gate', (g) => broadcast(CH.onGate, g));
  operator.on('narration', (n) => broadcast(CH.onNarration, n));

  ctx.activation.on('change', (st) => broadcast(CH.onInference, st));
  ctx.engine.on('stats', (st) => broadcast(CH.onNotesStats, st));
  ctx.engine.on('spend', (sp) => broadcast(CH.onSpend, sp));
  ctx.engine.on('observation', () => {
    memory.touched();
    broadcast(CH.onNotesStats, ctx.engine.stats());
  });
  ctx.engine.on('rollup', (r: { learned: unknown }) => {
    memory.touched();
    broadcast(CH.onNotesChanged, null);
    broadcast(CH.onNotesStats, ctx.engine.stats());
    if (r.learned) broadcast(CH.onMemoryChanged, null);
  });

  // A run interrupted by a crash or a quit must not still read as running.
  runs.reconcileOnLaunch();
}
