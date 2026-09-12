# buddy

A macOS assistant that watches how you work and, on one keystroke, takes over
and finishes it. See [`PRD.md`](PRD.md) for the full spec.

**Milestones M1 ("it sees") and M2 ("it acts") are complete.** buddy observes —
it captures the screen on a timer, throws away frames that show nothing new, and
files the rest in a vault that empties itself daily. And it acts: press the
hotkey, type what you want finished, confirm, and it drives the mouse and
keyboard until the job is done, under guardrails it cannot talk its way past and
four kill switches that stop it dead.

It does not yet *infer* the goal — you type it. That is M3.

## Requirements

macOS 14+, Node 22+, and the Xcode Command Line Tools. No Xcode, no Apple
Developer account, nothing to pay for.

```bash
xcode-select --install   # if `swiftc` is missing
npm install
```

## First run

```bash
./scripts/make-signing-cert.sh   # once — see "Signing", below
npm run dev
```

buddy runs in the menu bar with no Dock icon. On first launch it opens its
window and asks for **Screen Recording**; grant it in System Settings and buddy
notices within two seconds without a relaunch. **Accessibility** was optional in
M1 (it improved window titles and enabled password-field detection) and is
**required in M2** — without it buddy cannot click, type, read the element under
the pointer, or tell your keystrokes from its own. Grant it to `buddyd`, not
just to the app: in development the sidecar is its own binary and gets its own
TCC entry.

Press **⌥⌘Space** to open the HUD, **Esc** to dismiss it. Type a goal, press
Enter, confirm the profile and the allowlist, and press Enter again to run.

**⌥⌘.** stops a run, and so do the Stop button, the menu-bar Stop item, touching
the keyboard, and `touch ~/.buddy/ABORT`.

## Commands

| | |
|---|---|
| `npm run dev` | Build the sidecar, then run the app with hot reload |
| `npm run build` | Build the sidecar and the app bundle |
| `npm run build:sidecar` | Build `buddyd` alone |
| `npm run check:m1` | The M1 exit-criteria checks (13 of them) |
| `npm run check:m2` | The M2 exit-criteria checks (57 of them) |
| `npm run typecheck` | Both tsconfigs |
| `npm run eval:goal` | The goal-inference eval (needs `ANTHROPIC_API_KEY`) |
| `npm run dist` | Unsigned `.dmg` in `release/` |
| `npm run rebuild` | Rebuild `better-sqlite3` against the pinned Electron ABI |

## Signing

**Run `./scripts/make-signing-cert.sh` once.** It creates a free, self-signed
code-signing identity in your login keychain.

This is not optional polish. An ad-hoc signature (`codesign -s -`) produces a new
`cdhash` on every build, and macOS records the Screen Recording grant against
that hash — so the next build silently loses screen access **while System
Settings still shows the toggle ON**. That failure was reproduced during the R1
spike and it is indistinguishable from a bug in the capture code. A self-signed
certificate gives the bundle a stable Designated Requirement and the grant
survives rebuilds. This is PRD **R2**.

After `npm run dist`, sign the bundle with `./scripts/sign-app.sh` — it signs the
sidecar before the outer bundle, so the app's seal actually covers it.

## What M2 built — the Operator

```
src/main/agent/
  runner.ts       the computer-use loop: batching, fail-stop, pruning, caching
  executor.ts     the ONE place a CGEvent is dispatched, and so the one place
                  guardrails are enforced and coordinates are translated
  guardrails.ts   classify() + the §7.1 policy matrix, pure and synchronous
  killswitch.ts   all four switches, converging on one fire()
  budget.ts       steps / wall clock / dollars, checked before every batch
  tools.ts        computer_toolset_20260801 + describe_focused_window + finish
  prompt.ts       the Operator system prompt
  orchestrator.ts one run at a time, and one place that knows which
sidecar/Sources/
  Input.swift     CGEvent synthesis for all 17 toolset members
  Target.swift    the guardrail's pre-dispatch AX read, and the takeover tap
```

### The parts worth knowing about

**Coordinates are translated in exactly one function.** `screenPoint = origin +
modelCoord / scale`. The scale factor arrives on the captured frame and is never
recomputed; the display origin is `CGDisplayBounds`, which is already the
coordinate space `CGEvent` uses. On a 16" internal display the scale is 1.0 and
the translation is the identity — but a 4K display in "More Space" is 5.09 MP,
over Opus 5's 3.75 MP ceiling, and then it is not. Every run step records the
scale it used, so a misplaced click is diagnosable from the log.

**The accessibility tree ships with every screenshot.** Not only when the model
asks for it. The model reads `AXButton "Send" @1204,688` and clicks a named
element at a known centre rather than estimating a pixel from an image. This is
the single largest reliability win in the milestone.

