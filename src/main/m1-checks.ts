/**
 * M1 exit-criteria checks, run against the real modules — not reimplementations.
 *
 *   npm run check:m1
 *
 * Runs inside Electron (better-sqlite3 is built against the Electron ABI, and
 * safeStorage needs an app instance) against a throwaway userData directory, so
 * it never touches real frames.
 */
import { app, nativeImage, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './paths.js';
import { log } from './log.js';
import { openDb, getDb, kv, closeDb } from './store/db.js';
import { frames } from './store/frames.js';
import { retention } from './store/retention.js';
import { settings } from './settings.js';
import { secrets } from './secrets.js';
import { phashDistance } from './capture/phash.js';
import { Exclusions } from './capture/exclusions.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-check-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'buddy'));

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function check(name: string, fn: () => string) {
  try {
    results.push({ name, ok: true, detail: fn() });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
  }
}
function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

function run() {
  paths.ensure();
  log.init(paths.logs());
  openDb();
  settings.load();

  /** A staged PNG standing in for a captured frame. */
  function stage(name: string): string {
    const p = path.join(paths.staging(), name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'));
    return p;
  }

  check('frame vault directory is 0700', () => {
    const mode = fs.statSync(paths.frames()).mode & 0o777;
    eq(mode, 0o700, 'frames dir mode');
    return `mode ${mode.toString(8)}`;
  });

  check('keep() writes the file and the row', () => {
    const row = frames.keep({
      ts: Date.now(),
      displayId: 1,
      stagingPath: stage('a.png'),
      w: 1728,
      h: 1117,
      bundleId: 'com.apple.Terminal',
      appName: 'Terminal',
      windowTitle: 'zsh',
      phash: 'aaaaaaaaaaaaaaaa',
      retentionDays: 1,
    });
    eq(fs.existsSync(row.path), true, 'png exists in vault');
    eq(fs.statSync(row.path).mode & 0o777, 0o600, 'png mode');
    eq(row.expires_at - row.ts, 86_400_000, 'expires_at is ts + retentionDays');
    return `id=${row.id} expires in ${(row.expires_at - row.ts) / 3_600_000}h`;
  });

  check('expired frames purge: file unlinked, row tombstoned', () => {
    const old = Date.now() - 3 * 86_400_000;
    const row = frames.keep({
      ts: old,
      displayId: 1,
      stagingPath: stage('old.png'),
      w: 100,
      h: 100,
      bundleId: 'com.apple.Terminal',
      appName: 'Terminal',
      windowTitle: '',
      phash: 'bbbbbbbbbbbbbbbb',
      retentionDays: 1,
    });
    const file = row.path;
    eq(fs.existsSync(file), true, 'file present before sweep');

    const report = retention.sweep();
    eq(fs.existsSync(file), false, 'file gone after sweep');

    const after = getDb().prepare('SELECT deleted_at FROM frames WHERE id = ?').get(row.id) as {
      deleted_at: number | null;
    };
    if (after.deleted_at == null) throw new Error('row was not tombstoned');
    return `purged ${report.expiredFrames}, row ${row.id} tombstoned`;
  });

  check('unexpired frames survive the sweep', () => {
    const live = frames.latest();
    if (!live) throw new Error('no live frame to check');
    eq(fs.existsSync(live.path), true, 'recent frame still on disk');
    return `frame ${live.id} kept, expires ${new Date(live.expires_at).toISOString()}`;
  });

  check('orphan PNGs are collected', () => {
    const dir = paths.dayDir(Date.now());
    fs.mkdirSync(dir, { recursive: true });
    const orphan = path.join(dir, 'orphan.png');
    fs.writeFileSync(orphan, 'x');
    const r = retention.sweep();
    eq(fs.existsSync(orphan), false, 'orphan removed');
    return `collected ${r.orphanFiles}`;
  });

  check('pHash distance matches the dedupe contract', () => {
    eq(phashDistance('ffffffffffffffff', 'ffffffffffffffff'), 0, 'identical');
    eq(phashDistance('0000000000000000', 'ffffffffffffffff'), 64, 'opposite');
    eq(phashDistance('0000000000000000', '0000000000000001'), 1, 'one bit');
    eq(phashDistance('0000000000000000', '00000000000000ff'), 8, 'eight bits');
    eq(phashDistance('bad', 'alsobad'), 64, 'unparseable reads as maximally different');
    return 'identical=0, opposite=64, malformed=64';
  });

  check('excluded apps are skipped before capture', () => {
    const ex = new Exclusions(DEFAULT_SETTINGS.exclusions);
    const base = { pid: 1, idleSeconds: 0, secureInput: false, displayCount: 1 };
    const one = ex.check(
      { ...base, bundleId: 'com.1password.1password', appName: '1Password', windowTitle: 'Vault' },
      false,
    );
    eq(one.skip, true, '1Password skipped');
    eq(one.reason, 'excluded-app', '1Password reason');

    const priv = ex.check(
      { ...base, bundleId: 'com.apple.Safari', appName: 'Safari', windowTitle: 'Start Page — Private Browsing' },
      false,
    );
    eq(priv.skip, true, 'private window skipped');
    eq(priv.reason, 'excluded-title', 'private window reason');

    const secure = ex.check(
      { ...base, bundleId: 'com.apple.Safari', appName: 'Safari', windowTitle: 'Login' },
      true,
    );
    eq(secure.skip, true, 'AXSecureTextField skipped');
    eq(secure.reason, 'secure-input', 'secure field reason');

    const normal = ex.check(
      { ...base, bundleId: 'com.apple.Terminal', appName: 'Terminal', windowTitle: 'zsh' },
      false,
    );
    eq(normal.skip, false, 'ordinary app not skipped');
    return '1Password, private windows, and secure fields all skipped';
  });

  check('an invalid exclusion regex does not take the loop down', () => {
    const ex = new Exclusions([
      { label: 'bad', titlePattern: '([unclosed', builtin: false, enabled: true },
      { label: 'Keychain Access', bundleId: 'com.apple.keychainaccess', builtin: true, enabled: true },
    ]);
    const r = ex.check(
      { pid: 1, idleSeconds: 0, secureInput: false, displayCount: 1,
        bundleId: 'com.apple.keychainaccess', appName: 'Keychain Access', windowTitle: 'login' },
      false,
    );
    eq(r.skip, true, 'the valid rule still fires');
    return 'invalid pattern logged and ignored; valid rules unaffected';
  });

  check('settings clamp out-of-range values', () => {
    const s = settings.update({ captureIntervalMs: 10, retentionDays: 99 });
    eq(s.captureIntervalMs, 3_000, 'interval clamped up to the floor');
    eq(s.retentionDays, 7, 'retention clamped to the 1–7 range');
    settings.update({ captureIntervalMs: 15_000, retentionDays: 1 });
    return 'interval → 3000ms, retention → 7 days';
  });

  check('built-in exclusions cannot be lost from a stored blob', () => {
    kv.set('settings.v1', { exclusions: [] });
    const s = settings.load();
    const has1p = s.exclusions.some((r) => r.bundleId === 'com.1password.1password');
    eq(has1p, true, '1Password re-merged after an empty stored list');
    return `${s.exclusions.length} built-ins restored`;
  });

  check('API keys round-trip through safeStorage and never hit settings in clear', () => {
    if (!safeStorage.isEncryptionAvailable()) return 'skipped: OS encryption unavailable here';
    const key = 'sk-ant-test-0123456789abcdef';
    secrets.set('anthropic', key);
    eq(secrets.get('anthropic'), key, 'round-trip');
    eq(secrets.status().anthropic, true, 'status reports stored');

    const stored = (getDb().prepare("SELECT value FROM settings WHERE key = 'secret.anthropic'").get() as {
      value: string;
    }).value;
    if (stored.includes(key)) throw new Error('the key is in the database in plaintext');
    secrets.clear('anthropic');
    eq(secrets.status().anthropic, false, 'cleared');
    return 'stored as ciphertext, plaintext absent from SQLite';
  });

  check('key-shaped strings are redacted from the log', () => {
    log.info('check', 'token is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    const last = log.recent(1)[0];
    if (last.msg.includes('sk-ant-api03-abcdefghij')) throw new Error('key reached the log');
    eq(last.msg.includes('[redacted]'), true, 'redaction marker present');
    return last.msg;
  });

  check('every purge path notifies listeners so the UI can re-read', () => {
    const seen: string[] = [];
    const off = retention.onSweep(() => seen.push('fired'));

    frames.keep({
      ts: Date.now() - 3 * 86_400_000, displayId: 1, stagingPath: stage('notify-old.png'),
      w: 10, h: 10, bundleId: 'x', appName: 'x', windowTitle: '',
      phash: 'dddddddddddddddd', retentionDays: 1,
    });
    retention.sweep();
    eq(seen.length, 1, 'the hourly/manual sweep notifies');

    frames.keep({
      ts: Date.now(), displayId: 1, stagingPath: stage('notify-live.png'),
      w: 10, h: 10, bundleId: 'x', appName: 'x', windowTitle: '',
      phash: 'eeeeeeeeeeeeeeee', retentionDays: 1,
    });
    retention.purgeAll();
    eq(seen.length, 2, 'Delete-all notifies through the same hook');

    off();
    return 'sweep() and purgeAll() both reach onSweep listeners';
  });

  // The menu bar icon is the only thing a running buddy puts on screen. When it
  // decoded to a 0x0 image, `new Tray()` took it without complaint and drew a
  // blank gap — the app was observing perfectly and looked, to the person using
  // it, like it had never started. An empty image is a silent failure, so it is
  // worth one assertion.
  check('the menu bar icon actually decodes, at both scale factors', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
    const urls = [...src.matchAll(/const TRAY_ICON_(\d+)\s*=\s*\n?\s*'(data:image\/png;base64,[^']+)'/g)];
    eq(urls.length, 2, `two representations are declared (found ${urls.length})`);
    for (const [, label, url] of urls) {
      const img = nativeImage.createFromDataURL(url);
      if (img.isEmpty()) throw new Error(`TRAY_ICON_${label} decoded to an empty image`);
      const size = img.getSize();
      eq(size.width, Number(label), `TRAY_ICON_${label} is ${label}px wide`);
      eq(size.height, Number(label), `TRAY_ICON_${label} is ${label}px tall`);
      // A template image carries its shape in alpha alone. All-transparent
      // decodes fine and draws nothing, which is the failure being guarded.
      const png = img.toPNG();
      if (png.length < 80) throw new Error(`TRAY_ICON_${label} has no pixel data (${png.length} bytes)`);
    }
    return `16px and 32px both decode with real pixels`;
  });

  check('purgeAll removes every live frame', () => {
    frames.keep({
      ts: Date.now(), displayId: 1, stagingPath: stage('z.png'), w: 10, h: 10,
      bundleId: 'x', appName: 'x', windowTitle: '', phash: 'cccccccccccccccc', retentionDays: 1,
    });
    retention.purgeAll();
    const live = getDb().prepare('SELECT COUNT(*) AS n FROM frames WHERE deleted_at IS NULL').get() as { n: number };
    eq(live.n, 0, 'no live frames remain');
    return 'all frames purged, rows tombstoned';
  });

  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  const pad = Math.max(...results.map((r) => r.name.length));
  const report =
    '\nM1 checks\n\n' +
    results.map((r) => `  ${r.ok ? '✓' : '✗'}  ${r.name.padEnd(pad)}   ${r.detail}\n`).join('') +
    `\n${results.length - failed.length}/${results.length} passed\n\n`;

  // `app.exit()` here waits on Electron's network-service teardown, which took
  // ~229s on a run where the checks themselves finished in 13ms. Write the
  // report synchronously to fd 1 (process.exit truncates pending async writes
  // on a pipe) and then leave immediately.
  fs.writeSync(1, report);
  process.exit(failed.length === 0 ? 0 : 1);

}

// Never `await app.whenReady()` at the top level of an Electron ESM entry:
// Electron holds `ready` until the entry module finishes evaluating, so the
// two wait on each other forever.
app.whenReady().then(run);
