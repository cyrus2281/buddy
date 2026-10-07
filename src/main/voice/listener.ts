import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import { interpret, recognizerHints } from './match.js';
import type { RawVoiceStatus, VoiceEvent } from '../sidecar/supervisor.js';
import type { Settings, VoiceStatus } from '../../shared/types.js';

/// "Hey buddy" — PRD §9's wake-word seam, as a sibling of the hotkey.
///
/// buddyd holds the microphone and transcribes; this decides whether it
/// should be listening at all, and turns what it hears into `wake` and
/// `intent` events. What those *do* is `index.ts`'s business, through
/// `route.ts`, because that is where the HUD and the run are.
///
/// Listening is a function of four things, and is recomputed whenever any of
/// them changes: the setting, Pause (§3.2 — a paused buddy stops sensing, and
/// a microphone is a sensor), the screen being locked or asleep (nobody is
/// there to talk to it), and buddyd being up. A restarted buddyd holds nothing,
/// so its `ready` re-arms the microphone the way the human-input handler is
/// re-attached.
///
/// **Nothing heard is written down.** Utterance text arrives, is matched, and
/// is dropped; the log says *that* a wake phrase or a command was heard and
/// never what was said. Everything else the room says is not buddy's to keep.

/** The slice of the sidecar voice uses, so the checks can script it. */
export interface VoiceTransport {
  isRunning(): boolean;
  voiceStatus(): Promise<RawVoiceStatus>;
  voiceStart(hints: string[]): Promise<RawVoiceStatus>;
  voiceStop(): Promise<RawVoiceStatus>;
  requestVoicePermission(kind: 'microphone' | 'speech'): Promise<{ granted: boolean; status: RawVoiceStatus }>;
  onVoice(fn: (e: VoiceEvent) => void): () => void;
  on(event: 'ready', fn: () => void): unknown;
}

export class VoiceListener extends EventEmitter {
  private locked = false;
  private asleep = false;
  /** What macOS has been asked this launch. See `apply`. */
  private asked = new Set<'microphone' | 'speech'>();
  private queue: Promise<void> = Promise.resolve();
  private state: VoiceStatus;

  constructor(private deps: { settings: () => Settings; transport: VoiceTransport }) {
    super();
    this.state = {
      enabled: deps.settings().voiceEnabled,
      listening: false,
      microphone: 'unknown',
      speech: 'unknown',
      onDevice: false,
      inputDevice: null,
      resting: null,
      problem: null,
    };
    deps.transport.onVoice((e) => this.onEvent(e));
    deps.transport.on('ready', () => void this.reconcile());
  }

  current(): VoiceStatus {
    return this.state;
  }

  setLocked(locked: boolean) {
    if (this.locked === locked) return;
    this.locked = locked;
    void this.reconcile();
  }

  setAsleep(asleep: boolean) {
    if (this.asleep === asleep) return;
    this.asleep = asleep;
    void this.reconcile();
  }

  /** Bring buddyd in line with what should be true. Every trigger lands here
   *  and they run one at a time: two overlapping starts would be two taps on
   *  one microphone. */
  reconcile(): Promise<VoiceStatus> {
    return this.enqueue(() => this.apply());
  }

  /** The Grant button. Unlike `apply`, it asks even if it has asked before —
   *  the user clicked something — and macOS shows nothing for a permission
   *  that is already decided, so that costs nothing. */
  request(kind: 'microphone' | 'speech'): Promise<VoiceStatus> {
    return this.enqueue(async () => {
      this.asked.add(kind);
      const r = await this.deps.transport.requestVoicePermission(kind);
      this.publish(r.status, null);
      await this.apply();
    });
  }

  private enqueue(fn: () => Promise<void>): Promise<VoiceStatus> {
    this.queue = this.queue.then(fn).catch((e) => {
      const msg = cleanError(e);
      log.warn('voice', 'could not update the listener', { error: msg });
      this.publish({ listening: false }, msg);
    });
    return this.queue.then(() => this.state);
  }

  private resting(): VoiceStatus['resting'] {
    if (this.deps.settings().paused) return 'paused';
    if (this.locked || this.asleep) return 'locked';
    return null;
  }

