import React, { useEffect, useState } from 'react';
import { api } from '../useBuddy.js';
import { Button, Card, Field, NumberInput, StatusDot, Toggle } from '../components/primitives.js';
import { PermissionsPanel } from './Permissions.js';
import type { Permissions, SecretsStatus, Settings, SidecarStatus } from '../../shared/types.js';

/// Settings (PRD §8.6). M1 ships the parts M1 has: keys, capture interval,
/// retention, hotkeys, exclusions, and live permission status. Allowlists,
/// profiles, and the spend meter arrive with the Operator.

export function SettingsView({
  settings,
  permissions,
  sidecar,
  update,
}: {
  settings: Settings | null;
  permissions: Permissions | null;
  sidecar: SidecarStatus | null;
  update: (patch: Partial<Settings>) => Promise<void>;
}) {
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [recording, setRecording] = useState<null | 'hotkey' | 'abortHotkey'>(null);

  useEffect(() => {
    void api.getSecretsStatus().then(setSecrets);
  }, []);

  // The hotkey recorder: capture the next chord, translate to an Electron
  // accelerator, and refuse a bare key — a single-character global shortcut
  // would swallow that key everywhere on the system.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Command');
      const key = normalizeKey(e);
      if (!key || mods.length === 0) return;
      void update({ [recording]: [...mods, key].join('+') } as Partial<Settings>);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, update]);

  if (!settings) return null;

  const saveKey = async () => {
    setKeyError(null);
    try {
      setSecrets(await api.setSecret('anthropic', keyDraft.trim()));
      setKeyDraft('');
    } catch (e) {
      setKeyError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-7">
      <Section title="Permissions" hint="Live state, re-checked every two seconds.">
        <PermissionsPanel permissions={permissions} sidecar={sidecar} />
      </Section>

      <Section
        title="API keys"
        hint="Stored with Electron safeStorage, which is Keychain-backed on macOS. Never written to the database, never written to a log."
      >
        <Card className="flex flex-col gap-4 p-4">
          <Field
            label="Anthropic API key"
            hint={
              secrets?.encryptionAvailable === false
                ? 'OS encryption is unavailable on this machine, so buddy will refuse to store a key rather than keep it in plaintext.'
                : 'Required. Computer use is Claude-only — no other provider supports it.'
            }
          >
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={keyDraft}
                placeholder={secrets?.anthropic ? '•••••••••••••• (stored)' : 'sk-ant-…'}
                onChange={(e) => setKeyDraft(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5
                           font-mono text-[12px] text-fog-100 outline-none focus:border-ember-500/70"
              />
              <Button variant="accent" disabled={!keyDraft.trim()} onClick={() => void saveKey()}>
                Save
              </Button>
              {secrets?.anthropic && (
                <Button
                  variant="danger"
                  onClick={() => void api.clearSecret('anthropic').then(setSecrets)}
                >
                  Remove
                </Button>
              )}
            </div>
          </Field>
          {keyError && <p className="text-[11px] text-rust-400">{keyError}</p>}
          <div className="flex items-center gap-2 text-[11px] text-fog-500">
            <StatusDot ok={!!secrets?.anthropic} />
            {secrets?.anthropic ? 'A key is stored in the Keychain.' : 'No key stored yet.'}
          </div>
        </Card>
      </Section>

      <Section title="Observation" hint="How often buddy looks, and how long what it sees survives.">
        <Card className="flex flex-col gap-5 p-4">
          <Field
            label="Capture interval"
            hint="How often a screenshot is taken. Near-identical frames are discarded, so a shorter interval costs less disk than it looks."
          >
            <NumberInput
              value={Math.round(settings.captureIntervalMs / 1000)}
              min={3}
              max={300}
              onChange={(n) => void update({ captureIntervalMs: n * 1000 })}
              suffix="seconds"
            />
          </Field>

          <Field
            label="Retention"
            hint="Frames are deleted this many days after capture. Notes made from them are kept forever."
          >
            <NumberInput
              value={settings.retentionDays}
              min={1}
              max={7}
              onChange={(n) => void update({ retentionDays: n })}
              suffix={settings.retentionDays === 1 ? 'day' : 'days'}
            />
          </Field>

          <Field
            label="Duplicate threshold"
            hint="Perceptual-hash distance below which a frame counts as a duplicate. Lower keeps more; 8 is the tuned default."
          >
            <NumberInput
              value={settings.phashThreshold}
              min={0}
              max={32}
              onChange={(n) => void update({ phashThreshold: n })}
              suffix="hamming distance"
            />
          </Field>

          <Field label="Skip when idle" hint="Stop capturing after this much time with no input.">
            <NumberInput
              value={settings.idleSkipSeconds}
              min={10}
              max={3600}
              onChange={(n) => void update({ idleSkipSeconds: n })}
              suffix="seconds"
            />
          </Field>

          <div className="flex items-center justify-between border-t border-ink-700/60 pt-4">
            <div>
              <p className="text-[12px] font-medium text-fog-100">Pause observation</p>
              <p className="mt-0.5 text-[11px] text-fog-500">
                Halts capture entirely. No screenshots, no model calls.
              </p>
            </div>
            <Toggle
              checked={settings.paused}
              label="Pause observation"
              onChange={(v) => void api.setPaused(v)}
            />
          </div>
        </Card>
      </Section>

      <Section title="Hotkeys" hint="Click to record a new chord. A modifier is required.">
        <Card className="flex flex-col gap-3 p-4">
          <HotkeyRow
            label="Activate buddy"
            value={settings.hotkey}
            recording={recording === 'hotkey'}
            onRecord={() => setRecording('hotkey')}
          />
          <HotkeyRow
            label="Abort a run"
            value={settings.abortHotkey}
            recording={recording === 'abortHotkey'}
            onRecord={() => setRecording('abortHotkey')}
          />
        </Card>
      </Section>

      <Section
        title="Exclusions"
        hint="Apps and window titles that are never captured. A frame is also skipped whenever a password field has focus, whichever app it is in."
      >
        <Card className="flex flex-col divide-y divide-ink-700/50 p-1">
          {settings.exclusions.map((rule, i) => (
            <div key={`${rule.label}-${i}`} className="flex items-center justify-between gap-4 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[12px] text-fog-100">{rule.label}</p>
                <p className="truncate font-mono text-[10px] text-fog-500">
                  {rule.bundleId ?? `title ~ /${rule.titlePattern}/i`}
                </p>
              </div>
              <Toggle
                checked={rule.enabled}
                label={`Exclude ${rule.label}`}
                onChange={(v) => {
                  const next = settings.exclusions.map((r, j) => (j === i ? { ...r, enabled: v } : r));
                  void update({ exclusions: next });
                }}
              />
            </div>
          ))}
        </Card>
      </Section>

      <Section title="Motion" hint="buddy also honours the system Reduce Motion setting automatically.">
        <Card className="flex items-center justify-between p-4">
          <p className="text-[12px] text-fog-100">Force reduced motion</p>
          <Toggle
            checked={settings.reducedMotion}
            label="Force reduced motion"
            onChange={(v) => void update({ reducedMotion: v })}
          />
        </Card>
      </Section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-[13px] font-medium text-fog-100">{title}</h3>
        {hint && <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-fog-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function HotkeyRow({
  label,
  value,
  recording,
  onRecord,
}: {
  label: string;
  value: string;
  recording: boolean;
  onRecord: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[12px] text-fog-100">{label}</span>
      <button
        onClick={onRecord}
        className={`no-drag rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors ${
          recording
            ? 'animate-pulse border-ember-500 bg-ember-500/10 text-ember-300'
            : 'border-ink-700 bg-ink-900 text-fog-300 hover:border-ink-600'
        }`}
      >
        {recording ? 'press a chord… (esc to cancel)' : prettyAccelerator(value)}
      </button>
    </div>
  );
}

function prettyAccelerator(a: string): string {
  return a
    .replace('Command', '⌘')
    .replace('Alt', '⌥')
    .replace('Control', '⌃')
    .replace('Shift', '⇧')
    .replaceAll('+', ' ');
}

/** Browser key names → Electron accelerator names. */
function normalizeKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return null;
  const map: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
    Enter: 'Return',
    '.': 'Period',
    ',': 'Comma',
  };
  if (map[k]) return map[k];
  if (k.length === 1) return k.toUpperCase();
  if (/^F\d{1,2}$/.test(k)) return k;
  return null;
}
