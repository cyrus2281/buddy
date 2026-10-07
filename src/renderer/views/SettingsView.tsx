import React, { useEffect, useState } from 'react';
import { api } from '../useBuddy.js';
import { Button, Card, Field, NumberInput, StatusDot, Toggle } from '../components/primitives.js';
import { PermissionsPanel } from './Permissions.js';
import { ANTHROPIC_DEFAULT_MODELS } from '../../shared/types.js';
import type {
  AnthropicRole,
  NotesStats,
  OperatorAvailability,
  Permissions,
  ProviderId,
  ProviderStatus,
  ProviderTestResult,
  RunProfile,
  SecretsStatus,
  Settings,
  SidecarStatus,
  SpendReport,
  SpendTier,
  VoicePermission,
  VoiceStatus,
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
  voice,
  update,
}: {
  settings: Settings | null;
  permissions: Permissions | null;
  sidecar: SidecarStatus | null;
  spend: SpendReport | null;
  notesStats: NotesStats | null;
  providers: ProviderStatus[];
  operator: OperatorAvailability | null;
  voice: VoiceStatus | null;
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

          <div className="flex items-center justify-between border-t border-ink-700/60 pt-4">
            <div>
              <p className="text-[12px] font-medium text-fog-100">Learn about me</p>
              <p className="mt-0.5 max-w-md text-[11px] leading-relaxed text-fog-500">
                Each hourly summary also learns durable things about you — preferences, habits, how
                you do recurring work, who people are — and every run and every goal you correct
                teaches it more. buddy uses what it learned when it reads your screen, answers, or
                acts. Off, it stops learning and stops using it; nothing is deleted. Everything it
                learned is on the You tab, where each belief can be confirmed, rejected or edited.
              </p>
            </div>
            <Toggle
              checked={settings.learningEnabled}
              label="Learn about me"
              onChange={(v) => void update({ learningEnabled: v })}
            />
          </div>

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
                It has no app allowlist: the one below is for the other two profiles.
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
        title="Hands-off"
        hint="How buddy reaches an app, separate from what it is allowed to do there."
      >
        <Card className="p-4">
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-fog-100">Start runs hands-off</p>
              <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
                buddy presses buttons, fills fields and sends keys through each app’s accessibility
                tree, in the background — it never moves your pointer, never types into the app
                you are using, and never brings its app to the front. You keep working while it
                runs. The same guardrails decide what it may do, checked against the app it is
                actually acting in.
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-fog-500">
                Apps with a thin accessibility tree — canvases, games, some Electron apps — give it
                less to act on; turn it off per run in the HUD for those.
              </p>
            </div>
            <Toggle
              checked={settings.handsOffDefault}
              label="Start runs hands-off"
              onChange={(v) => void update({ handsOffDefault: v })}
            />
          </div>
        </Card>
      </Section>

      <Section
        title="The island and the ghost cursor"
        hint="Where buddy shows what it is doing, and how it previews where it is about to click."
      >
        <Card className="flex flex-col gap-5 p-4">
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-fog-100">Status in the notch</p>
              <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
                buddy lives in the notch: invisible at rest, wings either side while it works,
                and a sentence that drops down for each new step, a question, or an outcome. On
                a display without a notch it is a pill under the menu bar. It never takes focus,
                and it is left out of the screenshots buddy reads.
              </p>
            </div>
            <Toggle
              checked={settings.islandEnabled}
              label="Status in the notch"
              onChange={(v) => void update({ islandEnabled: v })}
            />
          </div>
          {settings.islandEnabled && (
            <Field label="Show it on" hint="The notch is the one place status can sit without covering anything — but not if you never look at the laptop screen.">
              <div className="flex gap-2">
                {(
                  [
                    ['notch', 'The notched display'],
                    ['main', 'The main display'],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => void update({ islandPlacement: v })}
                    className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
                      settings.islandPlacement === v
                        ? 'border-ember-500/60 bg-ember-500/10 text-fog-100'
                        : 'border-ink-700 text-fog-300 hover:border-ink-600'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <div className="flex items-start justify-between gap-5 border-t border-ink-700/60 pt-4">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-fog-100">Ghost cursor</p>
              <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
                A translucent pointer glides to where buddy is about to click, names what it is
                aiming at, and ripples as the click lands — so you can follow a run rather than
                watch the cursor jump. It waits over the thing a confirmation is about. Never
                drawn for hands-off runs.
              </p>
            </div>
            <Toggle
              checked={settings.ghostCursor}
              label="Ghost cursor"
              onChange={(v) => void update({ ghostCursor: v })}
            />
          </div>
          {settings.ghostCursor && (
            <Field label="Lead" hint="How far ahead of the real click the ghost arrives. Each click waits this long.">
              <NumberInput
                value={settings.ghostLeadMs}
                min={0}
                max={1500}
                step={20}
                suffix="ms"
                onChange={(n) => void update({ ghostLeadMs: n })}
              />
            </Field>
          )}
        </Card>
      </Section>

      <Section
        title="Runs"
        hint="What a run starts with when goal inference has not seeded it. The allowlist is per run and confirmed in the same keystroke as the goal — this is the fallback, and what a typed goal uses. It does not apply to leashless, which has no allowlist."
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
        title="Voice"
        hint="Say “hey buddy” and the HUD opens, as it does for the hotkey. While it is showing a suggestion, “take over”, “go ahead” or “start” runs it, and “never mind” closes it. During a run, “buddy, stop” stops it."
      >
        <VoicePanel voice={voice} settings={settings} update={update} />
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

/// Voice (the wake-word seam, PRD §9).
///
/// The status line is the part that matters. Voice fails quietly by nature —
/// nothing happens when you speak — so every reason it is not listening has a
/// sentence here: off, resting (paused or locked, on purpose), or a problem
/// with what to do about it.
function VoicePanel({
  voice,
  settings,
  update,
}: {
  voice: VoiceStatus | null;
  settings: Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const on = settings.voiceEnabled;

  const status: { ok: boolean; warn: boolean; text: string } = !on
    ? { ok: false, warn: true, text: 'Off. The microphone is closed.' }
    : voice?.listening
      ? { ok: true, warn: false, text: `Listening on ${voice.inputDevice ?? 'the default microphone'}.` }
      : voice?.resting === 'paused'
        ? { ok: false, warn: true, text: 'Resting: observation is paused, and a paused buddy is not listening either.' }
        : voice?.resting === 'locked'
          ? { ok: false, warn: true, text: 'Resting while the screen is locked.' }
          : voice?.problem
            ? { ok: false, warn: false, text: voice.problem }
            : { ok: false, warn: true, text: 'Starting…' };

  const grant = async (kind: 'microphone' | 'speech') => {
    setBusy(kind);
    try {
      await api.requestVoicePermission(kind);
    } finally {
      setBusy(null);
    }
  };

  const rows: { kind: 'microphone' | 'speech'; title: string; value: VoicePermission }[] = [
    { kind: 'microphone', title: 'Microphone', value: voice?.microphone ?? 'unknown' },
    { kind: 'speech', title: 'Speech Recognition', value: voice?.speech ?? 'unknown' },
  ];

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[12px] text-fog-100">Listen for “Hey buddy”</p>
          <p className="mt-1.5 flex items-start gap-2 text-[11px] leading-relaxed text-fog-500">
            <span className="mt-[5px]">
              <StatusDot ok={status.ok} warn={status.warn} />
            </span>
            <span className={!status.ok && !status.warn ? 'text-rust-400' : ''}>{status.text}</span>
          </p>
        </div>
        <Toggle checked={on} label="Listen for Hey buddy" onChange={(v) => void update({ voiceEnabled: v })} />
      </div>

      <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
        {rows.map((r) => (
          <div key={r.kind} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-[12px] text-fog-100">
              <StatusDot ok={r.value === 'granted'} warn={r.value === 'undetermined' || r.value === 'unknown'} />
              {r.title}
              <span
                className={`font-mono text-[10px] uppercase tracking-wider ${
                  r.value === 'granted' ? 'text-moss-400' : 'text-fog-500'
                }`}
              >
                {r.value === 'undetermined' ? 'not asked yet' : r.value}
              </span>
            </span>
            <span className="flex gap-1.5">
              {r.value === 'undetermined' && (
                <Button variant="accent" disabled={busy === r.kind} onClick={() => void grant(r.kind)}>
                  {busy === r.kind ? 'Asking…' : 'Grant'}
                </Button>
              )}
              <Button variant="ghost" onClick={() => void api.openVoicePermissionSettings(r.kind)}>
                Open Settings
              </Button>
            </span>
          </div>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-fog-500">
        Speech is recognised on this Mac by Apple’s on-device model. If the Mac does not have
        one, voice does not run, rather than send the room to a server. Audio is never saved, and
        what buddy hears is matched and dropped: the log records that a command was heard, never
        what was said. macOS shows its orange microphone dot in the menu bar the whole time voice is
        on. With AirPods or another Bluetooth headset as your input, buddy listens on the built-in
        microphone instead, so the headset is not dropped to call quality.
      </p>
      <p className="text-[11px] leading-relaxed text-fog-500">
        A go-ahead counts only as a whole utterance on its own — “we should go ahead with it” is
        not one — and only for 30 seconds after the HUD opens; after that, say “hey buddy” again,
        or “hey buddy, go ahead” in one breath. buddy waits for its reading before it starts, and
        will not start by voice when it is unsure, when it could not read the screen, or under
        leashless. A bare “stop” does not stop a run — say “buddy, stop”.
      </p>

      <div className="flex items-start justify-between gap-5 border-t border-ink-700/60 pt-4">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-fog-100">Start spoken instructions on their own</p>
          <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
            “Hey buddy, send a Slack message to Hugo asking if he’s done recording” opens the HUD
            with that as the goal and the apps it names on the allowlist. On, it starts after a
            three-second countdown you can stop with Esc or “never mind”; off, it waits for Enter or
            “go ahead”. Either way, anything that sends or deletes still asks first under attended.
            You can also say “hey buddy”, pause, and then say what you want.
          </p>
        </div>
        <Toggle
          checked={settings.voiceInstructionsAutoStart}
          label="Start spoken instructions on their own"
          onChange={(v) => void update({ voiceInstructionsAutoStart: v })}
        />
      </div>

      <ListField
        label="Go-ahead phrases"
        hint="One per line. Matched against the whole utterance, ignoring “okay”, “please” and “buddy”. “Stop”, “cancel” and “never mind” are fixed and always win. An empty list turns voice go-aheads off and leaves “hey buddy” working."
        value={settings.voiceConfirmPhrases}
        placeholder={'take over\ngo ahead\nstart'}
        onChange={(v) => void update({ voiceConfirmPhrases: v })}
      />
    </Card>
  );
}

const TIER_LABEL: Record<SpendTier, string> = {
  t2: 'observing',
  t3: 'summarising',
  inference: 'reading the screen on the hotkey',
  operator: 'runs',
  'wake-check': 'standby checks',
  qa: 'answering questions',
  test: 'connection tests',
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
  // Per provider: the last result, or `true` while a test is in flight. Kept
  // across edits on purpose — a result that vanished the moment the model id
  // field changed would hide the before/after a person is comparing.
  const [tests, setTests] = useState<Partial<Record<ProviderId, ProviderTestResult | true>>>({});
  const runTest = (id: ProviderId) => {
    setTests((t) => ({ ...t, [id]: true }));
    void api
      .testProvider(id)
      .then((r) => setTests((t) => ({ ...t, [id]: r })))
      .catch((e: Error) =>
        setTests((t) => ({
          ...t,
          [id]: { provider: id, endpoint: '', ok: false, probes: [], skipped: e.message, testedAt: Date.now() },
        })),
      );
  };

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
                  {p.configured && (
                    <Button
                      variant="ghost"
                      className="mt-1 -ml-2 px-2 py-0.5 text-[11px]"
                      disabled={tests[p.id] === true}
                      onClick={() => runTest(p.id)}
                    >
                      {tests[p.id] === true ? 'Testing…' : 'Test connection'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {providers.map((p) => {
        const t = tests[p.id];
        return t && t !== true ? <TestResult key={p.id} label={p.label} result={t} /> : null;
      })}

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
            runs on <span className="font-mono">{modelId(settings, 'operator')}</span> with{' '}
            <span className="font-mono">computer_toolset_20260801</span>, whatever the two dropdowns
            below are set to.
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="OpenAI endpoint" hint="Blank means api.openai.com/v1. Set it for Azure or a gateway that speaks the same /chat/completions route.">
            <MonoInput
              value={settings.openaiBaseUrl}
              placeholder={DEFAULT_OPENAI_BASE_URL}
              onChange={(v) => void update({ openaiBaseUrl: v })}
            />
          </Field>
          <Field label="OpenAI model" hint="Needs vision if it is doing the observing.">
            <MonoInput
              value={settings.openaiModel}
              placeholder="gpt-5"
              onChange={(v) => void update({ openaiModel: v })}
            />
          </Field>
        </div>
      )}

      {(settings.observerProvider === 'local' || settings.qaProvider === 'local') && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Local endpoint" hint="OpenAI-compatible. Ollama serves this at /v1.">
            <MonoInput
              value={settings.localBaseUrl}
              placeholder="http://localhost:11434/v1"
              onChange={(v) => void update({ localBaseUrl: v })}
            />
          </Field>
          <Field label="Local model" hint="A vision model, if it is doing the observing — a text-only one sees nothing.">
            <MonoInput
              value={settings.localModel}
              placeholder="llama3.2-vision"
              onChange={(v) => void update({ localModel: v })}
            />
          </Field>
        </div>
      )}

      <div className="grid gap-4 border-t border-ink-700/60 pt-4 sm:grid-cols-2">
        <Field
          label="Anthropic endpoint"
          hint="Blank means api.anthropic.com. Point it at a gateway or proxy that speaks the Messages API and every Claude call goes there — the Operator's included."
        >
          <MonoInput
            value={settings.anthropicBaseUrl}
            placeholder="https://api.anthropic.com"
            onChange={(v) => void update({ anthropicBaseUrl: v })}
          />
        </Field>
      </div>

      {/* Six fields rather than one, because the tiering is economic: T2 runs
          every three minutes and the Operator runs at effort:high, and one
          shared id would either bankrupt the cheap tier or lobotomise the
          expensive one. Folded away because the defaults are right for
          api.anthropic.com, and only a gateway that renames things needs them. */}
      <details className="border-t border-ink-700/60 pt-3">
        <summary className="cursor-pointer text-[12px] font-medium text-fog-100">
          Anthropic model ids
          <span className="ml-2 text-[11px] font-normal text-fog-500">
            one per role — blank runs the id shown
          </span>
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {ANTHROPIC_ROLE_FIELDS.map(({ role, label, hint }) => (
            <Field key={role} label={label} hint={hint}>
              <MonoInput
                value={settings.anthropicModels?.[role] ?? ''}
                placeholder={ANTHROPIC_DEFAULT_MODELS[role]}
                onChange={(v) =>
                  void update({ anthropicModels: { ...settings.anthropicModels, [role]: v } })
                }
              />
            </Field>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-fog-500">
          Spend is priced by the first-party id found inside the name, so{' '}
          <span className="font-mono">anthropic.claude-sonnet-5-v1:0</span> still meters correctly. A
          wholly renamed model reports $0, which also means it cannot trip the daily cap.
        </p>
      </details>
    </Card>
  );
}

/** What one Test press found: a line per model id, naming the roles it serves,
 *  so a gateway that renamed one model shows exactly which tiers it broke. */
function TestResult({ label, result }: { label: string; result: ProviderTestResult }) {
  const spent = result.probes.reduce((a, p) => a + p.costUsd, 0);
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 text-[11px] leading-relaxed ${
        result.ok ? 'border-moss-400/30 bg-moss-400/5' : 'border-rust-400/40 bg-rust-400/5'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className={`font-medium ${result.ok ? 'text-moss-400' : 'text-rust-400'}`}>
          {label}: {result.skipped ? 'not tested' : result.ok ? 'connected' : 'not working'}
        </span>
        <span className="font-mono text-[10px] text-fog-500">
          {result.endpoint}
          {spent > 0 && ` · $${spent.toFixed(5)}`}
        </span>
      </div>
      {result.skipped && <p className="mt-1 text-fog-300">{result.skipped}</p>}
      <ul className="mt-1.5 flex flex-col gap-1">
        {result.probes.map((p) => (
          <li key={p.model} className="flex flex-col">
            <span className="flex items-center gap-1.5">
              <StatusDot ok={p.ok} />
              <span className="font-mono text-fog-100">{p.model}</span>
              <span className="text-fog-500">
                {p.roles.length ? p.roles.join(', ') : 'not selected for anything yet'} · {p.ms} ms
              </span>
            </span>
            {p.error && <span className="ml-3.5 text-rust-400">{p.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Blank is not a value here — it means "the default", and the placeholder says
 *  which default that is. Rewriting a cleared box to its default on the spot
 *  would make the field impossible to retype into. */
function MonoInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono
                 text-[12px] text-fog-100 outline-none placeholder:text-fog-600
                 focus:border-ember-500/70"
    />
  );
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** What each Anthropic role actually does, in the words someone editing a model
 *  id needs — "T2" on its own is not a hint, it is a cross-reference. */
const ANTHROPIC_ROLE_FIELDS: { role: AnthropicRole; label: string; hint: string }[] = [
  {
    role: 'operator',
    label: 'Driving the machine',
    hint: 'Computer use. Only a model that takes computer_toolset_20260801 can do this one.',
  },
  {
    role: 'observe',
    label: 'Observing (T2)',
    hint: 'Screenshots every few minutes. The cheap tier, and the one that decides the bill.',
  },
  { role: 'rollup', label: 'Summarising (T3)', hint: 'The hourly recap, relations, and task states.' },
  {
    role: 'inference',
    label: 'Goal inference',
    hint: 'Reads the Context Bundle when you press the hotkey and proposes the goal.',
  },
  { role: 'qa', label: 'Answering questions', hint: 'Ask-about-my-day. Notes as text, no images.' },
  {
    role: 'wake',
    label: 'Standby checks',
    hint: 'One screenshot and a sentence, repeatedly, while a run waits for something.',
  },
];

/** The id a role will actually run: the override if there is one, the
 *  first-party default otherwise. Same rule as `anthropicModel()` in the main
 *  process, and it has to stay the same or the banner lies. */
function modelId(s: Settings, role: AnthropicRole): string {
  return s.anthropicModels?.[role]?.trim() || ANTHROPIC_DEFAULT_MODELS[role];
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
