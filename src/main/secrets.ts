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
    log.info('secrets', 'key stored', { name, chars: plaintext.length });
  },

  get(name: SecretName): string | null {
    const stored = kv.get<string | null>(key(name), null);
    if (!stored) return null;
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch (e) {
      // Usually means the keychain item is gone or this is a different machine.
      log.warn('secrets', 'could not decrypt stored key', { name, error: (e as Error).message });
      return null;
    }
  },

  has(name: SecretName): boolean {
    return !!kv.get<string | null>(key(name), null);
  },

  clear(name: SecretName) {
    kv.set(key(name), null);
    log.info('secrets', 'key cleared', { name });
  },

  /** What the renderer is allowed to know: whether a key exists, never what it is. */
  status(): SecretsStatus {
    return {
      encryptionAvailable: this.available(),
      anthropic: this.has('anthropic'),
      openai: this.has('openai'),
    };
  },
};
