import React, { useEffect, useState } from 'react';
import { api } from '../useBuddy.js';
import { Button, Card, Field, NumberInput, StatusDot, Toggle } from '../components/primitives.js';
import { PermissionsPanel } from './Permissions.js';
import type {
  NotesStats,
  Permissions,
  SecretsStatus,
  Settings,
  SidecarStatus,
  SpendReport,
  SpendTier,
} from '../../shared/types.js';

/// Settings (PRD §8.6): keys, capture, retention, hotkeys, exclusions, live
/// permission status, the Observer's tiers, and the daily spend meter.
///
/// The spend meter is not decoration. PRD R5 is "observation cost runs away",
/// and the mitigation is only real if the number is in front of the person who
/// can act on it — a cap that silently pauses the product is worse than no cap,
/// because the symptom is "buddy stopped remembering things" with no cause
/// attached.

export function SettingsView({
  settings,
  permissions,
  sidecar,
  spend,
  notesStats,
  update,
}: {
  settings: Settings | null;
  permissions: Permissions | null;
  sidecar: SidecarStatus | null;
  spend: SpendReport | null;
  notesStats: NotesStats | null;
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

      <Section
        title="Spend"
        hint="Every model call buddy makes today. The cap pauses observing and summarising when it is reached — it never blocks the hotkey, because that is money you asked it to spend."
      >
        <SpendPanel spend={spend} settings={settings} notesStats={notesStats} update={update} />
      </Section>

      <Section
        title="Memory"
        hint="The two tiers that turn screenshots into notes. Both stop when the daily cap is reached."
      >
        <Card className="flex flex-col gap-5 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[12px] font-medium text-fog-100">Build a memory</p>
              <p className="mt-0.5 max-w-md text-[11px] leading-relaxed text-fog-500">
                Off, buddy still captures and still runs a goal you type — it just stops summarising
                what it sees, and the hotkey has nothing to infer from.
              </p>
            </div>
            <Toggle
              checked={settings.notesEnabled}
              label="Build a memory"
              onChange={(v) => void update({ notesEnabled: v })}
            />
          </div>

          <Field
            label="Observe every"
            hint="How often buddy summarises what it has seen. A change of application also triggers one, no more often than the gap below."
          >
            <NumberInput
              value={Math.round(settings.observeIntervalMs / 60_000)}
              min={1}
              max={30}
              onChange={(n) => void update({ observeIntervalMs: n * 60_000 })}
              suffix="minutes"
            />
          </Field>

          <Field
            label="Minimum gap after a context switch"
            hint="Stops alt-tabbing between two windows from billing an observation per switch."
          >
            <NumberInput
              value={Math.round(settings.observeMinGapMs / 1000)}
              min={15}
              max={600}
              onChange={(n) => void update({ observeMinGapMs: n * 1000 })}
              suffix="seconds"
            />
          </Field>

          <Field
            label="Summarise every"
            hint="Observations become a recap note, and relations and tasks are merged. Also runs when a session ends and at midnight."
          >
            <NumberInput
              value={Math.round(settings.rollupIntervalMs / 60_000)}
              min={10}
              max={360}
              onChange={(n) => void update({ rollupIntervalMs: n * 60_000 })}
              suffix="minutes"
            />
          </Field>

          <Field
            label="A session ends after"
            hint="A contiguous run of activity. Going idle for longer than this, or the display sleeping, closes it and writes a recap."
          >
            <NumberInput
              value={Math.round(settings.sessionIdleMs / 60_000)}
              min={1}
              max={60}
              onChange={(n) => void update({ sessionIdleMs: n * 60_000 })}
              suffix="minutes"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2.5 border-t border-ink-700/60 pt-4">
            <Button onClick={() => void api.observeNow()}>Observe now</Button>
            <Button onClick={() => void api.rollupNow()}>Summarise now</Button>
            <span className="text-[11px] text-fog-500">
              The tiers are invisible by design. These make one happen so you can see that it does.
            </span>
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

      <Section
        title="Leashless mode"
        hint="A third profile, off by default. Turning it on here is what makes it selectable when you run something."
      >
        <Card className={`p-4 ${settings.leashlessEnabled ? 'border-rust-400/50' : ''}`}>
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-fog-100">
                Let buddy run with nothing asking you
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
                Unattended, with every gate open. buddy can send messages and email, delete files
                outside its scratch directory, install software, complete a purchase, and type
                passwords, card numbers and API keys — with nobody watching and no confirmation.
                The app allowlist does not apply to it.
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-fog-500">
                The guardrails are heuristics and defence in depth even when they are enforcing.
                With this selected there is nothing between a wrong guess about what you were doing
                and your machine except the kill switches and the budgets — both of which still
                work. You pick it per run; this only decides whether it is offered.
              </p>
            </div>
            <Toggle
              checked={settings.leashlessEnabled}
              label="Enable leashless mode"
              onChange={(v) => {
                if (
                  v &&
                  !confirm(
                    'Enable leashless mode?\n\n' +
                      'buddy will be able to send messages and email, delete files, install ' +
                      'software, make purchases, and type credentials — unattended, without ' +
                      'asking. You still choose it per run, and Stop still works.',
                  )
                ) {
                  return;
                }
                void update({ leashlessEnabled: v });
              }}
            />
          </div>
          {settings.leashlessEnabled && (
            <p className="mt-3.5 rounded-lg border border-rust-400/40 bg-rust-400/10 px-3 py-2 text-[11px] leading-relaxed text-rust-400">
              Leashless is available in the HUD. It is never the default and never buddy’s
              suggestion — you have to choose it each time.
            </p>
          )}
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

const TIER_LABEL: Record<SpendTier, string> = {
  t2: 'observing',
  t3: 'summarising',
  inference: 'reading the screen on the hotkey',
  operator: 'runs',
  'wake-check': 'standby checks',
};

function SpendPanel({
  spend,
  settings,
  notesStats,
  update,
}: {
  spend: SpendReport | null;
  settings: Settings;
  notesStats: NotesStats | null;
  update: (patch: Partial<Settings>) => Promise<void>;
}) {
  if (!spend) return null;
  const pct = spend.capUsd > 0 ? Math.min(1, spend.total / spend.capUsd) : 0;
  const peak = Math.max(0.01, ...spend.history.map((h) => h.total));
  const tiers = (Object.keys(TIER_LABEL) as SpendTier[]).filter((t) => spend.byTier[t] > 0);

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[22px] leading-none tabular-nums text-fog-100">
            ${spend.total.toFixed(2)}
          </p>
          <p className="mt-1 text-[11px] text-fog-500">
            today, across {spend.calls} call{spend.calls === 1 ? '' : 's'}
            {notesStats ? ` · ${notesStats.observations} observations kept` : ''}
          </p>
        </div>
        {/* Seven days, so "is today unusual" is answerable at a glance — which
            is the actual question behind R5. */}
        <div className="flex h-9 items-end gap-1" aria-hidden>
          {spend.history.map((h) => (
            <span
              key={h.day}
              title={`${h.day}: $${h.total.toFixed(2)}`}
              className={`w-2 rounded-sm ${h.day === spend.day ? 'bg-ember-500' : 'bg-ink-600'}`}
              style={{ height: `${Math.max(4, (h.total / peak) * 36)}px` }}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              spend.capped ? 'bg-rust-400' : pct > 0.75 ? 'bg-ember-400' : 'bg-moss-400'
            }`}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-fog-500">
          {spend.capped ? (
            <span className="text-rust-400">
              Cap reached. Observing and summarising are paused until tomorrow. The hotkey still works.
            </span>
          ) : (
            `${Math.round(pct * 100)}% of the $${spend.capUsd.toFixed(2)} daily cap. PRD's budget is $1.50–2.50 for an 8-hour day.`
          )}
        </p>
      </div>

      {tiers.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-ink-700/60 pt-3 font-mono text-[11px] tabular-nums">
          {tiers.map((t) => (
            <div key={t} className="flex items-baseline justify-between gap-3">
              <span className="text-fog-500">{TIER_LABEL[t]}</span>
              <span className="text-fog-300">${spend.byTier[t].toFixed(3)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-ink-700/60 pt-4">
        <Field label="Daily cap" hint="Zero pauses observing entirely.">
          <NumberInput
            value={settings.dailyCapUsd}
            min={0}
            max={50}
            step={0.5}
            onChange={(n) => void update({ dailyCapUsd: n })}
            suffix="USD"
          />
        </Field>
        <Button onClick={() => void api.resetSpend()}>Reset today</Button>
      </div>
    </Card>
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
