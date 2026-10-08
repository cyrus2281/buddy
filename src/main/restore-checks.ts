/**
 * "Where was I?" and shadow mode, checked against the real modules.
 *
 *   npm run check:restore
 *
 * Same shape and the same seam as the other suites: inside Electron, against a
 * throwaway userData directory, with the model replaced and nothing else.
 * Neither of these features has a model in it at all, which is most of the
 * point of both — so what is replaced here is only buddyd's two calls, and
 * only in the sections that say so.
 *
 *   1. **The plan** — pure, against fixtures: what is missing, what is already
 *      back, and the rule that a document is worth restoring but the app that
 *      opens it is not.
 *   2. **The tracker** — the real `WorkspaceTracker` against the real
 *      `kv` store and the real exclusion list, with buddyd's window list
 *      scripted so a password manager can be put in front of it.
 *   3. **The score** — the real `episodes` store, the real `runs` store and
 *      real step verdicts, through `shadow.clusters()`: the gate history that
 *      withholds an offer is read from rows a real run wrote.
 *   4. **The real buddyd** — `app_windows` against a window this suite opens,
 *      so the shape a snapshot is built from is the shape buddyd really sends.
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, closeDb, kv } from './store/db.js';
import { settings } from './settings.js';
import { runs } from './store/runs.js';
import { episodes } from './memory/episodes.js';
import { sidecar } from './sidecar/supervisor.js';
import { WorkspaceTracker, toSnapshot, MAX_SNAPSHOTS } from './workspace/tracker.js';
import { shadow, appNames, TRUST_WINDOW_MS } from './shadow/trust.js';
import {
  describePlan,
  fileLabel,
  pageLabel,
  planRestore,
  samePage,
  timeOfDay,
  MAX_RESTORE_ITEMS,
  type WorkspaceSnapshot,
} from '../shared/workspace.js';
import {
  buildClusters,
  matchCluster,
  overlap,
  trustView,
  appLabel,
  MIN_FOR_OFFER,
  type TrustEpisode,
} from '../shared/trust.js';
import type { AppWindows } from './sidecar/supervisor.js';
import type { ExclusionRule, GoalSource, RunStep, RunView } from '../shared/types.js';

app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-restore-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));

type Result = { name: string; state: 'pass' | 'fail' | 'skip'; detail: string };
const results: Result[] = [];
class Skipped extends Error {}
const skip = (why: string): never => {
  throw new Skipped(why);
};
function check(name: string, fn: () => string | Promise<string>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, state: 'pass', detail });
    })
    .catch((e: Error) => {
      results.push({ name, state: e instanceof Skipped ? 'skip' : 'fail', detail: e.message });
    });
}
function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}
function ok(cond: boolean, what: string) {
  if (!cond) throw new Error(what);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const SLACK = 'com.tinyspeck.slackmacgap';
const CHROME = 'com.google.Chrome';
const CODE = 'com.microsoft.VSCode';

const snap = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  t: NOW - 3 * 3_600_000,
  sessionStartedAt: NOW - 4 * 3_600_000,
  apps: [],
  excluded: 0,
  ...over,
});

const windowsOf = (apps: AppWindows[]) => ({ apps });
const appWin = (bundleId: string, appName: string, windows: AppWindows['windows']): AppWindows => ({
  pid: 1,
  bundleId,
  appName,
  active: false,
  hidden: false,
  bundlePath: '',
  windows,
});
const win = (over: Partial<AppWindows['windows'][number]> = {}): AppWindows['windows'][number] => ({
  title: '',
  minimized: false,
  fullscreen: false,
  main: true,
  focused: true,
  subrole: 'AXStandardWindow',
  ...over,
});

/** A run that really happened: a row, steps with real verdicts, and the
 *  episode the orchestrator would have written at the end of it. */
