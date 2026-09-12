# buddy

A macOS assistant that watches how you work and, on one keystroke, takes over
and finishes it. See [`PRD.md`](PRD.md) for the full spec.

**Milestone M1 — "it sees" — is complete.** buddy observes: it captures the
screen on a timer, throws away frames that show nothing new, files the rest in a
vault that empties itself daily, and opens a HUD on a global hotkey. It does not
yet act; that is M2.

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
notices within two seconds without a relaunch. **Accessibility** is optional in
M1 (it improves window titles and enables password-field detection) and required
in M2.

Press **⌥⌘Space** to open the HUD, **Esc** to dismiss it.

## Commands

| | |
|---|---|
| `npm run dev` | Build the sidecar, then run the app with hot reload |
| `npm run build` | Build the sidecar and the app bundle |
| `npm run build:sidecar` | Build `buddyd` alone |
| `npm run check:m1` | The M1 exit-criteria checks (13 of them) |
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