  private async apply() {
    const s = this.deps.settings();
    const t = this.deps.transport;
    const want = s.voiceEnabled && !this.resting();

    if (!t.isRunning()) {
      this.publish({ listening: false }, want ? 'buddyd is not running, so nothing is listening.' : null);
      return;
    }
    let raw = await t.voiceStatus();
    if (!want) {
      if (raw.listening) raw = await t.voiceStop();
      this.publish(raw, null);
      return;
    }
    if (!raw.usageStrings) {
      this.publish(raw, 'buddyd was built without its microphone and speech usage strings. Rebuild it: npm run build:sidecar.');
      return;
    }

    // macOS is asked once per launch, and only about what it has never been
    // asked: turning voice on is what the prompt answers. A denial is final
    // until it is changed in System Settings — asking again shows nothing —
    // and re-asking on every settings change would be a loop if it ever did.
    for (const kind of ['microphone', 'speech'] as const) {
      if (raw[kind] === 'undetermined' && !this.asked.has(kind)) {
        this.asked.add(kind);
        log.info('voice', 'asking macOS for permission', { kind });
        raw = (await t.requestVoicePermission(kind)).status;
      }
    }
    const blocker = explain(raw);
    if (blocker) {
      this.publish(raw, blocker);
      return;
    }

    // Called even when already listening: it is idempotent in buddyd, and it
    // is how an edited phrase list reaches the recognizer's hints.
    try {
      raw = await t.voiceStart(recognizerHints(s.voiceConfirmPhrases));
      this.publish(raw, null);
    } catch (e) {
      this.publish({ ...raw, listening: false }, cleanError(e));
    }
  }

  private onEvent(e: VoiceEvent) {
    if (e.type === 'state') {
      // buddyd stopped on its own — the microphone went away, the recognizer
      // will not run. Not retried from here: the next settings change, unlock
      // or restart tries again, and a loop reopening a failing microphone
      // every second is worse than one sentence in Settings.
      this.publish({ listening: false }, e.error ?? 'Voice stopped.');
      return;
    }
    // A straggler from a session that has since been turned off.
    if (!this.state.listening) return;

    const heard = interpret(e.text, this.deps.settings().voiceConfirmPhrases);
    if (heard.wake) {
      log.info('voice', 'heard the wake phrase');
      this.emit('wake');
    }
    if (heard.intent) {
      log.info('voice', 'heard a command', { ...heard.intent });
      this.emit('intent', heard.intent);
    }
  }

  private publish(raw: Partial<RawVoiceStatus>, problem: string | null) {
    const s = this.deps.settings();
    const listening = raw.listening ?? false;
    const next: VoiceStatus = {
      enabled: s.voiceEnabled,
      listening,
      microphone: raw.microphone ?? this.state.microphone,
      speech: raw.speech ?? this.state.speech,
      onDevice: raw.onDevice ?? this.state.onDevice,
      inputDevice: listening ? (raw.inputDevice ?? null) : null,
      resting: s.voiceEnabled ? this.resting() : null,
      problem,
    };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    if (next.listening !== this.state.listening) {
      log.info('voice', next.listening ? 'listening for the wake phrase' : 'not listening', {
        device: next.inputDevice,
        resting: next.resting,
        problem,
      });
    }
    this.state = next;
    this.emit('status', next);
  }
}

/** Enabled, not resting, and still not able to listen — in words that say
 *  what to do about it. */
export function explain(raw: RawVoiceStatus): string | null {
  if (raw.microphone === 'denied' || raw.microphone === 'restricted') {
    return 'Microphone access is off for buddy. Turn it on in System Settings › Privacy & Security › Microphone.';
  }
  if (raw.microphone !== 'granted') return 'macOS has not been asked about the microphone yet. Click Grant.';
  if (raw.speech === 'denied' || raw.speech === 'restricted') {
    return 'Speech Recognition is off for buddy. Turn it on in System Settings › Privacy & Security › Speech Recognition.';
  }
  if (raw.speech !== 'granted') return 'macOS has not been asked about Speech Recognition yet. Click Grant.';
  if (!raw.onDevice) {
    return (
      'This Mac has no on-device English speech model, and buddy will not send the room to a server ' +
      'to get one. Turn on Dictation in System Settings › Keyboard (it downloads the model), then ' +
      'turn voice off and on.'
    );
  }
  return null;
}

/** buddyd's errors arrive as `code_name: sentence (code -32603)`; the
 *  sentence is the part for people. */
function cleanError(e: unknown): string {
  return String((e as Error)?.message ?? e)
    .replace(/ \(code -?\d+\)$/, '')
    .replace(/^[a-z_]+: /, '');
}
