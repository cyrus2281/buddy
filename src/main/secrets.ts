import { safeStorage } from 'electron';
import { kv } from './store/db.js';
import { log } from './log.js';
import type { SecretsStatus } from '../shared/types.js';

/// API keys, via Electron `safeStorage` — which on macOS is Keychain-backed.
///
/// The ciphertext lands in the settings table, but it is ciphertext the OS
/// keychain holds the key for, and it never appears in a log, a note, or a run
/// step (PRD §7.5). Plaintext exists only inside `get()`'s return value, which
/// is never sent to the renderer: `status()` is what the UI gets.

export type SecretName = 'anthropic' | 'openai';

const key = (name: SecretName) => `secret.${name}`;

/**
 * Names whose stored ciphertext will not decrypt on this machine.
 *
 * Latched, and surfaced rather than logged in a loop. The situation is real and
 * expected in this project: `safeStorage` binds its keychain item to the
 * binary, and **re-signing the app invalidates that binding even though the
 * TCC grant survives** (PRD R2's sibling — the Designated Requirement keeps
 * Screen Recording, the keychain ACL does not follow it). `./scripts/sign-app.sh`
 * is a documented step here, so this is not a corner case; it happens on a
 * normal rebuild.
 *
 * Before this, every caller of `get()` re-tried, re-failed and re-logged — the
 * Observer alone does it every few seconds — producing a warning stream with no
 * instruction in it while the app silently did nothing. Which is exactly the
 * failure §11.1 says not to repeat: a thing that looks granted, does not work,
 * and explains itself nowhere.
 */
const undecryptable = new Set<SecretName>();

export const secrets = {
  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  },

  set(name: SecretName, plaintext: string) {
    if (!plaintext) {
      this.clear(name);
      return;
    }
    if (!this.available()) {
      // Storing it in the clear would be worse than not storing it. Say so and
      // let the UI tell the user rather than silently downgrading.
      throw new Error('OS encryption is unavailable; refusing to store a key in plaintext');
    }
    kv.set(key(name), safeStorage.encryptString(plaintext).toString('base64'));
    undecryptable.delete(name);
    log.info('secrets', 'key stored', { name, chars: plaintext.length });
  },

  get(name: SecretName): string | null {
    const stored = kv.get<string | null>(key(name), null);
    if (!stored) return null;
    // Latched: a failure here is permanent until the user re-enters the key, so
    // retrying it costs a keychain round trip and a log line and can never
    // succeed.
    if (undecryptable.has(name)) return null;
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch (e) {
      undecryptable.add(name);
      log.error(
        'secrets',
        'the stored key cannot be decrypted — re-enter it in Settings. This normally means the ' +
          'app was re-signed since the key was saved: macOS ties the keychain item to the binary, ' +
          'and unlike the Screen Recording grant it does not survive a new signature.',
        { name, error: (e as Error).message },
      );
      return null;
    }
  },

  /** True when a key is stored but unreadable. The UI says so and offers the
   *  one thing that fixes it, rather than showing a green dot beside a key
   *  nothing can use. */
  isUndecryptable(name: SecretName): boolean {
    return undecryptable.has(name);
  },

  has(name: SecretName): boolean {
    return !!kv.get<string | null>(key(name), null);
  },

  clear(name: SecretName) {
    kv.set(key(name), null);
    undecryptable.delete(name);
    log.info('secrets', 'key cleared', { name });
  },

  /** What the renderer is allowed to know: whether a key exists, never what it is. */
  status(): SecretsStatus {
    return {
      encryptionAvailable: this.available(),
      anthropic: this.has('anthropic'),
      openai: this.has('openai'),
      undecryptable: (['anthropic', 'openai'] as SecretName[]).filter((n) =>
        this.has(n) && undecryptable.has(n),
      ),
    };
  },
};
