import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import { speakable, type SpeechKind } from '../../shared/speech.js';
import type { SpeakEvent, SpeakStatus, SpeakVoices } from '../sidecar/supervisor.js';
import type { Settings, SpeechState } from '../../shared/types.js';

/// Saying things out loud — the policy half (`sidecar/Sources/Speak.swift` is
/// the synthesizer).
///
/// Three things this owns that the sidecar should not:
///
///   - **Which moments are worth a sentence**, which is a setting per kind.
///   - **That buddy does not talk over itself.** One utterance at a time, the
///     newest wins, and a run of steps does not become a monologue.
///   - **That buddy does not listen to itself.** With "hey buddy" on, the
///     microphone is open while the speakers are going, and the goal buddy is
///     reading aloud is arbitrary text off a screen — "…reply saying go
///     ahead" is a sentence that would otherwise start a run. So the listener
///     is told when buddy is speaking, and what it does with that is
///     `route.ts`: a go-ahead or an instruction heard then is ignored, and an
///     *addressed* stop still works, because the moment you most want to
///     interrupt is while it is talking.

/**
 * The longest a single utterance is believed to still be going.
 *
 * Being wrong about this in one direction is harmless and in the other is not:
 * the "buddy is speaking" flag suppresses voice go-aheads, so an end event
 * that never arrives — a sidecar that died mid-sentence, an id that does not
 * match — would leave voice quietly half-broken with nothing in the log. After
 * this, buddy assumes it has stopped. `MAX_SPOKEN_CHARS` of speech is about
 * forty seconds at the slowest rate.
 */
export const MAX_UTTERANCE_MS = 90_000;

/** How long after the last word buddy keeps discounting what it hears. The
 *  recognizer finishes an utterance ~0.9 s after the sound stops, so the tail
 *  has to outlast that or the last thing buddy said arrives just after it
 *  stopped speaking. */
export const SPEECH_ECHO_TAIL_MS = 1_800;

export interface SpeechTransport {
  isRunning(): boolean;
  speak(p: {
    text: string;
    id: number;
    voice?: string;
    rate?: number;
    headphonesOnly?: boolean;
    ourMic?: boolean;
  }): Promise<{ speaking: boolean; id: number; skipped?: string }>;
  speakStop(): Promise<unknown>;
  speakStatus(): Promise<SpeakStatus>;
  speakVoices(language?: string): Promise<SpeakVoices>;
  onSpeak(fn: (e: SpeakEvent) => void): () => void;
}

const KIND_SETTING: Record<SpeechKind, keyof Settings> = {
  goal: 'speakGoals',
  answer: 'speakAnswers',
  run: 'speakRuns',
};

export class SpeechService extends EventEmitter {
  private seq = 0;
  private speakingId = 0;
  private startedAt = 0;
  private lastEndedAt = 0;
  private lastSkip: string | null = null;
  private lastSaid = '';
  private voices: SpeakVoices | null = null;

  constructor(
    private deps: {
      settings: () => Settings;
      transport: SpeechTransport;
      /** buddy's own "hey buddy" listener has the microphone open. */
      listening: () => boolean;
      now?: () => number;
    },
  ) {
    super();
    deps.transport.onSpeak((e) => this.onEvent(e));
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** True while buddy is talking, and for a moment after — the window in which
   *  anything heard may be buddy's own voice coming back. */
  echoing(): boolean {
    return this.speaking() || this.now() - this.lastEndedAt < SPEECH_ECHO_TAIL_MS;
  }

  speaking(): boolean {
    if (this.speakingId === 0) return false;
    // Self-healing: see `MAX_UTTERANCE_MS`.
    if (this.now() - this.startedAt > MAX_UTTERANCE_MS) {
      this.speakingId = 0;
      this.lastEndedAt = this.now();
      return false;
    }
    return true;
  }

  current(): SpeechState {
    const s = this.deps.settings();
    return {
      enabled: s.speechEnabled,
      speaking: this.speaking(),
      lastSaid: this.lastSaid,
      lastSkip: this.lastSkip,
    };
  }

  /**
   * Say something, if this kind of thing is worth saying.
   *
   * Returns what happened rather than throwing: speaking is never the point of
   * the operation that triggered it, and a run must not fail because a
   * synthesizer did.
   */
  async say(kind: SpeechKind, text: string): Promise<'said' | 'off' | 'empty' | 'skipped' | 'unavailable'> {
    const s = this.deps.settings();
    if (!s.speechEnabled || !s[KIND_SETTING[kind]]) return 'off';
    const said = speakable(text);
    if (!said) return 'empty';
    if (!this.deps.transport.isRunning()) return 'unavailable';

    const id = ++this.seq;
    try {
      const r = await this.deps.transport.speak({
        text: said,
        id,
        ...(s.speechVoice ? { voice: s.speechVoice } : {}),
        rate: s.speechRate,
        headphonesOnly: s.speechHeadphonesOnly,
        ourMic: this.deps.listening(),
      });
      if (r.skipped) {
        this.lastSkip = r.skipped;
        this.emit('change');
        log.info('speech', 'not said out loud', { kind, why: r.skipped });
        return 'skipped';
      }
      this.lastSkip = null;
      this.lastSaid = said;
      // The `started` event is what sets `speakingId`, but it arrives a beat
      // later and the echo window has to be closed *before* the first sound —
      // otherwise the opening word is heard as a command.
      this.speakingId = id;
      this.startedAt = this.now();
      this.emit('change');
      // Nothing the room says is written down (§ voice), and neither is this:
      // the log records that buddy spoke and how long the sentence was.
      log.info('speech', 'said', { kind, words: said.split(/\s+/).length });
      return 'said';
    } catch (e) {
      log.debug('speech', 'could not speak', { kind, error: (e as Error).message });
      return 'unavailable';
    }
  }

  /** Stop mid-sentence: Esc, a kill switch, the screen locking, or something
   *  newer to say. */
  async stop(): Promise<void> {
    if (!this.speakingId && !this.deps.transport.isRunning()) return;
    this.speakingId = 0;
    this.lastEndedAt = this.now();
    this.emit('change');
    try {
      await this.deps.transport.speakStop();
    } catch {
      /* a synthesizer that is already gone is already stopped */
    }
  }

  /** The installed voices, for Settings. Cached: the list changes only when
   *  someone downloads a voice, and it is a few hundred entries. */
  async availableVoices(force = false): Promise<SpeakVoices> {
    if (this.voices && !force) return this.voices;
    if (!this.deps.transport.isRunning()) return { voices: [], preferred: null, systemDefault: null };
    try {
      this.voices = await this.deps.transport.speakVoices('en');
    } catch (e) {
      log.debug('speech', 'could not list voices', { error: (e as Error).message });
      return { voices: [], preferred: null, systemDefault: null };
    }
    return this.voices;
  }

  async status(): Promise<SpeakStatus | null> {
    if (!this.deps.transport.isRunning()) return null;
    try {
      return await this.deps.transport.speakStatus();
    } catch {
      return null;
    }
  }

  private onEvent(e: SpeakEvent) {
    if (e.state === 'started') {
      this.speakingId = e.id;
      this.startedAt = this.now();
      this.emit('change');
      return;
    }
    // An end event for an *older* utterance arrives after a newer one has
    // already started — the newest wins, so that one is ignored. Anything else,
    // including an id buddyd could not match to a request, ends the window:
    // staying "speaking" on a lost event is the failure worth defending.
    if (e.id === 0 || e.id >= this.speakingId) {
      this.speakingId = 0;
      this.lastEndedAt = this.now();
    }
    this.emit('change');
  }
}