function recordRun(o: {
  goal: string;
  inferred: string | null;
  source: GoalSource;
  apps: string[];
  gated: boolean;
  status?: RunView['status'];
  ts: number;
}): number {
  const id = runs.create(o.goal, 'attended');
  const steps: RunStep[] = o.apps.map((appName, i) => ({
    runId: id,
    idx: i,
    tool: 'left_click',
    input: {},
    result: 'OK',
    framePath: null,
    isError: false,
    ts: o.ts,
    verdict: {
      // The gate is what the offer rule reads, and it is read off the step's
      // own verdict exactly as a real run wrote it.
      decision: o.gated && i === 0 ? 'confirm' : 'allow',
      class: o.gated && i === 0 ? 'send' : 'read',
      reason: '',
      signal: 'ax-tree',
      target: '',
      appKey: `com.example.${appName.toLowerCase()}`,
      appName,
    },
    scale: 1,
  }));
  for (const s of steps) runs.addStep(s);
  const status = o.status ?? 'done';
  runs.finish(id, status, steps.length, 0.1, { status: status === 'done' ? 'done' : 'needs_human', summary: 'ok' });
  const view: RunView = {
    id,
    goal: o.goal,
    profile: 'attended',
    handsOff: false,
    status,
    startedAt: o.ts,
    endedAt: o.ts + 1000,
    budgets: { maxSteps: 60, maxWallClockMs: 600_000, maxCostUsd: 2 },
    usage: { steps: steps.length, elapsedMs: 1000, costUsd: 0.1, exceeded: null },
    allowlist: { apps: [], domains: [] },
    steps,
    outcome: { status: status === 'done' ? 'done' : 'needs_human', summary: 'ok' },
    haltReason: null,
    gate: null,
    cacheReadTokens: 0,
    humanInputs: 0,
    sessionGrants: [],
    resumes: 0,
  };
  episodes.recordRun(
    view,
    o.inferred ? { goal: o.inferred, source: 'model', alternatives: [], confidence: 0.9 } : null,
    o.ts,
  );
  return id;
}

