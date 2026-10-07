/**
 * Voice checks — "hey buddy", run against the real modules.
 *
 *   npm run check:voice
 *
 * Same shape as the milestone checks: inside Electron, against a throwaway
 * userData directory. What is real: the matcher, the router, the HUD's
 * go-ahead rule, the `VoiceListener` with the real settings store, and — in
 * the last section — the real `buddyd`, spawned by the real supervisor and
 * asked about voice over the real RPC.
 *
 * What is scripted: the microphone. A check cannot speak, and a check that
 * opened the microphone would raise a TCC prompt on the machine running it,
 * which is a dialog nobody asked for. So the listener is driven through a
 * scripted transport that delivers utterances as buddyd would, and the real
 * buddyd is only asked questions that never prompt — status, devices, and a
 * start that must refuse cleanly without a grant.
 */
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, closeDb, kv } from './store/db.js';
import { settings } from './settings.js';
import { sidecar, type RawVoiceStatus, type VoiceEvent } from './sidecar/supervisor.js';
import { interpret, normalizeSpeech, recognizerHints } from './voice/match.js';
import { VoiceListener, explain, type VoiceTransport } from './voice/listener.js';
import { routeIntent, VOICE_CONFIRM_WINDOW_MS } from './voice/route.js';
import { voiceGo } from '../shared/voice.js';
import { KILL_SWITCH_LABEL } from './agent/killswitch.js';
import { DEFAULT_SETTINGS, type VoiceIntent } from '../shared/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-voice-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));

type Result = { name: string; state: 'pass' | 'fail' | 'skip'; detail: string };
const results: Result[] = [];

class Skipped extends Error {}

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

// ── Test doubles ─────────────────────────────────────────────────────────────

/** buddyd's voice surface, scripted. Records every call so the checks can
 *  assert what was asked of macOS and how often. */
class ScriptedTransport extends EventEmitter implements VoiceTransport {
  running = true;
  raw: RawVoiceStatus = {
    listening: false,
    microphone: 'undetermined',
    speech: 'undetermined',
    onDevice: true,
    inputDevice: null,
    error: null,
    usageStrings: true,
  };
  /** What the user answers when macOS asks. */
  answers: Record<'microphone' | 'speech', 'granted' | 'denied'> = { microphone: 'granted', speech: 'granted' };
  calls: string[] = [];
  hints: string[] = [];
  private handlers = new Set<(e: VoiceEvent) => void>();

  isRunning() {
    return this.running;
  }
  async voiceStatus() {
    this.calls.push('status');
    return { ...this.raw };
  }
  async voiceStart(hints: string[]) {
    this.calls.push('start');
    this.hints = hints;
    if (this.raw.microphone !== 'granted' || this.raw.speech !== 'granted') {
      throw new Error('microphone_not_granted: buddy has not been allowed to use the microphone (code -32603)');
    }
    this.raw = { ...this.raw, listening: true, inputDevice: 'MacBook Pro Microphone' };
    return { ...this.raw };
  }
  async voiceStop() {
    this.calls.push('stop');
    this.raw = { ...this.raw, listening: false, inputDevice: null };
    return { ...this.raw };
  }
  async requestVoicePermission(kind: 'microphone' | 'speech') {
    this.calls.push(`ask:${kind}`);
    if (this.raw[kind] === 'undetermined') this.raw = { ...this.raw, [kind]: this.answers[kind] };
    return { granted: this.raw[kind] === 'granted', status: { ...this.raw } };
  }
  onVoice(fn: (e: VoiceEvent) => void) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  say(text: string, id = Math.floor(Math.random() * 1e6)) {
    for (const fn of this.handlers) fn({ type: 'utterance', id, text });
  }
  die(error: string) {
    this.raw = { ...this.raw, listening: false };
    for (const fn of this.handlers) fn({ type: 'state', listening: false, error });
  }
  count(call: string) {
    return this.calls.filter((c) => c === call).length;
  }
}

