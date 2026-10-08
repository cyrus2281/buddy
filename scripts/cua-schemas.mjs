#!/usr/bin/env node
// Generates src/main/cua/schemas.json — the cua backend's tool surface — from
// spike/cua-driver/tools.json, which is cua-driver's own MCP `tools/list`.
//
//   npm run cua:schemas
//
// The docs do not give input shapes, so nothing here is written by hand from
// them: the curated subset, in a fixed order, with the properties buddy owns or
// does not offer taken out. Regenerate after re-capturing tools.json for a new
// cua-driver version, and review the diff — a changed description is a changed
// prompt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'spike/cua-driver/tools.json');
const target = path.join(root, 'src/main/cua/schemas.json');

/** The order is the cache prefix's order (PRD §6.5). Do not sort. */
const CURATED = [
  'get_window_state',
  'click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'type_text',
  'press_key',
  'hotkey',
  'zoom',
  'list_apps',
  'list_windows',
  'launch_app',
];

/**
 * Properties the model is not offered.
 *
 * - `scope`, `target`: desktop-scoped input with no pid. Every action buddy
 *   dispatches names a pid, because the guardrail classifies against the app
 *   it acts in — and in the background that is not the frontmost one.
 * - `from_zoom`, `capture_id`: second coordinate spaces. Pixels are read off a
 *   `get_window_state` screenshot and nowhere else, so there is one translation
 *   to get right (PRD §6.2).
 * - `max_image_dimension`, `max_dimension`, `screenshot_out_file`,
 *   `capture_mode`, `debug_image_out`: buddy owns the image ceiling and where
 *   frames are written.
 * - `session`: one buddy run is one MCP connection, which is its own session.
 * - `name`: `launch_app` by bundle id only, because the allowlist is bundle ids.
 * - `webkit_inspector_port`, `additional_arguments`,
 *   `creates_new_application_instance`: launch flags that change how an app
 *   runs, which is not what a run asks for.
 */
const STRIP = new Set([
  'scope',
  'target',
  'from_zoom',
  'capture_id',
  'max_image_dimension',
  'max_dimension',
  'screenshot_out_file',
  'capture_mode',
  'debug_image_out',
  'session',
  'webkit_inspector_port',
  'additional_arguments',
  'creates_new_application_instance',
]);
const STRIP_PER_TOOL = { launch_app: new Set(['name']) };

/** With `scope` gone, a pid is how an action names its app. */
const REQUIRE = {
  click: ['pid'],
  drag: ['pid', 'window_id'],
  scroll: ['pid'],
  type_text: ['pid'],
  press_key: ['pid'],
  hotkey: ['pid'],
  launch_app: ['bundle_id'],
};

/** Appended to cua-driver's own description where buddy's surface differs. */
const NOTE = {
  get_window_state:
    'In buddy: the screenshot is sized by buddy to fit the model’s image limit; read pixel ' +
    'coordinates straight off the image you were sent. An element_token is `<snapshot_id>:<index>` ' +
    '— the result names the snapshot.',
  zoom:
    'In buddy: zoom is for reading only. `from_zoom` is not offered — take click coordinates from ' +
    'the get_window_state screenshot, not from the zoomed image.',
  click: 'In buddy: always pass `pid`. `from_zoom` is not offered.',
  type_text: 'In buddy: always pass `pid`.',
  launch_app: 'In buddy: by `bundle_id` only.',
};

const tools = JSON.parse(fs.readFileSync(source, 'utf8')).tools;
const byName = new Map(tools.map((t) => [t.name, t]));

const out = CURATED.map((name) => {
  const t = byName.get(name);
  if (!t) throw new Error(`tools.json has no ${name}`);
  const schema = structuredClone(t.inputSchema);
  const strip = new Set([...STRIP, ...(STRIP_PER_TOOL[name] ?? [])]);
  for (const k of Object.keys(schema.properties ?? {})) if (strip.has(k)) delete schema.properties[k];
  const required = new Set((schema.required ?? []).filter((k) => !strip.has(k)));
  for (const k of REQUIRE[name] ?? []) required.add(k);
  schema.required = [...required];
  return {
    name,
    description: NOTE[name] ? `${t.description}\n\n${NOTE[name]}` : t.description,
    input_schema: schema,
  };
});

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ source: 'cua-driver tools/list', tools: out }, null, 2) + '\n');
const bytes = fs.statSync(target).size;
console.log(`${out.length} tools → ${path.relative(root, target)} (${bytes} bytes)`);
