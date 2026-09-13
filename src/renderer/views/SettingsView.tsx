import React, { useEffect, useState } from 'react';
import { api } from '../useBuddy.js';
import { Button, Card, Field, NumberInput, StatusDot, Toggle } from '../components/primitives.js';
import { PermissionsPanel } from './Permissions.js';
import type {
  NotesStats,
  OperatorAvailability,
  Permissions,
  ProviderStatus,
  RunProfile,
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
  providers,
  operator,
  update,
}: {
  settings: Settings | null;
  permissions: Permissions | null;
  sidecar: SidecarStatus | null;
  spend: SpendReport | null;
  notesStats: NotesStats | null;
  providers: ProviderStatus[];
  operator: OperatorAvailability | null;
  update: (patch: Partial<Settings>) => Promise<void>;
}) {
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [openaiDraft, setOpenaiDraft] = useState('');
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
        {/* PRD R2, and it cost the M1 session a morning: macOS records the
            Screen Recording grant against the bundle's cdhash, so re-signing
            revokes it while System Settings keeps showing the toggle ON. A user
            staring at a green permission and a blind buddy needs to be told
            this is a known failure with a known fix, not left to conclude the
            capture code is broken. */}
        {permissions?.screenRecording && (sidecar?.captureBackend === 'none' || !!sidecar?.lastError) && (
          <Card className="border-ember-400/40 bg-ember-500/5 p-3.5">
            <p className="text-[12px] leading-relaxed text-ember-300">
              <span className="font-medium">macOS reports Screen Recording granted, but capture is
              failing.</span>{' '}
              That combination almost always means the app was re-signed after the grant: macOS
              records it against the bundle&rsquo;s code hash, and an ad-hoc signature produces a new
              one every build. Run{' '}
              <span className="font-mono">./scripts/make-signing-cert.sh</span> once, re-sign with{' '}
              <span className="font-mono">./scripts/sign-app.sh</span>, then toggle buddy off and on
              in System Settings &rsaquo; Privacy &amp; Security &rsaquo; Screen Recording.
            </p>
          </Card>
        )}
      </Section>

      <Section
        title="Providers"
        hint="Which model answers what. One row of this table is not a preference: computer use is Claude-only."
      >
        <ProviderPanel
          providers={providers}
          operator={operator}
          settings={settings}
          update={update}
        />
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
            <StatusDot
              ok={!!secrets?.anthropic && !secrets.undecryptable.includes('anthropic')}
              warn={secrets?.undecryptable.includes('anthropic')}
            />
            {secrets?.anthropic ? 'A key is stored in the Keychain.' : 'No key stored yet.'}
          </div>

          {/* Stored and unreadable is a different state from "no key", and it
              has a different fix. Showing a green dot beside a key nothing can
              decrypt is the §11.1 failure again: it looks fine and does
              nothing. */}
          {secrets && secrets.undecryptable.length > 0 && (
            <p className="rounded-lg border border-ember-500/40 bg-ember-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-ember-300">
              <span className="font-medium">
                buddy has a stored {secrets.undecryptable.join(' and ')} key it cannot read.
              </span>{' '}
              macOS ties a Keychain item to the exact binary that wrote it, so re-signing the app
              invalidates it — unlike the Screen Recording grant, which survives. Paste the key in
              again above and it will be re-encrypted for this build.
            </p>
          )}

          <div className="border-t border-ink-700/60 pt-4">
            <Field
              label="OpenAI API key"
              hint="Optional, and only for observing and answering questions. It cannot drive the machine — there is no equivalent of computer_toolset_20260801, so the hotkey still needs the Anthropic key above."
            >
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={openaiDraft}
                  placeholder={secrets?.openai ? '•••••••••••••• (stored)' : 'sk-…'}
                  onChange={(e) => setOpenaiDraft(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5
                             font-mono text-[12px] text-fog-100 outline-none focus:border-ember-500/70"
                />
                <Button
                  disabled={!openaiDraft.trim()}
                  onClick={() => {
                    setKeyError(null);
                    void api
                      .setSecret('openai', openaiDraft.trim())
                      .then((st) => {
                        setSecrets(st);
                        setOpenaiDraft('');
                      })
                      .catch((e: Error) => setKeyError(e.message));
                  }}
                >
                  Save
                </Button>
                {secrets?.openai && (
                  <Button variant="danger" onClick={() => void api.clearSecret('openai').then(setSecrets)}>
                    Remove
                  </Button>
                )}
              </div>
            </Field>
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

      <Section
        title="Runs"
        hint="What a run starts with when goal inference has not seeded it. The allowlist is per run and confirmed in the same keystroke as the goal — this is the fallback, and what a typed goal uses."
      >
        <Card className="flex flex-col gap-5 p-4">
          <Field
            label="Default profile"
            hint="Which one the HUD opens on. Leashless is deliberately not offered here: buddy never suggests it, and a default is a suggestion made once and then never reconsidered."
          >
            <div className="flex gap-2">
              {(['attended', 'unattended'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => void update({ defaultProfile: p })}
                  className={`no-drag flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                    settings.defaultProfile === p
                      ? 'border-ember-500/60 bg-ember-500/10'
                      : 'border-ink-700 bg-ink-900 hover:border-ink-600'
                  }`}
                >
                  <span className="text-[12px] font-medium text-fog-100">{p}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-fog-500">
                    {p === 'attended'
                      ? 'Anything that sends, deletes, or installs asks you first.'
                      : 'Those are refused outright and the run stops.'}
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Step budget" hint="Tool calls.">
              <NumberInput
                value={settings.budgetMaxSteps}
                min={1}
                max={500}
                onChange={(n) => void update({ budgetMaxSteps: n })}
                suffix="steps"
              />
            </Field>
            <Field label="Time budget" hint="Wall clock.">
              <NumberInput
                value={Math.round(settings.budgetMaxWallClockMs / 60_000)}
                min={1}
                max={120}
                onChange={(n) => void update({ budgetMaxWallClockMs: n * 60_000 })}
                suffix="minutes"
              />
            </Field>
            <Field label="Cost budget" hint="Per run.">
              <NumberInput
                value={settings.budgetMaxCostUsd}
                min={0.05}
                max={50}
                step={0.25}
                onChange={(n) => void update({ budgetMaxCostUsd: n })}
                suffix="USD"
              />
            </Field>
          </div>
          <p className="-mt-1 text-[11px] leading-relaxed text-fog-500">
            Hitting any one of the three parks the run in <span className="font-mono">needs_human</span>{' '}
            with its log intact. They restart when a run comes back from standby, because a run that
            waited forty minutes would otherwise blow the clock before its first click — the run log
            still shows the cumulative total.
          </p>

          <ListField
            label="App allowlist"
            hint="macOS bundle ids, one per line. In unattended mode buddy will not open an app that is not on this list; in attended mode it asks first."
            value={settings.allowlistApps}
            placeholder={'com.apple.Safari\ncom.tinyspeck.slackmacgap'}
            onChange={(v) => void update({ allowlistApps: v })}
          />
          <ListField
            label="Domain allowlist"
            hint="Hostnames, one per line, matched on suffix — notion.so covers www.notion.so. Read from the browser's address bar through the accessibility tree."
            value={settings.allowlistDomains}
            placeholder={'notion.so\nlinear.app'}
            onChange={(v) => void update({ allowlistDomains: v })}
          />
        </Card>
      </Section>

      <Section
        title="Standby"
        hint="How often buddy looks for a due wakeup. It polls rather than holding a timer, because a Mac that slept through the last half hour does not fire the timers it slept through."
      >
        <Card className="flex flex-col gap-4 p-4">
          <Field label="Check for due wakeups every" hint="The wakeup's own interval decides how often it actually looks; this is only how precisely buddy notices one is due.">
            <NumberInput
              value={Math.round(settings.wakePollMs / 1000)}
              min={2}
              max={120}
              onChange={(n) => void update({ wakePollMs: n * 1000 })}
              suffix="seconds"
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-fog-500">
            A pending wakeup is a row in SQLite, so quitting buddy does not cancel it — the next
            launch picks it back up. Each check is one screenshot through Haiku, a fraction of a
            cent, which is what makes checking every five minutes for an hour affordable.
          </p>
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
        <ExclusionEditor settings={settings} update={update} />
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
  qa: 'answering questions',
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

/// §9.1's matrix, on screen.
///
/// The requirement is exact: *"Settings must make that unambiguous rather than
/// letting a user configure OpenAI and wonder why activation is greyed out."*
/// So the table is not a provider picker with a caveat underneath — the
/// capability column **is** the control's context, and the Operator row is
/// rendered separately with the same sentence `orchestrator.start()` throws.
function ProviderPanel({
  providers,
  operator,
  settings,
  update,
}: {
  providers: ProviderStatus[];
  operator: OperatorAvailability | null;
  settings: Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
}) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[11px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.09em] text-fog-500">
              <th className="pb-2 pr-3 font-normal">Provider</th>
              <th className="pb-2 pr-3 font-normal">Drive the machine</th>
              <th className="pb-2 pr-3 font-normal">Observe</th>
              <th className="pb-2 pr-3 font-normal">Answer questions</th>
              <th className="pb-2 font-normal">Configured</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id} className="border-t border-ink-700/50 align-top">
                <td className="py-2 pr-3">
                  <span className="text-[12px] text-fog-100">{p.label}</span>
                  <span className="mt-0.5 block max-w-xs text-[10px] leading-relaxed text-fog-500">
                    {p.note}
                  </span>
                </td>
                <td className="py-2 pr-3">
                  {p.capabilities.computerUse ? (
                    <span className="text-moss-400">yes</span>
                  ) : (
                    <span className="text-fog-500">
                      no — <span className="whitespace-nowrap">not supported</span>
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {p.capabilities.vision ? (
                    <span className="text-moss-400">yes</span>
                  ) : (
                    <span className="text-fog-500">no</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-moss-400">yes</td>
                <td className="py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot ok={p.configured} warn={!p.configured && p.id !== 'anthropic'} />
                    <span className="font-mono text-[10px] text-fog-500">
                      {p.configured ? p.models.observe : 'not set up'}
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        className={`rounded-lg border px-3 py-2.5 text-[11px] leading-relaxed ${
          operator?.available
            ? 'border-moss-400/30 bg-moss-400/5 text-fog-300'
            : 'border-ember-500/40 bg-ember-500/10 text-ember-300'
        }`}
      >
        {operator?.available ? (
          <>
            <span className="font-medium">The hotkey can take over the machine.</span> Computer use
            runs on Claude Opus 5 with <span className="font-mono">computer_toolset_20260801</span>,
            whatever the two dropdowns below are set to.
          </>
        ) : (
          <>
            <span className="font-medium">The hotkey cannot take over the machine.</span>{' '}
            {operator?.reason}
          </>
        )}
      </div>

      <div className="grid gap-4 border-t border-ink-700/60 pt-4 sm:grid-cols-2">
        <Field label="Observing and summarising" hint="T2 and T3 — a vision model, run every few minutes.">
          <ProviderSelect
            value={settings.observerProvider}
            providers={providers}
            need="vision"
            onChange={(v) => void update({ observerProvider: v })}
          />
        </Field>
        <Field label="Answering questions" hint="Ask-about-my-day. Notes as text; no screenshots.">
          <ProviderSelect
            value={settings.qaProvider}
            providers={providers}
            need="text"
            onChange={(v) => void update({ qaProvider: v })}
          />
        </Field>
      </div>

      {(settings.observerProvider === 'openai' || settings.qaProvider === 'openai') && (
        <Field label="OpenAI model" hint="Needs vision if it is doing the observing.">
          <input
            value={settings.openaiModel}
            onChange={(e) => void update({ openaiModel: e.target.value })}
            spellCheck={false}
            className="w-64 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono
                       text-[12px] text-fog-100 outline-none focus:border-ember-500/70"
          />
        </Field>
      )}

      {(settings.observerProvider === 'local' || settings.qaProvider === 'local') && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Local endpoint" hint="OpenAI-compatible. Ollama serves this at /v1.">
            <input
              value={settings.localBaseUrl}
              onChange={(e) => void update({ localBaseUrl: e.target.value })}
              spellCheck={false}
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono
                         text-[12px] text-fog-100 outline-none focus:border-ember-500/70"
            />
          </Field>
          <Field label="Local model" hint="A vision model, if it is doing the observing — a text-only one sees nothing.">
            <input
              value={settings.localModel}
              onChange={(e) => void update({ localModel: e.target.value })}
              spellCheck={false}
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono
                         text-[12px] text-fog-100 outline-none focus:border-ember-500/70"
            />
          </Field>
        </div>
      )}
    </Card>
  );
}

function ProviderSelect({
  value,
  providers,
  need,
  onChange,
}: {
  value: ProviderStatus['id'];
  providers: ProviderStatus[];
  need: 'vision' | 'text';
  onChange: (v: ProviderStatus['id']) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ProviderStatus['id'])}
      className="no-drag w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5
                 text-[12px] text-fog-100 outline-none focus:border-ember-500/70"
    >
      {providers
        .filter((p) => (need === 'vision' ? p.capabilities.vision : true))
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.configured ? '' : ' — not set up'}
          </option>
        ))}
    </select>
  );
}

