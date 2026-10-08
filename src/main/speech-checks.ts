/**
 * Voice replies — buddy saying things out loud. Run against the real modules.
 *
 *   npm run check:speech
 *
 * Three layers:
 *
 *   1. **What it says** — pure. Screen-shaped text turned into sentence-shaped
 *      text, which is most of the difference between a feature people leave on
 *      and one they turn off after a day.
 *   2. **When it says it** — the real `SpeechService` against a scripted
 *      transport, so the room rules, the per-kind switches and the
 *      do-not-listen-to-yourself window are asserted without a speaker.
 *   3. **The real `buddyd`** — the voices this Mac has, and one sentence
 *      actually synthesized, with `force` so it does not depend on what is
 *      plugged in. Nothing is spoken aloud unless BUDDY_SPEAK_ALOUD is set:
 *      a suite that talks to the room is a suite nobody runs twice.
 */
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, closeDb } from './store/db.js';
import { settings } from './settings.js';
import { sidecar } from './sidecar/supervisor.js';
import { SpeechService, MAX_UTTERANCE_MS, SPEECH_ECHO_TAIL_MS, type SpeechTransport } from './voice/speech.js';
import { routeIntent } from './voice/route.js';
import {
  answerUtterance,
  goalUtterance,
  runUtterance,
  speakable,
  MAX_SPOKEN_CHARS,
  SKIP_REASON,
  type SpeakEvent,
  type SpeakStatus,
  type SpeakVoices,
} from '../shared/speech.js';
import { DEFAULT_SETTINGS, type GoalReading, type RunView } from '../shared/types.js';

app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-speech-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));
const ALOUD = !!process.env.BUDDY_SPEAK_ALOUD;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── A scripted synthesizer ───────────────────────────────────────────────────

/** buddyd's speaking surface, scripted: it records what it was asked to say,
 *  and answers with whatever the room is supposed to be. */
class ScriptedSpeech extends EventEmitter implements SpeechTransport {
  said: { text: string; id: number; ourMic?: boolean; headphonesOnly?: boolean; voice?: string; rate?: number }[] = [];
  stops = 0;
  running = true;
  /** What buddyd would refuse with, or null to let it through. */
  skipWith: string | null = null;
  private handlers = new Set<(e: SpeakEvent) => void>();

  isRunning() {
    return this.running;
  }
  async speak(p: { text: string; id: number; ourMic?: boolean; headphonesOnly?: boolean; voice?: string; rate?: number }) {
    if (this.skipWith) return { speaking: false, id: p.id, skipped: this.skipWith };
    this.said.push(p);
    return { speaking: true, id: p.id };
  }
  async speakStop() {
    this.stops++;
    return {};
  }
  async speakStatus(): Promise<SpeakStatus> {
    return { speaking: false, id: 0, voices: 1, output: 'MacBook Pro Speakers', outputIsPrivate: false, micInUse: false };
  }
  async speakVoices(): Promise<SpeakVoices> {
    return { voices: [{ id: 'v1', name: 'Aaron', language: 'en-US', quality: 'default' }], preferred: 'v1', systemDefault: 'v1' };
  }
  onSpeak(fn: (e: SpeakEvent) => void) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  emitEvent(e: SpeakEvent) {
    for (const fn of this.handlers) fn(e);
  }
  last() {
    return this.said[this.said.length - 1];
  }
}

const reading = (over: Partial<GoalReading> = {}): GoalReading => ({
  goal: 'File SAM-4412 from Priya’s thread in #sam-eng',
  confidence: 0.86,
  alternatives: [],
  evidence: [],
  already_done: [],
  first_steps: [],
  proposed_profile: 'attended',
  risk_flags: [],
  target_apps: [],
  injection_notice: null,
  ...over,
});

const runView = (over: Partial<RunView> = {}): RunView =>
  ({
    id: 1,
    goal: 'Reply to Priya',
    status: 'done',
    outcome: { status: 'done', summary: 'Replied in the thread.' },
    haltReason: null,
    gate: null,
    ...over,
  }) as RunView;

