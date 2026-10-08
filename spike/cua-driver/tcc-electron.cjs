// Phase 0, step 3: TCC attribution with cua-driver spawned as a child of an
// Electron main process, the way `src/main/sidecar/supervisor.ts` spawns buddyd.
//
// Launch it through LaunchServices so Electron.app is its own responsible
// process (as buddy.app is in production), not the terminal that typed it:
//
//   open -n -W -a node_modules/electron/dist/Electron.app --args \
//     "$PWD/spike/cua-driver/tcc-electron.cjs" proxy|direct
//
// `proxy` is plain `cua-driver mcp` (the default; proxies to the CuaDriver.app
// daemon, auto-launching it with `open` when none is listening). `direct` is
// `cua-driver mcp --direct`, which owns the runtime in-process and so takes the
// host's grants. Results go to spike/cua-driver/out/tcc-<mode>.json.
const { app, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv.find((a) => a === 'proxy' || a === 'direct') ?? 'proxy';
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const report = { mode, startedAt: new Date().toISOString(), host: process.execPath, steps: [] };
const note = (step, data) => report.steps.push({ step, ...data });

const BIN = ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver', path.join(os.homedir(), '.local/bin/cua-driver')].find(
  (p) => fs.existsSync(p),
);

function client() {
  const args = mode === 'direct' ? ['mcp', '--direct'] : ['mcp'];
  const child = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' } });
  let buf = '';
  let stderr = '';
  let id = 1;
  const pending = new Map();
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const n = id++;
      const t = setTimeout(() => reject(new Error(`${method} timed out`)), 45_000);
      pending.set(n, (m) => (clearTimeout(t), resolve(m)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  return { child, request, stderr: () => stderr };
}

function luma(b64) {
  const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < bmp.length; i += 4 * 97) {
    const l = 0.0722 * bmp[i] + 0.7152 * bmp[i + 1] + 0.2126 * bmp[i + 2];
    max = Math.max(max, l);
    sum += l;
    n++;
  }
  return { width, height, maxLuma: Math.round(max), meanLuma: Math.round(sum / n) };
}

function textOf(res) {
  return (res.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

async function run() {
  const c = client();
  const call = async (name, args) => {
    const t0 = Date.now();
    const res = await c.request('tools/call', { name, arguments: args });
    const ms = Date.now() - t0;
    return { res, ms };
  };
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'buddy-tcc-spike', version: '0' } });
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  note('initialize', { server: init.result?.serverInfo, error: init.error });

  const perm = await call('check_permissions', { prompt: false });
  note('check_permissions', { ms: perm.ms, structured: perm.res.result?.structuredContent, text: textOf(perm.res), error: perm.res.error });

  const launch = await call('launch_app', { bundle_id: 'com.apple.calculator' });
  const ls = launch.res.result?.structuredContent;
  note('launch_app', { ms: launch.ms, pid: ls?.pid, windows: ls?.windows?.map((w) => ({ id: w.window_id, title: w.title })), error: launch.res.error ?? (launch.res.result?.isError ? textOf(launch.res) : undefined) });
  const pid = ls?.pid;
  let windowId = ls?.windows?.[0]?.window_id;
  if (!windowId && pid) {
    const lw = await call('list_windows', { pid });
    windowId = lw.res.result?.structuredContent?.windows?.[0]?.window_id;
  }
  if (!pid || !windowId) throw new Error('no Calculator window');

  const snap = async (label) => {
    const s = await call('get_window_state', { pid, window_id: windowId, query: '' });
    const sc = s.res.result?.structuredContent ?? {};
    const img = (s.res.result?.content ?? []).find((x) => x.type === 'image');
    let shot = null;
    if (img) {
      fs.writeFileSync(path.join(outDir, `tcc-${mode}-${label}.png`), Buffer.from(img.data, 'base64'));
      shot = luma(img.data);
    }
    const display = (sc.elements ?? []).filter((e) => /AXStaticText|AXScrollArea/.test(e.role ?? '')).map((e) => e.value ?? e.label).filter(Boolean);
    note(`get_window_state:${label}`, {
      ms: s.ms,
      isError: s.res.result?.isError,
      error: s.res.error ?? (s.res.result?.isError ? textOf(s.res) : undefined),
      elementCount: sc.element_count,
      degraded: sc.degraded_reason,
      screenshotScale: sc.screenshot_scale,
      shot,
      display,
      keys: Object.keys(sc),
    });
    return sc;
  };

  const before = await snap('before');
  const seven = (before.elements ?? []).find((e) => e.role === 'AXButton' && (e.label === '7' || /\b7\b/.test(e.label ?? '')));
  const clear = (before.elements ?? []).find((e) => e.role === 'AXButton' && /^(AC|C|All Clear|Clear)$/i.test(e.label ?? ''));
  note('targets', { seven, clear: clear ? { label: clear.label, token: clear.element_token } : null });
  if (clear) await call('click', { element_token: clear.element_token, pid });
  if (seven) {
    const ck = await call('click', { element_token: seven.element_token, pid });
    note('click:7(ax,background)', { ms: ck.ms, structured: ck.res.result?.structuredContent, text: textOf(ck.res).slice(0, 600), error: ck.res.error });
  }
  await snap('after-ax');

  // Pixel path, background: click the same button by its frame centre in
  // window-local screenshot pixels.
  if (seven?.screenshot_frame) {
    // `frame` is screen points; `screenshot_frame` is window-local pixels in
    // the PNG, which is what the pixel path takes.
    const sc = (before.screenshot_scale ?? 1);
    const f = seven.screenshot_frame;
    const x = f.x + f.w / 2;
    const y = f.y + f.h / 2;
    const ck = await call('click', { pid, window_id: windowId, x, y });
    note('click:7(px,background)', { x, y, frameSpace: 'screenshot_frame', scale: sc, structured: ck.res.result?.structuredContent, text: textOf(ck.res).slice(0, 600), error: ck.res.error });
    await snap('after-px');
  }
  c.child.stdin.end();
  c.child.kill();
  note('stderr', { text: c.stderr().slice(0, 2000) });
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    note('fatal', { message: String(e?.stack ?? e) });
  }
  fs.writeFileSync(path.join(outDir, `tcc-${mode}.json`), JSON.stringify(report, null, 2));
  app.exit(0);
});
