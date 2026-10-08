#!/usr/bin/env node
// Phase 0 probe: talk to `cua-driver mcp` over stdio with plain newline-
// delimited JSON-RPC (legacy MCP `initialize`, protocol 2025-06-18).
//
//   node spike/cua-driver/probe.mjs list              -> writes tools.json
//   node spike/cua-driver/probe.mjs call <tool> '<json-args>' [<tool> '<json>' ...]
//
// Calls in one invocation share one MCP session, which is what window actions
// need (`get_window_state` before `click`). Image content is written to
// spike/cua-driver/out/ instead of being printed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = process.env.CUA_DRIVER_BIN || 'cua-driver';
const [mode, ...rest] = process.argv.slice(2);

const child = spawn(bin, ['mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
});
child.stderr.on('data', (d) => process.stderr.write(`[cua-driver] ${d}`));

let buf = '';
let nextId = 1;
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      process.stderr.write(`[notify] ${line.slice(0, 300)}\n`);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
  });
}

function summarize(result, label) {
  const outDir = path.join(here, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const content = (result?.content ?? []).map((c, i) => {
    if (c.type === 'image') {
      const ext = (c.mimeType ?? 'image/png').split('/')[1];
      const file = path.join(outDir, `${label}-${i}.${ext}`);
      fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
      return { type: 'image', mimeType: c.mimeType, file, bytes: c.data.length };
    }
    return c;
  });
  return { ...result, content };
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'buddy-probe', version: '0.0.0' },
});
console.error('[init]', JSON.stringify(init.result?.serverInfo ?? init.error));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

if (mode === 'list') {
  const res = await request('tools/list', {});
  const file = path.join(here, 'tools.json');
  fs.writeFileSync(file, JSON.stringify(res.result, null, 2) + '\n');
  console.log(`${res.result.tools.length} tools -> ${file}`);
} else if (mode === 'call') {
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const args = rest[i + 1] ? JSON.parse(rest[i + 1]) : {};
    const t0 = Date.now();
    const res = await request('tools/call', { name, arguments: args });
    const out = res.error ? { error: res.error } : summarize(res.result, `${i / 2}-${name}`);
    console.log(JSON.stringify({ tool: name, ms: Date.now() - t0, ...out }, null, 2));
  }
} else {
  console.error('usage: probe.mjs list | call <tool> <json> ...');
}
child.stdin.end();
child.kill();