// ── The checks ───────────────────────────────────────────────────────────────

async function run() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  // ══ 1. What it says ═══════════════════════════════════════════════════════

  await check('screen text is turned into something worth hearing', () => {
    eq(speakable('File SAM-4412 in #sam-eng'), 'File SAM 4412 in the sam-eng channel', 'a ticket key and a channel');
    eq(speakable('Ask @priya about it'), 'Ask priya about it', 'an at-mention is a person');
    eq(speakable('See https://github.com/a/b/pull/7 for the diff'), 'See a link for the diff', 'a URL is forty seconds of punctuation');
    eq(speakable('Open `runner.ts` and **fix** it'), 'Open runner.ts and fix it', 'markdown is for eyes');
    eq(speakable('You filed three bugs [n12, n14]'), 'You filed three bugs', 'citation chips are not words');
    eq(speakable('Edit ~/Workspace/buddy/src/main/index.ts'), 'Edit index.ts', 'a path is said as its last part');
    eq(speakable('   '), '', 'nothing is nothing');
    return 'SAM 4412 · the sam-eng channel · a link · index.ts';
  });

  await check('a URL that contains a hash is still a link', () => {
    // The order the rules run in: hashes become "the … channel", so a URL has
    // to be taken out of the sentence before that happens to it.
    eq(speakable('see https://x.com/a#section-3 now'), 'see a link now', 'not "the section-3 channel"');
    return 'rules that would fight are ordered rather than hoped about';
  });

  await check('a long answer stops at a sentence rather than trailing off', () => {
    const long = `${'This is a sentence about the morning. '.repeat(20)}`;
    const said = speakable(long);
    ok(said.length <= MAX_SPOKEN_CHARS, `cut to ${said.length}`);
    ok(said.endsWith('.'), `and cut at a full stop: “…${said.slice(-40)}”`);
    const unbroken = speakable('x'.repeat(900));
    ok(unbroken.endsWith('…'), 'text with nowhere to stop gets an ellipsis instead');
    return `${said.length} chars, ending on a sentence`;
  });

  await check('an unsure reading is spoken as a question, never as a statement', () => {
    const sure = goalUtterance('File SAM-4412', reading(), false);
    eq(sure, 'File SAM 4412', 'a confident reading is just the goal');
    const unsure = goalUtterance('File SAM-4412', reading({ confidence: 0.3, alternatives: [{ goal: 'Reply to Priya', confidence: 0.3 }] }), true);
    eq(unsure, 'File SAM 4412? Or Reply to Priya?', 'below the line it is a question with the alternative');
    const done = goalUtterance('File SAM-4412', reading({ already_done: ['The thread is open'] }), false);
    ok(/already/.test(done), `and what is already done is the one clause worth a sentence: “${done}”`);
    return unsure;
  });

  await check('a run asking and a run ending each have a sentence', () => {
    eq(runUtterance(runView()), 'Done. Replied in the thread.', 'done');
    ok(/needs you/.test(runUtterance(runView({ status: 'needs_human', outcome: null, haltReason: 'Blocked: Spotify is not on the allowlist.' }))), 'needs you');
    ok(/Waiting/.test(runUtterance(runView({ status: 'waiting', outcome: { status: 'waiting', summary: 'Checking Slack every 5 minutes.' } }))), 'waiting');
    const gated = runUtterance(
      runView({ status: 'gated', gate: { runId: 1, stepIdx: 2, action: 'left_click', verdict: { decision: 'confirm', class: 'send', reason: 'That click targets the “Send” button in Slack.', signal: 'ax-tree', target: '', appKey: '', appName: 'Slack' }, sessionScope: 'sending in Slack', askedBefore: 0 } }),
    );
    ok(/asking first/.test(gated) && /Send/.test(gated), gated);
    eq(runUtterance(runView({ status: 'running' })), '', 'a run still going has nothing to say');
    eq(answerUtterance({ answer: 'You spent the morning in #sam-eng.' }), 'You spent the morning in the sam-eng channel.', 'an answer');
    return gated;
  });

  // ══ 2. When it says it ════════════════════════════════════════════════════

  const t = new ScriptedSpeech();
  let listening = false;
  const speech = new SpeechService({ settings: () => settings.get(), transport: t, listening: () => listening });

  await check('off by default, and off means nothing is ever sent to be said', async () => {
    settings.update({ ...DEFAULT_SETTINGS });
    eq(settings.get().speechEnabled, false, 'off out of the box');
    eq(await speech.say('goal', 'File SAM-4412'), 'off', 'and nothing is said');
    eq(t.said.length, 0, 'the synthesizer is never asked');
    return 'the one thing buddy does that other people can hear is opt-in';
  });

  await check('each kind of moment can be turned off on its own', async () => {
    settings.update({ speechEnabled: true, speakGoals: true, speakAnswers: false, speakRuns: true });
    t.said.length = 0;
    eq(await speech.say('goal', 'the goal'), 'said', 'goals on');
    eq(await speech.say('answer', 'the answer'), 'off', 'answers off');
    eq(await speech.say('run', 'the run ended'), 'said', 'runs on');
    eq(t.said.length, 2, 'two sentences reached the synthesizer');
    eq(await speech.say('goal', '   '), 'empty', 'and nothing is said about nothing');
    return 'goals and runs said, answers not';
  });

  await check('the voice, the speed and the room rules are passed down, not re-decided', async () => {
    settings.update({ speechEnabled: true, speakGoals: true, speechVoice: 'v-premium', speechRate: 0.8, speechHeadphonesOnly: true });
    t.said.length = 0;
    listening = true;
    await speech.say('goal', 'File SAM-4412');
    const last = t.last()!;
    eq(last.voice, 'v-premium', 'the chosen voice');
    eq(last.rate, 0.8, 'the chosen speed');
    eq(last.headphonesOnly, true, 'the headphones rule is enforced in buddyd, and told to it');
    eq(last.ourMic, true, 'and buddyd is told buddy itself has the microphone — the one thing it cannot work out');
    listening = false;
    settings.update({ speechVoice: '', speechRate: 0.5 });
    return 'the policy is up here; the enforcement is down there';
  });

  await check('a room buddy should not speak into is reported, not retried', async () => {
    settings.update({ speechEnabled: true, speakGoals: true });
    t.said.length = 0;
    t.skipWith = 'no_headphones';
    eq(await speech.say('goal', 'File SAM-4412'), 'skipped', 'skipped');
    eq(t.said.length, 0, 'nothing was said');
    eq(speech.current().lastSkip, 'no_headphones', 'and the reason is kept for the UI');
    ok(/headphones only/.test(SKIP_REASON.no_headphones!), SKIP_REASON.no_headphones!);
    ok(/on a call/.test(SKIP_REASON.microphone_in_use!), SKIP_REASON.microphone_in_use!);
    t.skipWith = null;
    await speech.say('goal', 'File SAM-4412');
    eq(speech.current().lastSkip, null, 'and cleared once something is said');
    return SKIP_REASON.no_headphones!;
  });

  await check('buddy does not listen to itself, and can still be interrupted', async () => {
    settings.update({ speechEnabled: true, speakGoals: true });
    await speech.say('goal', 'Reply to Priya saying go ahead');
    ok(speech.echoing(), 'while speaking, what is heard may be buddy');
    const at = { running: false, hudVisible: true, state: 'ARMED' as const, armedAt: Date.now(), now: Date.now(), echoing: true };
    eq(routeIntent({ kind: 'confirm' }, at).action, 'ignore', 'a go-ahead heard then is buddy reading its own goal');
    eq(routeIntent({ kind: 'cancel', addressed: false }, at).action, 'ignore', 'and so is a bare stop');
    eq(routeIntent({ kind: 'cancel', addressed: true }, { ...at, running: true }).action, 'stop-run', '“buddy, stop” still stops it — that is when you most want to');
    eq(routeIntent({ kind: 'confirm' }, { ...at, echoing: false }).action, 'confirm', 'and once it is quiet, a go-ahead works again');

    // An end event buddyd could not match to a request still ends the window:
    // staying "speaking" on a lost event would suppress voice go-aheads for
    // the rest of the session, quietly.
    t.emitEvent({ id: 0, state: 'finished' });
    ok(!speech.speaking(), 'an unmatched end event is still an end');
    ok(speech.echoing(), 'though the window outlasts the last word');
    return `${SPEECH_ECHO_TAIL_MS} ms tail, because the recognizer finishes an utterance after the sound stops`;
  });

  await check('an end event that never arrives does not break voice for the session', async () => {
    let clock = 1_000_000;
    const t2 = new ScriptedSpeech();
    const s2 = new SpeechService({ settings: () => settings.get(), transport: t2, listening: () => false, now: () => clock });
    settings.update({ speechEnabled: true, speakGoals: true });
    eq(await s2.say('goal', 'something long'), 'said', 'said');
    ok(s2.speaking(), 'speaking');
    // buddyd dies mid-sentence: no `finished` ever comes.
    clock += MAX_UTTERANCE_MS + 1;
    ok(!s2.speaking(), 'after the longest an utterance can be, buddy assumes it stopped');
    ok(s2.echoing(), 'the usual tail applies from that moment');
    clock += SPEECH_ECHO_TAIL_MS + 1;
    ok(!s2.echoing(), 'and then voice commands work again');
    // An end for an utterance that was already superseded does not end the new one.
    const t3 = new ScriptedSpeech();
    const s3 = new SpeechService({ settings: () => settings.get(), transport: t3, listening: () => false });
    await s3.say('goal', 'first');
    await s3.say('goal', 'second');
    t3.emitEvent({ id: 1, state: 'finished' });
    ok(s3.speaking(), 'the older utterance ending does not silence the newer one');
    return `${Math.round(MAX_UTTERANCE_MS / 1000)} s, then buddy assumes it stopped`;
  });

  await check('the newest thing to say replaces whatever is still being said', async () => {
    t.said.length = 0;
    t.stops = 0;
    await speech.say('goal', 'the first thing');
    await speech.say('run', 'the second thing');
    eq(t.said.length, 2, 'both were sent');
    ok(t.said[1]!.id > t.said[0]!.id, 'the newer one has the newer id, which buddyd stops the older for');
    await speech.stop();
    eq(t.stops, 1, 'and stop reaches the synthesizer');
    eq(speech.speaking(), false, 'nothing is speaking');
    return 'one utterance at a time; a queue of stale sentences is noise';
  });

  await check('a synthesizer that is not there never fails the thing that triggered it', async () => {
    t.running = false;
    eq(await speech.say('goal', 'File SAM-4412'), 'unavailable', 'reported');
    eq((await speech.availableVoices(true)).voices.length, 0, 'and the voice list is empty rather than throwing');
    await speech.stop();
    t.running = true;
    return 'speaking is never the point of the operation that triggered it';
  });

  // ══ 3. The real buddyd ════════════════════════════════════════════════════

  let up = false;
  try {
    await sidecar.start();
    up = true;
  } catch (e) {
    log.warn('checks', 'buddyd did not start', { error: (e as Error).message });
  }

  await check('buddyd lists the voices this Mac has, best first', async () => {
    if (!up) skip('buddyd is not built — npm run build:sidecar');
    const v = await sidecar.speakVoices('en');
    ok(v.voices.length > 0, `${v.voices.length} English voices`);
    ok(!!v.preferred, 'and one buddy would use');
    const rank = { premium: 0, enhanced: 1, default: 2 } as const;
    const order = v.voices.map((x) => rank[x.quality]);
    ok(order.every((n, i) => i === 0 || order[i - 1]! <= n), 'sorted by quality');
    eq(v.voices[0]!.id, v.preferred, 'and the preferred one is the first');
    const best = v.voices[0]!.quality;
    return `${v.voices.length} voices, best is ${best}${best === 'default' ? ' (no enhanced voice is installed on this Mac)' : ''}`;
  });

  await check('buddyd says what the sound is going out of', async () => {
    if (!up) skip('buddyd is not built');
    const st = await sidecar.speakStatus();
    eq(typeof st.outputIsPrivate, 'boolean', 'whether what buddy says would reach one person');
    eq(typeof st.micInUse, 'boolean', 'and whether something has the microphone');
    eq(st.speaking, false, 'nothing is speaking yet');
    return `${st.output ?? 'no output device'} — ${st.outputIsPrivate ? 'private' : 'in the room'}; mic ${st.micInUse ? 'in use' : 'free'}`;
  });

  await check('the headphones rule is enforced in buddyd, not only above it', async () => {
    if (!up) skip('buddyd is not built');
    const st = await sidecar.speakStatus();
    if (st.outputIsPrivate) skip('this Mac is on headphones, so there is no in-the-room path to check.');
    const r = await sidecar.speak({ text: 'This should not be said.', id: 9001, headphonesOnly: true });
    eq(r.speaking, false, 'refused');
    eq(r.skipped, 'no_headphones', 'with the reason');
    return 'a rule that lives only in the layer above is one a later caller can forget';
  });

  await check('a real sentence is really synthesized', async () => {
    if (!up) skip('buddyd is not built');
    const events: SpeakEvent[] = [];
    const off = sidecar.onSpeak((e) => events.push(e));
    // `force` so this does not depend on what is plugged in, and silent unless
    // asked for: a suite that talks to the room is one nobody runs twice.
    const r = await sidecar.speak({
      text: ALOUD ? 'Filing SAM 4412 from Priya in the sam-eng channel.' : 'Checking.',
      id: 4242,
      force: true,
      rate: 0.5,
      ...(ALOUD ? {} : { volume: 0 }),
    });
    eq(r.speaking, true, 'it started');
    for (let i = 0; i < 40 && !events.some((e) => e.state === 'finished' || e.state === 'cancelled'); i++) await sleep(100);
    off();
    await sidecar.speakStop();
    ok(events.some((e) => e.state === 'started' && e.id === 4242), 'a started event, carrying the id it was given');
    ok(
      events.some((e) => (e.state === 'finished' || e.state === 'cancelled') && e.id === 4242),
      `and an end event (${events.map((e) => e.state).join(' → ') || 'none'})`,
    );
    return `${events.map((e) => e.state).join(' → ')}${ALOUD ? ' — aloud' : ' — silently; BUDDY_SPEAK_ALOUD=1 to hear it'}`;
  });

  await check('stopping mid-sentence really stops it', async () => {
    if (!up) skip('buddyd is not built');
    await sidecar.speak({ text: 'One two three four five six seven eight nine ten.', id: 4243, force: true, volume: 0 });
    await sleep(250);
    const stopped = await sidecar.speakStop();
    await sleep(150);
    const st = await sidecar.speakStatus();
    eq(st.speaking, false, 'silent');
    ok(stopped.stopped !== false, 'and it had something to stop');
    return 'Esc, the abort hotkey and “buddy, stop” all reach this';
  });

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
    '\nVoice-reply checks\n\n' +
    results.map((r) => `  ${glyph[r.state]}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${ran.length - failed.length}/${ran.length} passed`;
  report += skipped.length ? `, ${skipped.length} skipped\n` : '\n';
  report +=
    '\nNot covered: how it sounds. The synthesizer is macOS’s, and which voices\n' +
    'a Mac has is a download away — run with BUDDY_SPEAK_ALOUD=1 to hear it.\n\n';
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
