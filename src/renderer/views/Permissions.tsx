import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { Button, Card, StatusDot, spring, useMotionSafe } from '../components/primitives.js';
import type { Permissions as Perms, SidecarStatus } from '../../shared/types.js';

/// Live permission status with Grant buttons (PRD §8.6). Two things this must
/// get right: it shows the state right now rather than what it was at launch,
/// and it tells the truth about what each grant is *for*.

const ROWS: {
  key: keyof Perms;
  title: string;
  why: string;
  note?: string;
}[] = [
  {
    key: 'screenRecording',
    title: 'Screen Recording',
    why: 'buddy screenshots the screen every 15 seconds to build its memory of your work. Without it, buddy is blind and captures nothing.',
    note: 'macOS may require quitting and reopening buddy after you grant this.',
  },
  {
    key: 'accessibility',
    title: 'Accessibility',
    why: 'Reads window titles and the accessibility tree, which is how buddy knows a password field has focus and skips the frame entirely. Required for buddy to control the computer in M2.',
  },
];

export function PermissionsPanel({
  permissions,
  sidecar,
}: {
  permissions: Perms | null;
  sidecar: SidecarStatus | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const safe = useMotionSafe();

  const grant = async (key: keyof Perms) => {
    setBusy(key);
    try {
      // Trigger the system prompt, then open the pane too. The prompt only
      // appears once per app per permission; after that the pane is the only
      // route, and a Grant button that appears to do nothing is worse than one
      // that takes you somewhere.
      await api.requestPermission(key);
      await api.openPermissionSettings(key);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {ROWS.map((row, i) => {
        const granted = permissions?.[row.key] ?? false;
        return (
          <motion.div
            key={row.key}
            initial={safe ? { opacity: 0, y: 8 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={safe ? { ...spring, delay: i * 0.05 } : { duration: 0 }}
          >
            <Card className="p-4">
              <div className="flex items-start justify-between gap-5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusDot ok={granted} />
                    <h3 className="text-[13px] font-medium text-fog-100">{row.title}</h3>
                    <span
                      className={`font-mono text-[10px] uppercase tracking-wider ${
                        granted ? 'text-moss-400' : 'text-rust-400'
                      }`}
                    >
                      {granted ? 'granted' : 'not granted'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-fog-500">{row.why}</p>
                  {!granted && row.note && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-ember-300/80">{row.note}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  {!granted && (
                    <Button variant="accent" disabled={busy === row.key} onClick={() => void grant(row.key)}>
                      {busy === row.key ? 'Opening…' : 'Grant'}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => void api.openPermissionSettings(row.key)}>
                    Open Settings
                  </Button>
                </div>
              </div>
            </Card>
          </motion.div>
        );
      })}

      {sidecar && !sidecar.running && (
        <Card className="border-rust-400/40 bg-rust-400/5 p-4">
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-[13px] font-medium text-fog-100">
                <StatusDot ok={false} />
                buddyd is not running
              </h3>
              <p className="mt-1.5 text-[12px] leading-relaxed text-fog-500">
                Every macOS capability lives in the sidecar. While it is down, buddy cannot
                capture, read window titles, or check permissions.
              </p>
              {sidecar.lastError && (
                <p className="mt-2 font-mono text-[11px] leading-relaxed break-all text-rust-400/90">
                  {sidecar.lastError}
                </p>
              )}
            </div>
            <Button onClick={() => void api.restartSidecar()}>Restart</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