function listener(t: ScriptedTransport) {
  const l = new VoiceListener({ settings: () => settings.get(), transport: t });
  const heard: string[] = [];
  l.on('wake', () => heard.push('wake'));
  l.on('intent', (i: VoiceIntent) => heard.push(i.kind === 'cancel' ? `cancel${i.addressed ? '!' : ''}` : i.kind));
  return { l, heard };
}

const P = DEFAULT_SETTINGS.voiceConfirmPhrases;
const heardAs = (text: string, phrases = P) => {
  const h = interpret(text, phrases);
  return `${h.wake ? 'wake' : '-'} ${h.intent ? (h.intent.kind === 'cancel' ? `cancel${h.intent.addressed ? '!' : ''}` : h.intent.kind) : '-'}`;
};

async function run() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  // ═══ 1. The matcher: whole utterances, never substrings ══════════════════

  await check('"hey buddy" wakes, alone or with a command after it', () => {
    eq(heardAs('Hey buddy'), 'wake -', 'alone');
    eq(heardAs('hey buddy, take over.'), 'wake confirm', 'with a go-ahead in the same breath');
    eq(heardAs('Okay buddy'), 'wake -', '"okay buddy" is a wake phrase even though "okay" is a filler');
    eq(heardAs('so, hey buddy'), 'wake -', 'fillers may come first');
    eq(heardAs('hey buddy hey buddy go ahead'), 'wake confirm', 'repeated, it is still one');
    eq(heardAs('Hey body'), 'wake -', 'the recognizer’s commonest mishearing');
    return 'the wake phrase opens the utterance, then nothing or a command';
  });

  await check('"hey buddy" said to someone else does not wake', () => {
    eq(heardAs('Hey buddy, how’s it going?'), '- -', 'followed by conversation');
    eq(heardAs('so I told him hey buddy go ahead'), '- -', 'reported, mid-sentence');
    eq(heardAs('a buddy of mine'), '- -', '"a buddy" is ordinary English');
    eq(heardAs('hey bud'), '- -', 'and so is "hey bud"');
    return 'it is what people say to dogs, kids and friends; only the shape addressed to buddy counts';
  });

  await check('a go-ahead is the whole utterance, give or take a filler', () => {
    for (const t of ['take over', 'Go ahead.', 'start', "Let's go!", 'okay, go ahead please', 'all right do it', 'take over, thank you', 'buddy, take over', 'Go ahead and start it']) {
      eq(heardAs(t), '- confirm', JSON.stringify(t));
    }
    for (const t of ['we should go ahead with it', 'start the meeting', 'i’ll take over from here', 'don’t start', 'go', 'yes', 'okay', 'continue']) {
      eq(heardAs(t), '- -', JSON.stringify(t));
    }
    return 'nine go-aheads heard, eight look-alikes ignored';
  });

  await check('stop is fixed, read first, and knows whether it was addressed', () => {
    eq(heardAs('stop'), '- cancel', 'bare');
    eq(heardAs('buddy, stop'), '- cancel!', 'named first');
    eq(heardAs('stop it buddy'), '- cancel!', 'named last');
    eq(heardAs('hey buddy, stop'), '- cancel!', 'woken — and the HUD is not opened just to close it');
    eq(heardAs('never mind'), '- cancel', 'never mind');
    eq(heardAs('do not stop'), '- -', '"do not stop" is not a stop');
    eq(heardAs('stop', [...P, 'stop']), '- cancel', 'a user who adds "stop" as a go-ahead gets the safe reading');
    return 'the way out cannot be configured away';
  });

  await check('the user’s phrases are matched as they would be said', () => {
    eq(normalizeSpeech("Let's  GO!"), 'lets go', 'case, apostrophes and punctuation fold');
    eq(heardAs('yes', ['yes']), '- confirm', 'a phrase that is itself a filler still matches alone');
    eq(heardAs('yes please', ['yes']), '- confirm', 'and with a filler after it');
    eq(heardAs('take over', []), '- -', 'an empty list turns go-aheads off');
    eq(heardAs('hey buddy', []), 'wake -', 'and leaves the wake phrase working');
    const hints = recognizerHints(P);
    ok(hints.includes('hey buddy') && hints.includes('take over') && hints.includes('stop'), 'the recognizer is biased toward all of them');
    return `${hints.length} recognizer hints`;
  });

  // ═══ 2. The router: starting is narrow, stopping is addressed ═════════════

  await check('a go-ahead reaches the HUD only when it is armed, and recently', () => {
    const now = 1_000_000;
    const at = { running: false, hudVisible: true, state: 'ARMED' as const, armedAt: now - 5_000, now };
    const go: VoiceIntent = { kind: 'confirm' };
    eq(routeIntent(go, at).action, 'confirm', 'armed five seconds ago');
    eq(routeIntent(go, { ...at, armedAt: now - VOICE_CONFIRM_WINDOW_MS - 1 }).action, 'ignore', 'armed too long ago');
    eq(routeIntent(go, { ...at, hudVisible: false }).action, 'ignore', 'no HUD');
    eq(routeIntent(go, { ...at, state: 'OBSERVING' }).action, 'ignore', 'a HUD that is not showing a suggestion');
    eq(routeIntent(go, { ...at, running: true }).action, 'ignore', 'never during a run — a gate is not answered by voice');
    return `a ${VOICE_CONFIRM_WINDOW_MS / 1000} s window, so an empty room cannot start a run on the TV’s say-so`;
  });

  await check('"buddy, stop" stops a run; a bare "stop" does not', () => {
    const at = { running: true, hudVisible: true, state: 'ACTING' as const, armedAt: 0, now: 1 };
    eq(routeIntent({ kind: 'cancel', addressed: true }, at).action, 'stop-run', 'addressed');
    eq(routeIntent({ kind: 'cancel', addressed: false }, at).action, 'ignore', 'bare');
    eq(routeIntent({ kind: 'cancel', addressed: false }, { ...at, running: false }).action, 'dismiss', 'no run: any cancel closes the HUD');
    eq(routeIntent({ kind: 'cancel', addressed: false }, { ...at, running: false, hudVisible: false }).action, 'ignore', 'and with no HUD, nothing');
    eq(KILL_SWITCH_LABEL.voice, 'saying “buddy, stop”', 'and the run log names it');
    return '§7.3: stopping is an explicit act, and naming buddy is what makes it one';
  });

  // ═══ 3. The HUD's rule: stricter than Enter ═══════════════════════════════

  await check('the HUD waits for the reading, then starts only what it read with confidence', () => {
    const base = { armed: true, typed: null, inference: 'ready' as const, mustAsk: false, goal: 'File SAM-4412', profile: 'attended' as const };
    eq(voiceGo(base).act, 'start', 'a confident reading starts');
    eq(voiceGo({ ...base, inference: 'provisional' }).act, 'wait', 'the provisional guess is held, not run');
    eq(voiceGo({ ...base, mustAsk: true }).act, 'refuse', 'below 0.5 the HUD is asking, and "go ahead" is not an answer');
    eq(voiceGo({ ...base, mustAsk: true, typed: 'File SAM-4412' }).act, 'start', 'unless an alternative was picked');
    eq(voiceGo({ ...base, inference: 'error' }).act, 'refuse', 'a failed reading has nothing it read');
    eq(voiceGo({ ...base, profile: 'leashless' }).act, 'refuse', 'never leashless');
    eq(voiceGo({ ...base, profile: 'unattended' }).act, 'start', 'unattended is fine — its guardrails refuse on their own');
    eq(voiceGo({ ...base, armed: false }).act, 'drop', 'typing, a gate, or a run: dropped silently');
    const refused = voiceGo({ ...base, mustAsk: true });
    ok(refused.act === 'refuse' && /1–3/.test(refused.why), 'and a refusal says what would work');
    return 'a voice from across the room gets less latitude than a finger on Enter';
  });

  // ═══ 4. The listener: when the microphone is open ═════════════════════════

  await check('off by default, and off means the microphone is never touched', async () => {
    settings.update({ ...DEFAULT_SETTINGS });
    eq(settings.get().voiceEnabled, false, 'voice is off in a fresh install');
    const t = new ScriptedTransport();
    const { l } = listener(t);
    const st = await l.reconcile();
    eq(st.listening, false, 'not listening');
    eq(t.count('start') + t.count('ask:microphone') + t.count('ask:speech'), 0, 'never started, never asked macOS');
    return 'an open microphone is the user’s decision to make';
  });

  await check('turning it on asks macOS once for each grant, then listens', async () => {
    settings.update({ voiceEnabled: true, paused: false });
    const t = new ScriptedTransport();
    const { l } = listener(t);
    const st = await l.reconcile();
    eq(t.count('ask:microphone'), 1, 'asked for the microphone once');
    eq(t.count('ask:speech'), 1, 'and for speech once');
    eq(st.listening, true, 'listening');
    eq(st.inputDevice, 'MacBook Pro Microphone', 'and says on what');
    ok(t.hints.includes('hey buddy'), 'with the recognizer biased toward the wake phrase');
    await l.reconcile();
    await l.reconcile();
    eq(t.count('ask:microphone') + t.count('ask:speech'), 2, 'and later reconciles never ask again');
    return 'the prompt is the answer to turning voice on — once';
  });

  await check('a denial is reported, not re-asked', async () => {
    settings.update({ voiceEnabled: true, paused: false });
    const t = new ScriptedTransport();
    t.answers.microphone = 'denied';
    const { l } = listener(t);
    let st = await l.reconcile();
    eq(st.listening, false, 'not listening');
    ok(/Privacy & Security › Microphone/.test(st.problem ?? ''), `the problem names where to fix it (${st.problem})`);
    st = await l.reconcile();
    eq(t.count('ask:microphone'), 1, 'macOS was asked once, not on every reconcile');
    eq(t.count('start'), 0, 'and buddyd was never told to open a microphone it may not have');
    // The Grant button may ask again: the user clicked something.
    await l.request('microphone');
    eq(t.count('ask:microphone'), 2, 'the Grant button asks again');
    return st.problem ?? '';
  });

  await check('no on-device model, no listening — never a fallback to a server', async () => {
    settings.update({ voiceEnabled: true, paused: false });
    const t = new ScriptedTransport();
    t.raw = { ...t.raw, microphone: 'granted', speech: 'granted', onDevice: false };
    const { l } = listener(t);
    const st = await l.reconcile();
    eq(st.listening, false, 'not listening');
    eq(t.count('start'), 0, 'buddyd was not asked to start');
    ok(/Dictation/.test(st.problem ?? ''), 'and the problem says how to get the model');
    return 'an always-open microphone streaming the room is not a trade a wake phrase is worth';
  });

  await check('Pause and the lock screen close the microphone, and it reopens after', async () => {
    settings.update({ voiceEnabled: true, paused: false });
    const t = new ScriptedTransport();
    t.raw = { ...t.raw, microphone: 'granted', speech: 'granted' };
    const { l } = listener(t);
    eq((await l.reconcile()).listening, true, 'listening to begin with');

    settings.update({ paused: true });
    let st = await l.reconcile();
    eq(st.listening, false, 'paused: not listening');
    eq(st.resting, 'paused', 'and it says why, as a reason rather than a problem');
    eq(st.problem, null, 'not as a problem');
    settings.update({ paused: false });
    eq((await l.reconcile()).listening, true, 'resumed: listening again');

    l.setLocked(true);
    st = await l.reconcile();
    eq(st.listening, false, 'locked: not listening');
    eq(st.resting, 'locked', 'resting');
    l.setLocked(false);
    eq((await l.reconcile()).listening, true, 'unlocked: listening again');

    l.setAsleep(true);
    eq((await l.reconcile()).listening, false, 'asleep: not listening');
    l.setAsleep(false);
    eq((await l.reconcile()).listening, true, 'awake: listening again');
    return `${t.count('stop')} stops, ${t.count('start')} starts`;
  });

  await check('heard utterances become events, and none of them reach the log', async () => {
    settings.update({ voiceEnabled: true, paused: false });
    const t = new ScriptedTransport();
    t.raw = { ...t.raw, microphone: 'granted', speech: 'granted' };
    const { l, heard } = listener(t);
    await l.reconcile();

    const secret = 'the merger closes on the fourteenth';
    t.say('Hey buddy');
    t.say('take over');
    t.say('hey buddy, go ahead');
    t.say('buddy stop');
    t.say(`we should go ahead with it, ${secret}`);
    t.say(secret);
    eq(heard.join(' '), 'wake confirm wake confirm cancel!', 'wake, go-ahead, wake + go-ahead, and an addressed stop');

    const logged = JSON.stringify(log.recent(500));
    ok(!logged.includes('merger'), 'nothing the room said is in the log');
    ok(!/take over|go ahead/i.test(logged.replace(/"why":"[^"]*"/g, '')), 'not even the commands, only that one was heard');
    ok(logged.includes('heard the wake phrase'), 'the log does say that the wake phrase was heard');
    return 'the log records that buddy heard something, never what';
  });

  await check('buddyd giving up is reported once, not retried in a loop', async () => {
    settings.update({ voiceEnabled: true, paused: false });
    const t = new ScriptedTransport();
    t.raw = { ...t.raw, microphone: 'granted', speech: 'granted' };
    const { l, heard } = listener(t);
    await l.reconcile();
    const starts = t.count('start');
    t.die('The microphone changed and buddy could not listen on the new one');
    eq(l.current().listening, false, 'not listening');
    ok(/microphone changed/.test(l.current().problem ?? ''), 'and the reason is shown');
    await new Promise((r) => setTimeout(r, 50));
    eq(t.count('start'), starts, 'nothing restarted it behind the user’s back');
    t.say('hey buddy');
    eq(heard.length, 0, 'and a straggling utterance from the dead session is dropped');
    return 'a loop reopening a failing microphone every second is worse than a sentence in Settings';
  });

  await check('a restarted buddyd re-arms the microphone on its own', async () => {
    settings.update({ voiceEnabled: true, paused: false });
    const t = new ScriptedTransport();
    t.raw = { ...t.raw, microphone: 'granted', speech: 'granted' };
    const { l } = listener(t);
    await l.reconcile();
    // The crash: buddyd is gone, and a fresh one holds no microphone.
    t.running = false;
    t.raw = { ...t.raw, listening: false };
    let st = await l.reconcile();
    eq(st.listening, false, 'nothing listens while buddyd is down');
    ok(/buddyd is not running/.test(st.problem ?? ''), 'and it says so');
    t.running = true;
    t.emit('ready');
    await new Promise((r) => setTimeout(r, 20));
    st = await l.reconcile();
    eq(st.listening, true, 'the new buddyd is listening without anyone touching Settings');
    return 'the same contract as the human-input handler: attached to the supervisor, not a process';
  });

  await check('settings: the phrase list is cleaned, and an old blob gets voice off', () => {
    settings.update({ voiceConfirmPhrases: ['  take over ', '', 'take over', "Let's go!"] });
    eq(settings.get().voiceConfirmPhrases.join('|'), "take over|Let's go!", 'trimmed, blanks and duplicates dropped, spelling kept');
    // A blob written before voice existed.
    const stored = kv.get<Record<string, unknown>>('settings.v1', {});
    delete stored.voiceEnabled;
    delete stored.voiceConfirmPhrases;
    kv.set('settings.v1', stored);
    settings.load();
    eq(settings.get().voiceEnabled, false, 'an upgrade does not open the microphone');
    eq(settings.get().voiceConfirmPhrases.length, DEFAULT_SETTINGS.voiceConfirmPhrases.length, 'and gets the default phrases');
    return 'off unless someone turned it on, in this version';
  });

  await check('every reason not to listen has a sentence', () => {
    const base: RawVoiceStatus = { listening: false, microphone: 'granted', speech: 'granted', onDevice: true, inputDevice: null, error: null, usageStrings: true };
    eq(explain(base), null, 'nothing to explain when everything is granted');
    for (const raw of [
      { ...base, microphone: 'denied' as const },
      { ...base, microphone: 'restricted' as const },
      { ...base, microphone: 'undetermined' as const },
      { ...base, speech: 'denied' as const },
      { ...base, speech: 'undetermined' as const },
      { ...base, onDevice: false },
    ]) {
      ok((explain(raw) ?? '').length > 20, `explained: ${JSON.stringify(raw)}`);
    }
    return 'voice fails silently by nature; Settings must not';
  });

  // ═══ 5. The real buddyd ═══════════════════════════════════════════════════

  let sidecarUp = false;
  try {
    await sidecar.start();
    sidecarUp = true;
  } catch (e) {
    results.push({ name: 'buddyd starts', state: 'skip', detail: (e as Error).message });
  }

  await check('buddyd answers voice_status without prompting, and carries its usage strings', async () => {
    if (!sidecarUp) throw new Skipped('buddyd is not built — npm run build:sidecar');
    const st = await sidecar.voiceStatus();
    for (const k of ['listening', 'microphone', 'speech', 'onDevice', 'usageStrings'] as const) {
      ok(k in st, `voice_status has ${k}`);
    }
    eq(st.usageStrings, true, 'the embedded Info.plist has both usage strings — without them a Grant click kills buddyd');
    eq(st.listening, false, 'and nothing is listening yet');
    return `microphone ${st.microphone}, speech ${st.speech}, on-device English ${st.onDevice ? 'installed' : 'missing'}`;
  });

  await check('buddyd refuses to open a microphone it has not been granted', async () => {
    if (!sidecarUp) throw new Skipped('buddyd is not built');
    const st = await sidecar.voiceStatus();
    if (st.microphone === 'granted' && st.speech === 'granted') {
      throw new Skipped('this machine has granted both, so a start would really listen');
    }
    let error = '';
    try {
      await sidecar.voiceStart(['hey buddy']);
    } catch (e) {
      error = (e as Error).message;
    }
    ok(/not_granted/.test(error), `refused with a reason (${error})`);
    ok(sidecar.isRunning(), 'and buddyd is still up — a refusal, not a crash');
    eq((await sidecar.voiceStatus()).listening, false, 'not listening');
    return 'checked before the engine starts, so a background process never raises the prompt';
  });

  await check('the Bluetooth rule: a headset is passed over for the built-in mic', async () => {
    if (!sidecarUp) throw new Skipped('buddyd is not built');
    const d = (await sidecar.voiceDevices()) as {
      defaultInput: string | null;
      defaultIsBluetooth: boolean;
      builtInInput: string | null;
      wouldListenOn: string | null;
    };
    if (d.defaultIsBluetooth && d.builtInInput) {
      eq(d.wouldListenOn, d.builtInInput, 'with a Bluetooth default and a built-in mic, the built-in one');
    } else {
      eq(d.wouldListenOn, d.defaultInput, 'otherwise the user’s own default');
    }
    return `default ${d.defaultInput ?? 'none'}${d.defaultIsBluetooth ? ' (Bluetooth)' : ''} → listens on ${d.wouldListenOn ?? 'nothing'}`;
  });

  if (sidecarUp) await sidecar.stop();

  // ── Report ────────────────────────────────────────────────────────────────

  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => r.state === 'fail');
  const skipped = results.filter((r) => r.state === 'skip');
  const ran = results.filter((r) => r.state !== 'skip');
  const pad = Math.max(...results.map((r) => r.name.length));
  const glyph = { pass: '✓', fail: '✗', skip: '–' } as const;

  let report =
    '\nVoice checks\n\n' +
    results.map((r) => `  ${glyph[r.state]}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${ran.length - failed.length}/${ran.length} passed`;
  report += skipped.length ? `, ${skipped.length} skipped\n` : '\n';
  report +=
    '\nNever covered here: a real microphone. Utterances are delivered by a\n' +
    'scripted transport, so what is asserted is the policy — what wakes, what\n' +
    'starts, what stops, when the microphone is open, what reaches the log —\n' +
    'and not how well Apple’s recognizer hears "hey buddy" in your room. The\n' +
    'real buddyd is asked only what never raises a TCC prompt. See README,\n' +
    '"Voice", for trying it by hand.\n\n';

  // Same reason as the milestone checks: `app.exit()` waits on Electron's
  // network-service teardown, which takes minutes.
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
