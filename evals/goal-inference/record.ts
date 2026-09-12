/**
 * buddy · record real-screenshot fixtures
 *
 *   npm run eval:record            # write fixtures/*.shot.json and PNGs
 *   npm run eval:record -- --png   # also keep the PNGs for eyeballing
 *
 * Closes the gap the eval README has carried since M1: the fixtures have only
 * ever tested *prose about* a screen, which exercises signal weighting,
 * calibration and injection resistance but **not visual grounding** — reading a
 * timestamp off a message, finding a cursor in an empty section, telling a
 * scrolled-past diff from an edited field. That is where the production risk is.
 *
 * **What these screenshots are, precisely.** They are reconstructions of the
 * scenes the text fixtures describe, rendered as real HTML at real frame
 * dimensions (1728×1117, a 16" MacBook Pro in points) and captured through
 * Electron's renderer. They are not captures of anyone's live desktop, and they
 * are not claimed to be: a genuine desktop carries notification banners, half-
 * occluded windows, and whatever else was open, and it also carries the user's
 * actual private data, which is not something to check into a repository.
 *
 * So this is an honest middle: the model now has to read the goal out of
 * rendered pixels — real fonts at real sizes, real chrome, real compression,
 * a sidebar of things that are not the task — rather than out of a sentence
 * that already contains the answer. It is meaningfully harder than the prose
 * and meaningfully easier than a live machine, and the README says so.
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { FRAME_WIDTH, FRAME_HEIGHT } from './scenes/chrome.js';
import { SCENES } from './scenes/index.js';

// Resolved from the project root, not from `import.meta.url`: this file is
// bundled into `out/main/` before Electron runs it, and a path relative to the
// bundle points at a directory that does not exist.
const HERE = path.join(process.cwd(), 'evals', 'goal-inference');
const FIXTURES = path.join(HERE, 'fixtures');
const SHOTS = path.join(HERE, 'shots');

const keepPng = process.argv.includes('--png');

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });

  const win = new BrowserWindow({
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    show: false,
    webPreferences: { offscreen: true, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(2);

  const byFixture = new Map<string, Map<number, string>>();

  for (const scene of SCENES) {
    const file = path.join(SHOTS, `${scene.fixture}-${scene.frame}.html`);
    fs.writeFileSync(file, scene.html);
    await win.loadFile(file);
    // Offscreen rendering paints on its own schedule; one frame of slack is the
    // difference between a screenshot and a white rectangle.
    await new Promise((r) => setTimeout(r, 350));
    const native = await win.webContents.capturePage();
    const nativeSize = native.getSize();
    // Chromium captures at the display's backing scale, exactly as
    // ScreenCaptureKit does. buddy downscales Retina pixels to logical points so
    // model coordinates map 1:1 onto CGEvent points (PRD §6.2), and the recorded
    // frames go through the same step — otherwise these fixtures would be twice
    // the resolution of anything the Operator will ever see.
    const image =
      nativeSize.width === FRAME_WIDTH && nativeSize.height === FRAME_HEIGHT
        ? native
        : native.resize({ width: FRAME_WIDTH, height: FRAME_HEIGHT, quality: 'good' });
    const size = image.getSize();
    if (size.width !== FRAME_WIDTH || size.height !== FRAME_HEIGHT) {
      throw new Error(
        `${scene.fixture}#${scene.frame} is ${size.width}x${size.height}, expected ${FRAME_WIDTH}x${FRAME_HEIGHT}`,
      );
    }
    const png = image.toPNG();
    if (keepPng) fs.writeFileSync(path.join(SHOTS, `${scene.fixture}-${scene.frame}.png`), png);
    fs.unlinkSync(file);

    if (!byFixture.has(scene.fixture)) byFixture.set(scene.fixture, new Map());
    byFixture.get(scene.fixture)!.set(scene.frame, png.toString('base64'));
    console.log(
      `  ${scene.fixture} frame ${scene.frame}  ${nativeSize.width}x${nativeSize.height} → ` +
        `${size.width}x${size.height}  ${Math.round(png.length / 1024)} KB`,
    );
  }

  // The recorded fixture is the text one with `imageBase64` added and
  // `description` removed — same bundle, same assertions, different modality.
  // Written beside the original rather than over it so both can be run and the
  // numbers compared, which is the whole point of the exercise.
  for (const [fixture, frames] of byFixture) {
    const src = path.join(FIXTURES, `${fixture}.json`);
    const parsed = JSON.parse(fs.readFileSync(src, 'utf8')) as {
      name: string;
      bundle: { frames: { description?: string; imageBase64?: string }[] };
    };
    parsed.name = `${parsed.name} (shot)`;
    parsed.bundle.frames.forEach((f, i) => {
      const b64 = frames.get(i);
      if (!b64) throw new Error(`${fixture} has no recorded scene for frame ${i}`);
      delete f.description;
      f.imageBase64 = b64;
    });
    const out = path.join(FIXTURES, `${fixture}.shot.json`);
    fs.writeFileSync(out, JSON.stringify(parsed, null, 2));
    const mb = fs.statSync(out).size / 1e6;
    console.log(`→ ${path.basename(out)}  ${mb.toFixed(1)} MB`);
  }

  win.destroy();
  console.log(`\n${SCENES.length} scenes recorded into ${byFixture.size} fixtures.\n`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error(e);
    app.exit(1);
  }),
);
