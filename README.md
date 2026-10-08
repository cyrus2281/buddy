# buddy

**Every AI assistant asks what you want. buddy already knows — it was watching.**

buddy is a macOS assistant that watches how you work, remembers it, and finishes
what you were doing when you say **"hey buddy"**. There is nothing to explain:
it reads the task off your screen, shows you why it thinks so, and takes over
when you say **"go ahead"**. Anything it can't take back, it asks about first.

The full product spec is in [`PRD.md`](PRD.md).

---

## What it does

### Watches, cheaply
buddy captures your screen on a timer and throws away frames that show nothing
new. A small model writes down what you were doing every few minutes, and every
hour those observations fold into notes. A full workday costs about $2, with a
hard daily cap.

| Tier | How often | What it is | Cost |
|---|---|---|---|
| T0 signals | every 2 s | front app, window title, idle time | free |
| T1 screenshots | every 15 s | near-duplicates discarded on the spot | free |
| T2 observations | every ~3 min | one structured note from a small model | ~½¢ |
| T3 notes | hourly | recaps, people, open tasks | ~5¢ |

### Remembers
Notes become memory: a recap of your day, the people and products you work
with, and the tasks you are in the middle of. Ask *"what did I do this
morning?"* in the Ask box and get an answer with citations. Every note can be
edited or deleted.

### Acts — say "hey buddy"
Say **"hey buddy"** (or press **⌥⌘Space**). Within ~200 ms the HUD opens with a
guess; seconds later buddy's real reading replaces it: the goal, the evidence
it used, what's already done, and the apps it wants to touch. Say **"go ahead"**
(or press Enter) and it drives the mouse and keyboard until the job is done.
When it isn't sure, it asks you to pick between its two best guesses instead.

You can also just say what you want — *"hey buddy, message Leo and ask if the
demo build is ready"* — and your words become the goal, with a three-second
countdown to catch a misheard name.

### Shows what it's about to do
- **The island** — buddy's status lives in the MacBook notch: invisible at
  rest, wings while it works, a sentence per step, amber for a question, red
  when it needs you.
- **The ghost cursor** — a translucent pointer glides to each click a moment
  before it happens and names what it's aiming at.
- **The Run Log** — every step, with the action, the guardrail's verdict and a
  screenshot.

### Waits
When the next move is somebody else's, buddy doesn't fail and doesn't forget.
It says what it's waiting for, goes quiet, and checks every few minutes for a
fraction of a cent. When the reply lands, the same run picks up where it left
off — even after buddy is quit and relaunched.

### Learns you
Every hour buddy proposes beliefs about how you work — how you file bugs, who
you work with, that you reply in threads — which strengthen when seen again and
fade when not. When you override its goal, that correction counts the most.
Everything lives on the **You** tab, where you can confirm, edit, or make buddy
forget it. Search runs on your Mac with a 30 MB embedding model.

### And more
- **Hands-off** — buddy works through each app's accessibility tree, in windows
  behind yours, so you can keep typing while it replies in Slack.
- **Where was I?** — back from a meeting, one click reopens the files and pages
  you had open, behind what you're doing now.
- **Shadow mode** — for each kind of task, buddy tells you how often it has read
  you right, including when the answer is "not very often".
- **Voice replies** — buddy can say the goal, answers, and when a run needs you,
  through headphones by default.

---

## Safety and privacy

- **Guardrails run in the executor**, right before every click — never in the
  prompt, so the model can't talk its way past them.
- **Anything that sends, deletes, or installs asks first.** Purchases,
  payments, and credentials are refused. A denied action parks the run; buddy
  never looks for another way around.
- **Three profiles:** *attended* (default; risky actions ask), *unattended*
  (risky actions are refused), and *leashless* (off unless you turn it on in
  Settings, and never suggested).
- **Screen text is data, never instruction.** Text on screen that tries to
  instruct buddy is shown to you and ignored.
- **Screenshots stay on your Mac** and are deleted after a day; they leave only
  as model input. Password managers, private windows, payment pages, and
  password fields are never captured.
- **Listening is on-device or not at all.** Audio is never saved.
- **Stopping is always one key or two words away:** **⌥⌘.**, the Stop button,
  menu bar › Stop, `touch ~/.buddy/ABORT`, or say **"buddy, stop"**.

---

## Getting started

### Requirements
- macOS 14+
- Node 22+
- Xcode Command Line Tools (`xcode-select --install`)
- An Anthropic API key (the Operator uses Claude computer use)