/** A newline-separated list, edited as text. A chip editor with an add button
 *  is prettier and worse: bundle ids arrive by being pasted, usually several at
 *  once, and a textarea is the only control that takes a paste as a paste. */
function ListField({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  value: string[];
  placeholder: string;
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value.join('\n');
  return (
    <Field label={label} hint={hint}>
      <textarea
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        rows={Math.min(8, Math.max(3, value.length + 1))}
        onChange={(e) => setDraft(e.target.value)}
        // Committed on blur rather than per keystroke: every change writes
        // SQLite and broadcasts settings to every window, and doing that on the
        // "c" of "com.apple..." is a lot of noise for no benefit.
        onBlur={() => {
          if (draft === null) return;
          onChange(draft.split('\n'));
          setDraft(null);
        }}
        className="w-full resize-y rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2
                   font-mono text-[11px] leading-relaxed text-fog-100 outline-none
                   placeholder:text-fog-500/50 focus:border-ember-500/70"
      />
    </Field>
  );
}

/// Exclusions, editable (§8.6).
///
/// Built-ins can be disabled but not deleted — a user who removes 1Password by
/// accident would not find out until a password was on disk — and a custom rule
/// is either a bundle id or a window-title regex. The regex is compiled here
/// before it is saved, because an invalid one silently excludes nothing, and
/// "nothing" is exactly what a broken privacy rule looks like from outside.
function ExclusionEditor({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
}) {
  const [kind, setKind] = useState<'bundleId' | 'titlePattern'>('bundleId');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    setErr(null);
    const v = value.trim();
    if (!v) return;
    if (kind === 'titlePattern') {
      try {
        new RegExp(v, 'i');
      } catch (e) {
        setErr(`That is not a valid regular expression: ${(e as Error).message}`);
        return;
      }
    }
    void update({
      exclusions: [
        ...settings.exclusions,
        {
          label: label.trim() || v,
          ...(kind === 'bundleId' ? { bundleId: v } : { titlePattern: v }),
          builtin: false,
          enabled: true,
        },
      ],
    });
    setLabel('');
    setValue('');
  };

  return (
    <Card className="flex flex-col p-1">
      <div className="flex flex-col divide-y divide-ink-700/50">
        {settings.exclusions.map((rule, i) => (
          <div key={`${rule.label}-${i}`} className="flex items-center justify-between gap-4 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-[12px] text-fog-100">
                {rule.label}
                {!rule.builtin && (
                  <span className="ml-1.5 font-mono text-[9px] uppercase tracking-wider text-fog-500">
                    yours
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-[10px] text-fog-500">
                {rule.bundleId ?? `title ~ /${rule.titlePattern}/i`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {!rule.builtin && (
                <button
                  onClick={() =>
                    void update({ exclusions: settings.exclusions.filter((_, j) => j !== i) })
                  }
                  className="text-[11px] text-fog-500 transition-colors hover:text-rust-400"
                >
                  Remove
                </button>
              )}
              <Toggle
                checked={rule.enabled}
                label={`Exclude ${rule.label}`}
                onChange={(v) => {
                  const next = settings.exclusions.map((r, j) => (j === i ? { ...r, enabled: v } : r));
                  void update({ exclusions: next });
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="m-1 mt-2 flex flex-col gap-2.5 rounded-lg bg-ink-900/60 p-3">
        <div className="flex gap-1.5">
          {(['bundleId', 'titlePattern'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                kind === k
                  ? 'border-ember-500/60 bg-ember-500/10 text-ember-300'
                  : 'border-ink-700 text-fog-500 hover:text-fog-300'
              }`}
            >
              {k === 'bundleId' ? 'by app' : 'by window title'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            spellCheck={false}
            placeholder={kind === 'bundleId' ? 'com.example.app' : '(Banking|Tax return)'}
            className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5
                       font-mono text-[11px] text-fog-100 outline-none focus:border-ember-500/70"
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="what to call it (optional)"
            className="w-48 rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-[11px]
                       text-fog-100 outline-none focus:border-ember-500/70"
          />
          <Button variant="accent" disabled={!value.trim()} onClick={add}>
            Add
          </Button>
        </div>
        {err && <p className="text-[11px] text-rust-400">{err}</p>}
        <p className="text-[10px] leading-relaxed text-fog-500">
          Built-in rules can be turned off but not deleted. A window-title rule is a JavaScript
          regular expression, matched case-insensitively — it is compiled before it is saved,
          because an invalid one would silently exclude nothing.
        </p>
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