**Guardrails run in the executor, immediately before the `CGEvent` — never in
the prompt.** The model is not asked to police itself. Signals in descending
order of trust: the accessibility tree (a focused `AXSecureTextField` denies; a
button titled `/^(send|post|publish|submit|buy|pay|place order|confirm|delete)/i`
gates), then the app and domain allowlist, then keystroke-content heuristics
(Luhn-valid card numbers, `sk-`/`ghp_` key shapes, seed phrases). The profile is
fixed before the loop starts and a run cannot escalate it.

**A deny parks the run.** It is deliberately *not* returned to the model as a
tool error, because a tool error is an invitation to try something else — and
"something else with the same effect" is the exact failure that rule exists to
prevent. buddy stops, says what was blocked, and waits for a person.

**Run screenshots outlive the daily purge**, because the Run Log is the trust
surface and a log whose pictures vanish overnight cannot answer "what did buddy
click". They live under `runs/<id>/`, not in the frame vault, and deleting a run
deletes them.

## What M2 verifies

`npm run check:m2` runs 57 checks against the real modules. Two things are
replaced, and only two: the **model**, by a scripted client that returns the
exact content blocks a turn would; and on a machine without Accessibility, the
**sidecar's input path**. Everything between those seams is shipping code.

What that covers, concretely:

- **All four kill switches fired mid-run**, with seventeen more turns of work
  queued behind them, each shown to park the run with its log intact. A kill
  switch that was never actually fired mid-run is not tested, so each one is.
- **`BUDDY_MAGIC` actually discriminates.** buddy synthesizes an F19 keystroke
  and the takeover switch does *not* trip; an identical F19 from another process
  trips it. That is the whole basis of kill switch 3, and until it was tested
  this way both halves passed vacuously because of the tap's arm delay.
- **The guardrail matrix**, both profiles, including that a gated action
  confirms in attended and parks in unattended, that a credential field denies
  in both, and that a deny is never followed by an alternate route — the model
  gets no further turn at all.
- **Batch fail-stop**: order preserved, the exact halt text on every block after
  the first failure, and all results in one user message.
- **`toolset_name: "computer"` on every computer `tool_result`** and on no
  custom-tool result. Omitting it is a hard 400 that reads as a model failure.
- Budgets, screenshot pruning, the cache-breakpoint layout, and the coordinate
  translation at both scale 1.0 and a 4K "More Space" scale.
- Real `CGEvent` dispatch and the real AX hit test, **when Accessibility is
  granted to `buddyd`**. Those checks report themselves as skipped when it is
  not, rather than passing quietly or failing the suite.

What it does **not** cover, and does not claim to: a live Opus 5 call. The loop
is exercised through a scripted client, so `toolset_name`, the breakpoint
layout, and the result shapes are asserted against the SDK's types and the
documented contract rather than against the API. The first live run is still the
first live run.

Note that the checks synthesize a small amount of real input on the machine they
run on — a pointer move that is put back, and F19, which has no default binding
anywhere in macOS. Nothing is typed and nothing is clicked.

## What M1 built

```
src/main/          Electron main: orchestrator, capture loop, storage, IPC
  sidecar/         Spawns and supervises buddyd; JSON-RPC over stdio
  store/           SQLite schema, frame vault, retention sweeper
  capture/         T0 signals, T1 frames, pHash dedupe, exclusion list
src/preload/       The only bridge to the renderer (contextIsolation on)
src/renderer/      React 19 + Tailwind 4 + Framer Motion — HUD, Home, Settings, Log
sidecar/Sources/   buddyd: ScreenCaptureKit, AXUIElement, CGEvent, ~1200 lines of Swift
```

Every macOS primitive lives behind the `buddyd` JSON-RPC surface, so the
Electron shell can be replaced later without touching capture, input, or AX code.

### The capture loop

**T0** every 2 s: frontmost app, window title, idle seconds. Free, and it is what
detects context switches.

**T1** every 15 s (configurable): screenshot → perceptual hash. If the hash is
within 8 of the last kept frame **and** the app has not changed, the frame is
discarded before it ever enters the vault. A context switch also triggers a frame
out of band, because a 15 s cadence reliably misses the moment that mattered most.

A frame is never taken at all when the frontmost app is on the exclusion list
(1Password, Keychain Access, Passwords ship enabled), when the window title looks
like a private browsing window, when another process holds Secure Event Input, or
when the accessibility tree reports a focused `AXSecureTextField`.

### Storage and retention

Frames are PNGs under `~/Library/Application Support/buddy/frames/<day>/`, mode
0700, indexed by a row in SQLite. `expires_at = ts + retentionDays` (default 1).
A sweep runs on launch and hourly: it unlinks the file and tombstones the row, so
a note that cites a frame can still say the frame existed and has expired.
Running on launch matters as much as the hourly timer — a machine asleep
overnight would otherwise wake with two days of screenshots on disk.

API keys go through Electron `safeStorage`, which is Keychain-backed. They are
never in SQLite in the clear, and the logger redacts key-shaped strings before
anything reaches disk.

## Privacy, stated plainly

Screenshots never leave this machine **except** as model input when buddy
observes or acts. That is the product. Pause is honoured everywhere — it stops
capture entirely, not just the UI.