No Xcode, no Apple Developer account, nothing to pay for.

### Install and run

```bash
npm install                      # also fetches the 30 MB embedding model
./scripts/make-signing-cert.sh   # once — see "Signing" below
npm run dev
```

buddy lives in the menu bar (no Dock icon). On first launch it asks for:

| Permission | Why |
|---|---|
| Screen Recording | to see what you're working on |
| Accessibility | to click, type and read the UI — grant it to `buddyd` too |
| Microphone + Speech Recognition | only if you turn on "hey buddy" |

Then open **Settings**, paste your API key, and use **Test connection**.

### Signing
`./scripts/make-signing-cert.sh` creates a free self-signed code-signing
identity. Without it, every rebuild gets a new signature and macOS silently
drops the Screen Recording grant while still showing it as on. After
`npm run dist`, sign the bundle with `./scripts/sign-app.sh`.

---

## Using buddy

| Do this | To |
|---|---|
| **"Hey buddy"** or **⌥⌘Space** | open the HUD with buddy's reading of your screen |
| **"Go ahead"**, "take over", "start", or **Enter** | run it |
| **"Hey buddy, *what you want*"** | give it a goal in your own words |
| Start typing | replace the goal with your own |
| **Tab** | switch profile |
| **"Never mind"** or **Esc** | close the HUD |
| **"Buddy, stop"** or **⌥⌘.** | stop a run |

"Hey buddy" is **off by default** — turn it on in Settings › Voice or from the
menu bar. A bare "stop" doesn't stop a run (it's often meant for someone else);
say "buddy, stop".

---

## Configuration

Everything is in **Settings**: capture intervals and retention, the daily cost
cap (default $2.50), run budgets (60 steps · 10 min · $2.00 per run), the
exclusion list, voice, hands-off, the island and ghost cursor, and memory.

**Providers.** The Operator requires Claude. Observation, notes, and Ask can
also run on OpenAI or a local OpenAI-compatible runtime (e.g. Ollama). Each
provider takes a base URL and per-role model ids, so a gateway works too.

**Operator backend.** The default is Claude's computer-use toolset. An
experimental `cua-driver` backend runs the Operator on plain function tools, so
it can work through gateways or non-Claude models.

---

## Development

| Command | What it does |
|---|---|
| `npm run dev` | build the sidecar and run with hot reload |
| `npm run build` | build the sidecar and app bundle |
| `npm run dist` | unsigned `.dmg` in `release/` |
| `npm run typecheck` | typecheck both tsconfigs |
| `npm run check:m1` … `check:m5` | milestone exit-criteria checks |
| `npm run check:voice` · `check:speech` | "hey buddy" and voice-reply checks |
| `npm run check:memory` | embedder, vector index and retrieval quality |
| `npm run check:hands` · `check:island` · `check:restore` | hands-off, island/ghost, Where was I? and shadow mode |
| `npm run eval:goal` | goal-inference eval (needs an API key) |
| `npm run live:run` · `live:standby` · `live:learn` · `live:cua` | end-to-end runs against live models |
| `npm run fetch:model` | fetch and verify the embedding model |
| `npm run rebuild` | rebuild `better-sqlite3` for Electron |

### Layout

```
src/main/        Electron main process
  agent/         goal inference, the Operator loop, guardrails, budgets, standby
  capture/       screenshot timer, perceptual hashing, exclusions
  notes/         observations, hourly rollups, Ask
  memory/        embeddings, vector index, beliefs, recall
  voice/         "hey buddy" routing and spoken replies
  cua/           the cua-driver Operator backend
  store/         SQLite storage and retention
src/renderer/    React UI: HUD, island, ghost cursor, Home, Notes, You, Timeline, Runs, Settings
src/shared/      types and logic shared by both processes
sidecar/         buddyd — the Swift helper for capture, input, accessibility and speech
prompts/ evals/  prompts and the goal-inference and retrieval evals
```

---

## Troubleshooting

- **Can't find the menu bar icon?** Your menu bar is probably full — macOS
  drops extras that don't fit beside the notch. The hotkey still works, and so
  does opening buddy from Finder.
- **Screen capture stopped after a rebuild?** Run
  `./scripts/make-signing-cert.sh` (see Signing).
- **"Stored key can't be read" after a rebuild?** Keychain ties the key to the
  binary that saved it. Paste it into Settings again.