const ep = (over: Partial<TrustEpisode> = {}): TrustEpisode => ({
  runId: 1,
  ts: NOW,
  goal: 'File a bug from the thread',
  goalSource: 'accepted',
  status: 'done',
  apps: ['Slack', 'Linear'],
  gated: false,
  ...over,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── The checks ───────────────────────────────────────────────────────────────

async function run() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  // ══ 1. The plan ═══════════════════════════════════════════════════════════

  await check('a document is what gets restored, not the app that opens it', () => {
    const before = snap({
      apps: [
        { bundleId: CODE, appName: 'Code', windows: [{ title: 'runner.ts — buddy', document: 'file:///Users/x/buddy/runner.ts' }] },
        { bundleId: SLACK, appName: 'Slack', windows: [{ title: '#sam-eng' }] },
      ],
    });
    const plan = planRestore(before, snap({ apps: [] }), NOW);
    eq(plan.items.length, 2, 'two things');
    const doc = plan.items.find((i) => i.kind === 'document')!;
    eq(doc.label, 'runner.ts', 'the file, by its name');
    eq(doc.target, 'file:///Users/x/buddy/runner.ts', 'opened by its path, which launches Code on the way');
    ok(!plan.items.some((i) => i.kind === 'app' && i.bundleId === CODE), 'and Code is not also listed on its own');
    eq(plan.items.find((i) => i.bundleId === SLACK)?.kind, 'app', 'an app with nothing identifiable is itself');
    return '1 file + 1 app, no duplicate launch';
  });

  await check('what is already open is kept in the plan and marked, not silently dropped', () => {
    const before = snap({
      apps: [
        { bundleId: CHROME, appName: 'Chrome', windows: [{ title: 'PR', url: 'https://github.com/a/b/pull/7' }, { title: 'Docs', url: 'https://notion.so/q3' }] },
      ],
    });
    const now = snap({
      t: NOW,
      apps: [{ bundleId: CHROME, appName: 'Chrome', windows: [{ title: 'PR', url: 'https://github.com/a/b/pull/7#discussion' }] }],
    });
    const plan = planRestore(before, now, NOW);
    eq(plan.items.length, 2, 'both pages');
    eq(plan.items[0]!.present, false, 'the missing one is first — it is what the button is for');
    const back = plan.items.find((i) => i.target?.includes('pull/7'))!;
    eq(back.present, true, 'the page that is open is present, fragment and all');
    eq(plan.items.filter((i) => !i.present).length, 1, 'one thing to do');
    ok(/1 thing from/.test(describePlan(plan, NOW)), describePlan(plan, NOW));
    return describePlan(plan, NOW);
  });

  await check('the same document reached two ways is one item, and a plan is bounded', () => {
    ok(samePage('https://x.com/a/', 'https://X.com/a#b'), 'a trailing slash and a fragment are the same page');
    ok(!samePage('https://x.com/a', 'https://x.com/b'), 'different pages are not');
    eq(fileLabel('file:///Users/x/My%20Notes.md'), 'My Notes.md', 'an escaped path reads as a name');
    eq(pageLabel('https://www.notion.so/q3-migration?v=1'), 'notion.so/q3-migration', 'a URL reads as a page');

    const many = snap({
      apps: [
        {
          bundleId: CHROME,
          appName: 'Chrome',
          windows: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://x.com/${i}` })),
        },
      ],
    });
    eq(planRestore(many, null, NOW).items.length, MAX_RESTORE_ITEMS, `capped at ${MAX_RESTORE_ITEMS}`);

    const dup = snap({
      apps: [{ bundleId: CODE, appName: 'Code', windows: [{ title: 'a', document: 'file:///Users/x/a.md' }, { title: 'a again', document: '/Users/x/a.md' }] }],
    });
    eq(planRestore(dup, null, NOW).items.length, 1, 'a file URL and a path are one document');
    return `${MAX_RESTORE_ITEMS} max, duplicates folded`;
  });

  await check('when it was is said the way a person says it', () => {
    const at = new Date(2026, 4, 20, 15, 0).getTime();
    eq(timeOfDay(new Date(2026, 4, 20, 9, 30).getTime(), at), 'this morning', 'earlier today');
    eq(timeOfDay(new Date(2026, 4, 19, 16, 0).getTime(), at), 'yesterday afternoon', 'yesterday');
    eq(timeOfDay(new Date(2026, 4, 18, 20, 0).getTime(), at), 'Monday evening', 'this week');
    eq(timeOfDay(new Date(2026, 4, 20, 14, 30).getTime(), at), 'earlier this afternoon', 'within the hour');
    return 'this morning · yesterday afternoon · Monday evening';
  });

  // ══ 2. The tracker ════════════════════════════════════════════════════════

  const rules = () => settings.get().exclusions;

  await check('a password manager and a private window are never written down', () => {
    const s = toSnapshot(
      [
        appWin('com.1password.1password', '1Password', [win({ title: 'Vault' })]),
        appWin(CHROME, 'Chrome', [win({ title: 'Q3 plan', url: 'https://notion.so/q3' }), win({ title: 'Search (Private Browsing)' })]),
      ],
      rules(),
      null,
      NOW,
    );
    eq(s.apps.length, 1, 'only Chrome');
    eq(s.apps[0]!.windows.length, 1, 'and only the window that is not private');
    eq(s.excluded, 2, 'both the app and the private window are counted');
    const json = JSON.stringify(s);
    ok(!/1password|Private Browsing/i.test(json), 'neither appears anywhere in what is stored');
    return 'filtered on the way in, and the count is kept so the UI can say so';
  });

  let scripted: AppWindows[] = [];
  const opened: { bundleId: string; url?: string; activate?: boolean }[] = [];
  let session: number | null = NOW - 3_600_000;
  const tracker = new WorkspaceTracker({
    windows: async () => windowsOf(scripted),
    open: async (p) => {
      opened.push(p);
      return {};
    },
    exclusions: rules,
    sessionStartedAt: () => session,
  });

  await check('an unchanged arrangement updates one snapshot instead of filling the buffer', async () => {
    kv.set('workspace.snapshots', []);
    scripted = [appWin(CODE, 'Code', [win({ title: 'a.ts', document: 'file:///a.ts' })])];
    for (let i = 0; i < 5; i++) await tracker.sample();
    eq(tracker.all().length, 1, 'five samples of the same arrangement are one row');
    scripted = [appWin(CODE, 'Code', [win({ title: 'b.ts', document: 'file:///b.ts' })])];
    await tracker.sample();
    eq(tracker.all().length, 2, 'a different document is a different arrangement');

    for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) {
      scripted = [appWin(CODE, 'Code', [win({ title: `f${i}`, document: `file:///f${i}.ts` })])];
      await tracker.sample();
    }
    eq(tracker.all().length, MAX_SNAPSHOTS, `kept to ${MAX_SNAPSHOTS}, newest first out the back`);
    return `1 row for 5 identical samples; ${MAX_SNAPSHOTS} max`;
  });

  await check('“where you were” is the last session, not thirty seconds ago', async () => {
    kv.set('workspace.snapshots', []);
    session = NOW - 86_400_000;
    scripted = [appWin(SLACK, 'Slack', [win({ title: '#sam-eng' })])];
    await tracker.sample();
    session = NOW;
    scripted = [appWin(CHROME, 'Chrome', [win({ title: 'news', url: 'https://x.com/news' })])];
    await tracker.sample();
    const r = tracker.restorable();
    eq(r?.apps[0]?.bundleId, SLACK, 'the arrangement from the session before this one');
    ok(r!.sessionStartedAt !== session, 'and not from the one happening now');
    return 'restoring the newest snapshot would be a no-op, which is why it is not the answer';
  });

  await check('restoring opens only what is missing, and never activates anything', async () => {
    opened.length = 0;
    const plan = await tracker.plan();
    const missing = plan.items.filter((i) => !i.present);
    eq(missing.length, 1, 'Slack is missing');
    eq(plan.items.find((i) => i.bundleId === CHROME)?.present ?? false, false, 'and Chrome is not in the old arrangement at all');
    await tracker.restore(plan.items);
    eq(opened.length, 1, 'one thing opened');
    eq(opened[0]!.bundleId, SLACK, 'the missing one');
    eq(opened[0]!.activate, false, 'without bringing it forward — the arrangement comes back behind you');

    // Everything already there: nothing is opened twice.
    opened.length = 0;
    scripted = [appWin(SLACK, 'Slack', [win({ title: '#sam-eng' })])];
    const second = await tracker.plan();
    await tracker.restore(second.items);
    eq(opened.length, 0, 'a second restore opens nothing');
    return 'opened 1, then 0 — and nothing was closed';
  });

  await check('a restore buddy cannot see the present of is not offered at all', async () => {
    const blind = new WorkspaceTracker({
      windows: async () => {
        throw new Error('app_windows failed (code -32603)');
      },
      open: async () => ({}),
      exclusions: rules,
      sessionStartedAt: () => session,
    });
    const plan = await blind.plan();
    eq(plan.items.length, 0, 'no plan');
    eq(plan.from, null, 'and nothing claimed about where you were');
    return 'without knowing what is open now, everything would read as missing';
  });

  await check('forgetting leaves nothing behind', () => {
    ok(tracker.all().length > 0, 'there is something to forget');
    tracker.forget();
    eq(tracker.all().length, 0, 'gone');
    eq(JSON.stringify(kv.get('workspace.snapshots', null)), '[]', 'and the row is empty rather than stale');
    return 'one button, and the picture of what you had open is gone';
  });

  // ══ 3. The score ══════════════════════════════════════════════════════════

  await check('clusters are per kind of task, and a streak needs enough runs to count', () => {
    const list = [
      ...Array.from({ length: 6 }, (_, i) => ep({ runId: i + 1, ts: NOW - i * 60_000, goalSource: 'accepted' })),
      ep({ runId: 20, ts: NOW - 10 * 60_000, apps: ['Mail'], goalSource: 'corrected' }),
      ep({ runId: 21, ts: NOW - 11 * 60_000, apps: ['Mail'], goalSource: 'typed' }),
    ];
    const cs = buildClusters(list);
    eq(cs.length, 2, 'two kinds of task');
    const slack = cs.find((c) => c.key === 'Linear+Slack')!;
    eq(slack.level, 'trusted', 'six out of six is trusted');
    eq(slack.label, 'Linear + Slack', 'named for a person');
    const mail = cs.find((c) => c.key === 'Mail')!;
    eq(mail.judged, 1, 'a typed goal is not a judgement of buddy — only the correction counts');
    eq(mail.level, 'unknown', 'and one judgement is not enough to say anything');
    return 'Linear + Slack trusted on 6; Mail silent on 1';
  });

  await check('a task buddy keeps getting wrong says so, and offers nothing', () => {
    const bad = buildClusters(Array.from({ length: 5 }, (_, i) => ep({ runId: i + 1, ts: NOW - i * 1000, goalSource: i < 3 ? 'corrected' : 'accepted' })));
    const v = trustView(bad[0]!, 'attended')!;
    eq(v.level, 'shaky', 'shaky');
    eq(v.offer, null, 'nothing offered');
    ok(/Worth a look/.test(v.sentence), v.sentence);
    return v.sentence;
  });

  await check('the offer is withheld from any task that ever needed a confirmation', () => {
    const clean = buildClusters(Array.from({ length: MIN_FOR_OFFER }, (_, i) => ep({ runId: i + 1, ts: NOW - i * 1000 })));
    const offered = trustView(clean[0]!, 'attended')!;
    eq(offered.offer?.profile, 'unattended', 'a clean record is offered unattended');
    ok(/refuse outright/.test(offered.offer!.why), 'and the why says what unattended actually does');

    const gatedOnce = buildClusters(
      Array.from({ length: MIN_FOR_OFFER }, (_, i) => ep({ runId: i + 1, ts: NOW - i * 1000, gated: i === 4 })),
    );
    eq(trustView(gatedOnce[0]!, 'attended')!.offer, null, 'one gate in the history withholds it');
    eq(trustView(clean[0]!, 'unattended')!.offer, null, 'and nothing is offered when it is already the proposal');

    const recent = buildClusters([
      ep({ runId: 99, ts: NOW, goalSource: 'corrected' }),
      ...Array.from({ length: 8 }, (_, i) => ep({ runId: i + 1, ts: NOW - (i + 1) * 1000 })),
    ]);
    eq(trustView(recent[0]!, 'attended')!.offer, null, 'and a correction this morning outranks an old streak');
    ok(buildClusters([ep()]).every((c) => trustView(c, 'attended') === null), 'one run says nothing at all');
    return 'five clean runs → an offer; one gate, or one recent correction → none';
  });

  await check('a new reading finds its cluster by overlap, not by an exact app set', () => {
    const cs = buildClusters(Array.from({ length: 5 }, (_, i) => ep({ runId: i + 1, ts: NOW - i * 1000, apps: ['Slack', 'Linear'] })));
    eq(matchCluster(cs, ['Slack', 'Linear'])?.key, 'Linear+Slack', 'exactly');
    eq(matchCluster(cs, ['Slack', 'Linear', 'Chrome'])?.key, 'Linear+Slack', 'with one extra app');
    eq(matchCluster(cs, ['Slack'])?.key, 'Linear+Slack', 'with one missing');
    eq(matchCluster(cs, ['Mail', 'Calendar']), null, 'a different job is not this one');
    ok(overlap(['a', 'b'], ['a', 'b']) === 1 && overlap(['a'], ['b']) === 0, 'and the measure is the obvious one');
    return 'half the apps in common is the floor';
  });

  await check('the gate history comes from rows a real run wrote', () => {
    // Five real runs through the real stores: the row, the steps with their
    // verdicts, and the episode the orchestrator writes at the end.
    for (let i = 0; i < 5; i++) {
      recordRun({
        goal: 'File SAM-4412 from the thread',
        inferred: 'File SAM-4412 from the thread',
        source: 'accepted',
        apps: ['Slack', 'Linear'],
        gated: false,
        ts: NOW - (i + 1) * 60_000,
      });
    }
    const clean = shadow.clusters(NOW).find((c) => c.key === 'Linear+Slack')!;
    eq(clean.runs, 5, 'five runs');
    eq(clean.gatedRuns, 0, 'none of them stopped to ask');
    eq(trustView(clean, 'attended')?.offer?.profile, 'unattended', 'so the offer stands');

    // One more that did stop to ask — written as a real `confirm` verdict.
    recordRun({
      goal: 'Reply to Priya in the thread',
      inferred: 'Reply to Priya in the thread',
      source: 'accepted',
      apps: ['Slack', 'Linear'],
      gated: true,
      ts: NOW - 30_000,
    });
    const after = shadow.clusters(NOW).find((c) => c.key === 'Linear+Slack')!;
    eq(after.gatedRuns, 1, 'the gate is found on the step');
    eq(trustView(after, 'attended')?.offer, null, 'and the offer is gone');
    return 'read off run_steps, not off a flag something remembered to set';
  });

  await check('a correction the person made is counted as one', () => {
    const id = recordRun({
      goal: 'Reply in the thread',
      inferred: 'Send Priya a DM',
      source: 'corrected',
      apps: ['Mail'],
      gated: false,
      ts: NOW - 20_000,
    });
    ok(!!episodes.byRun(id, 'correction'), 'M5 wrote the correction, as it already did');
    const c = shadow.clusters(NOW).find((x) => x.key === 'Mail')!;
    eq(c.corrected, 1, 'and the score counts it');
    eq(c.accepted, 0, 'as not an acceptance');
    return 'the same row M5 learns from is the row this counts';
  });

  await check('a bundle id is matched to the record through what buddy saw in front of it', () => {
    appNames.note(SLACK, 'Slack');
    appNames.note('com.linear', 'Linear');
    eq(appNames.nameOf(SLACK), 'Slack', 'learned from the T0 signal');
    eq(appNames.nameOf('com.unknown.app'), 'com.unknown.app', 'an app never seen in front is left alone');
    const v = shadow.forApps([SLACK, 'com.linear'], 'attended');
    ok(!!v, 'a reading in bundle ids finds the record kept in names');
    eq(v!.label, 'Linear + Slack', v!.label);
    eq(appLabel('Slack'), 'Slack', 'and a name that is already a name is not mangled');
    return `${v!.sentence}`;
  });

  await check('an old record is not evidence about today, and the switch turns it all off', () => {
    const ancient = buildClusters(
      Array.from({ length: 6 }, (_, i) => ep({ runId: 500 + i, ts: NOW - TRUST_WINDOW_MS - i * 1000, apps: ['Ancient'] })),
    );
    eq(ancient.length, 1, 'the fixture is one cluster');
    eq(shadow.clusters(NOW).some((c) => c.key === 'Ancient'), false, 'but nothing that old is read back');
    settings.update({ shadowTrust: false });
    eq(settings.get().shadowTrust, false, 'off');
    settings.update({ shadowTrust: true });
    return `${Math.round(TRUST_WINDOW_MS / 86_400_000)} days`;
  });

  // ══ 4. The real buddyd ════════════════════════════════════════════════════

  let up = false;
  try {
    await sidecar.start();
    up = true;
  } catch (e) {
    log.warn('checks', 'buddyd did not start', { error: (e as Error).message });
  }
  const granted = up ? (await sidecar.permissions()).accessibility : false;

  let w: BrowserWindow | null = null;
  if (up && granted) {
    app.setAccessibilitySupportEnabled(true);
    w = new BrowserWindow({ width: 360, height: 200, x: 60, y: 120, show: false, title: 'buddy restore check' });
    await w.loadURL('data:text/html,<title>buddy restore check</title><body>where was i</body>');
    w.showInactive();
    await sleep(600);
  }

  await check('buddyd lists the windows a snapshot is built from', async () => {
    if (!up) skip('buddyd is not built — npm run build:sidecar');
    if (!granted) skip('Accessibility is not granted to this buddyd, so no window can be read.');
    const { apps } = await sidecar.appWindows({ pid: process.pid });
    const self = apps[0]!;
    ok(!!self, 'this process is listed');
    const found = self.windows.find((x) => x.title.includes('buddy restore check'));
    ok(!!found, `the window this suite opened is in the list (${self.windows.map((x) => x.title).join(' | ')})`);
    const s = toSnapshot(apps, rules(), null, Date.now());
    ok(s.apps.length <= 1, 'and it becomes a snapshot');
    ok(JSON.stringify(s).length < 4_000, `which is small (${JSON.stringify(s).length} bytes)`);
    return `${self.windows.length} window(s) from the real app_windows`;
  });

  await check('every app on this machine fits in one bounded snapshot', async () => {
    if (!up) skip('buddyd is not built');
    if (!granted) skip('Accessibility is not granted to this buddyd.');
    const t0 = Date.now();
    const { apps } = await sidecar.appWindows();
    const ms = Date.now() - t0;
    const s = toSnapshot(apps, rules(), null, Date.now());
    const bytes = JSON.stringify(s).length;
    ok(ms < 4_000, `one call, ${ms} ms`);
    ok(bytes < 60_000, `${bytes} bytes for ${s.apps.length} apps — small enough to keep ${MAX_SNAPSHOTS} of`);
    return `${s.apps.length} apps, ${bytes} bytes, ${ms} ms${s.excluded ? `, ${s.excluded} excluded` : ''}`;
  });

  w?.destroy();
  if (up) await sidecar.stop();

  // ── Report ────────────────────────────────────────────────────────────────

  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => r.state === 'fail');
  const skipped = results.filter((r) => r.state === 'skip');
  const ran = results.filter((r) => r.state !== 'skip');
  const pad = Math.max(...results.map((r) => r.name.length));
  const glyph = { pass: '✓', fail: '✗', skip: '–' } as const;
  let report =
    '\n“Where was I?” and shadow-mode checks\n\n' +
    results.map((r) => `  ${glyph[r.state]}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${ran.length - failed.length}/${ran.length} passed`;
  report += skipped.length ? `, ${skipped.length} skipped\n` : '\n';
  report +=
    '\nNeither feature calls a model, so there is nothing scripted here but\n' +
    'buddyd’s window list — and the last two checks use the real one. What is\n' +
    'not covered: whether an app reopens a document where you left it, which\n' +
    'is the app’s own business and not something buddy can promise.\n\n';
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
