import fs from 'node:fs';
import { nativeImage } from 'electron';
import { log } from '../log.js';

/// Downscaling frames for the Observer (PRD §5, "tier sizing gotcha").
///
/// **These constants are the Observer's and belong to nobody else.** Haiku 4.5
/// caps images at 1568 px on the long edge and about 1.15 MP; Opus 5 caps at
/// 2576 px and 3.75 MP and lives in `Capture.swift` and the executor. Sharing
/// one constant between them would silently break whichever tier changed
/// second — and the failure mode is not an error, it is a 400 on the cheap tier
/// that looks like the observer being broken, or a quietly wasted 2.6× on image
/// tokens for every observation of every day.
///
/// So: two ceilings, two homes, and a check that asserts they are different.

export const OBSERVER_MAX_LONG_EDGE = 1568;
export const OBSERVER_MAX_PIXELS = 1_150_000;

/** PRD §5 names 1366×768 explicitly: 1.05 MP, inside both bounds, and a
 *  familiar aspect that does not letterbox a 16:10 Mac display. */
export const OBSERVER_TARGET = { width: 1366, height: 768 } as const;

export interface Downscaled {
  base64: string;
  width: number;
  height: number;
  /** 1 when the frame already fit — the common case only on small displays. */
  scale: number;
}

/** The factor that fits `w×h` inside the Observer's box, never upscaling. */
export function observerScale(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.min(
    1,
    OBSERVER_TARGET.width / w,
    OBSERVER_TARGET.height / h,
    OBSERVER_MAX_LONG_EDGE / Math.max(w, h),
    Math.sqrt(OBSERVER_MAX_PIXELS / (w * h)),
  );
}

/**
 * Read a vault frame and re-encode it small enough for Haiku.
 *
 * Done with Electron's `nativeImage` rather than a sidecar round trip: the
 * frames are already on disk at logical resolution, the main process is where
 * the decision is made, and adding an RPC for a resize would put the Observer's
 * image ceiling behind a TCC-gated binary for no benefit.
 *
 * Returns null rather than throwing when the file is gone — a frame that
 * expired between being selected and being read is the retention sweep doing
 * its job, not an error, and the observation should still go out with the
 * frames that remain.
 */
export function downscaleFrame(path: string): Downscaled | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path);
  } catch {
    return null;
  }
  const img = nativeImage.createFromBuffer(raw);
  if (img.isEmpty()) {
    log.warn('observer', 'frame did not decode as an image', { path });
    return null;
  }
  const { width, height } = img.getSize();
  const scale = observerScale(width, height);
  if (scale >= 1) {
    return { base64: raw.toString('base64'), width, height, scale: 1 };
  }
  const out = img.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good',
  });
  const size = out.getSize();
  return { base64: out.toPNG().toString('base64'), width: size.width, height: size.height, scale };
}
