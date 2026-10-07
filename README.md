# buddy

A macOS assistant that watches how you work and, on one keystroke, takes over
and finishes it. See [`PRD.md`](PRD.md) for the full spec.

**All four milestones are complete.** buddy observes — it captures the screen on
a timer, throws away frames that show nothing new, and files the rest in a vault
that empties itself daily. It remembers — every few minutes it writes down what
you were doing, and every hour it folds those into recaps, the people and
products you work with, and the tasks you are in the middle of. It acts: press
the hotkey and it already knows what you were doing, so there is nothing to type.
Confirm, and it drives the mouse and keyboard until the job is done, under
guardrails it cannot talk its way past and kill switches that stop it dead.

**And it waits.** When it gets as far as it can and the next move is somebody
else's, it does not fail and it does not forget. It says what it is watching for,
goes quiet, and checks every few minutes for a fraction of a cent. When the thing
happens, it picks up the same run where it left off — with everything it had
already worked out still in hand. Quit buddy and relaunch it; it is still
waiting, because the wait is a row in a database and not a timer in a process.

**And it learns you.** Notes remember what happened; M5 remembers who it
happened to. Every hourly summary also proposes durable facts about the person —
how they file bugs, who their tech lead is, that they review PRs before opening
Slack — and buddy merges them into beliefs that strengthen when seen again and
fade when not. Every run is remembered, and every time you overrode the goal
buddy proposed is remembered hardest, because it is the one moment buddy's
picture of you is tested against what you actually wanted. The shape of your
week is learned for free from which app is in front, hour by hour. All of it is
searchable by meaning, on this Mac, through a 30 MB embedding model and a
sqlite-vec index inside buddy's own database — and all of it is on the **You**
tab, where every belief can be confirmed, rejected, edited or forgotten.

**And it can work beside you.** A hands-off run never touches the pointer or
the keyboard you are using. buddy presses buttons, fills fields and opens apps
through each app's accessibility tree, in windows that stay behind yours — so
you keep typing in your editor while it replies in Slack.

**And you can see what it is about to do.** buddy's status lives in the
MacBook's notch — invisible at rest, wings either side while it works, a
sentence that drops down for each step, a question, or an outcome — and a ghost
cursor glides to each click a moment before it happens, naming what it is
aiming at.

The typed goal is still there. It is now the override, not the entry point.

## Requirements

macOS 14+, Node 22+, and the Xcode Command Line Tools. No Xcode, no Apple
Developer account, nothing to pay for.

```bash
xcode-select --install   # if `swiftc` is missing
npm install
```

`npm install` also fetches the embedding model (~30 MB, once) into
`resources/models/`, pinned to one upstream revision and checked by SHA-256.
If it cannot reach Hugging Face it says so and carries on; `npm run
fetch:model` retries, and `dev` and `build` run it anyway.

## First run

```bash
./scripts/make-signing-cert.sh   # once — see "Signing", below
npm run dev
```

buddy runs in the menu bar with no Dock icon. Opening it from Finder or the
Dock brings its window up; launching it at login does not, so it starts out of
your way. Clicking the menu bar icon opens the window too.

**If you cannot find the menu bar icon, your menu bar is probably full.** On a
notched MacBook, macOS fills menu bar extras from the right and stops at the
notch — once that space is used up it silently drops further items, buddy's
included, with no error anywhere. Nothing is wrong with the app: the hotkey
still works, and so does opening it from Finder. Quit a menu bar app or two if
you want the icon back.

On first launch it opens its window and asks for **Screen Recording**; grant it in System Settings and buddy
notices within two seconds without a relaunch. **Accessibility** was optional in
M1 (it improved window titles and enabled password-field detection) and is
**required in M2** — without it buddy cannot click, type, read the element under
the pointer, or tell your keystrokes from its own. Grant it to `buddyd`, not
just to the app: in development the sidecar is its own binary and gets its own
TCC entry.

Press **⌥⌘Space** to open the HUD, **Esc** to dismiss it. It opens with a goal
already in it — a local guess within about 200 ms, replaced a few seconds later by
what buddy read off the screen, with the evidence it used, what it thinks is
already done, and the apps it wants to touch. **Enter** runs it. Typing replaces
the goal with your own. When buddy is not sure enough, it puts its two best
guesses to you instead of acting.

**⌥⌘.** stops a run, and so do the Stop button, the menu-bar Stop item, and
`touch ~/.buddy/ABORT`. Touching the keyboard does **not** — buddy works by
driving your keyboard and mouse, so your hands and its hands are on the same
controls, and scrolling to watch it is not a request to stop. Stopping is always
something you say on purpose. It does note in the run log that you touched the
machine, which is often the explanation for a click that landed somewhere odd.

## Voice — "hey buddy"

**Off by default.** Turn it on in Settings › Voice, or with **Listen for "Hey
buddy"** in the menu bar. macOS asks for the Microphone and for Speech
Recognition, once each.

- **"Hey buddy"** opens the HUD, exactly as ⌥⌘Space does. It has to *start* what
  you say and be followed by nothing or by a command: it is also what people say
  to dogs, children and friends, and "hey buddy, how's it going?" is not
  addressed to a Mac. So buddy waits for the pause at the end (about a second)
  before it wakes.
- **"Take over"**, **"go ahead"**, **"start"** — and "do it", "run it", "let's
  go", a few more, editable in Settings — run buddy's suggestion, like Enter.
  Only as a whole utterance ("we should go ahead with it" is not one), and only
  for 30 seconds after the HUD opens; after that say "hey buddy" again, or
  "hey buddy, go ahead" in one breath. A go-ahead heard before the reading lands
  is held until it does, so the ~200 ms provisional guess is never what voice
  runs. Voice will not start a run when buddy is unsure (below 0.5 it is asking
  you a question, and "go ahead" is not an answer), when it could not read the
  screen, or under leashless — and it never answers a confirm gate. In each case
  the HUD says what would work instead.
- **"Hey buddy, *anything you want done*"** — "hey buddy, send a Slack message
  to Hugo asking him if he's done recording his project" — opens the HUD with
  that as the goal, in your words (your casing, your names), with no screen
  reading, since you have just said what you want. Apps it names go on the
  allowlist it shows ("a Slack message" is a run that has to touch Slack). It
  starts after a three-second countdown — Esc or "never mind" stops it, Enter
  starts it now, typing a key lets you fix a misheard word — or, with **Start
  spoken instructions on their own** off in Settings › Voice, it waits for
  Enter or "go ahead". Saying "hey buddy", pausing, and then saying what you
  want works too, for eight seconds. buddyd cuts an utterance at a 0.9 s pause,
  so anything said within four seconds of an instruction is taken as the rest of
  it and appended. Small talk after the wake phrase ("hey buddy, how's it
  going?", "good boy") and questions ("hey buddy, what's the weather?") are not
  instructions and do nothing. An instruction never replaces a run in progress,
  and anything a run does that sends or deletes is still gated by the profile,
  exactly as if the goal had been typed.
- **"Never mind"** or **"cancel"** closes the HUD. During a run, **"buddy,
  stop"** stops it. A bare "stop" does not, for the reason §7.3 gives for
  stopping always being something you say on purpose: "stop" in a room is often
  meant for someone else. It is a convenience beside the three kill switches,
  not one of them — it depends on `buddyd` and a working microphone.

**What it hears stays here.** An instruction is the one exception to "matched
and dropped" — its words become the goal, which is shown back to you and stored
with the run like a typed goal. The log still records only that one was heard
and how many words it had.

**The rest of what it hears stays here.** Recognition is Apple's on-device model or nothing:
if the Mac has no on-device English model, voice does not run, rather than
stream the room to a server. Audio is never saved. `buddyd` sends only finished
utterances, which are matched in memory and dropped; the log records *that* a
command was heard, never what was said. Pause and the lock screen both close the
microphone, and macOS's orange dot is in the menu bar whenever it is open. If
your input is AirPods or another Bluetooth headset, buddy listens on the
built-in mic instead — opening a headset's mic drops it to call quality, which
for an always-on listener would be always.

Each wake costs what the hotkey does — one goal-inference reading — so a false
"hey buddy" from a podcast costs one reading and an Esc.

`buddyd` carries its own usage strings in an embedded `Info.plist`
(`sidecar/Info.plist`). Without them macOS does not refuse a permission request
from a bare executable; it kills it, and the supervisor would restart it into a
crash loop.

## Hands-off — keep working while buddy works

**Off by default.** Flip the **Hands-off** switch in the HUD for one run, or make
it the default in Settings › Hands-off. It is separate from the profile: what
buddy may do is decided exactly as before; hands-off changes only *how* it
reaches the app.

A normal run shares your machine: the Operator moves the real pointer, types
into whatever has focus, and photographs the whole display, so you hand it the
keyboard and wait. A hands-off run is given **none of those tools** — not the
computer toolset with its members refused, but a different surface:

| Tool | What it does |
|---|---|
| `look` | One app's window — a picture of *just that window*, taken by window id so it is right even when the window is behind yours — and its accessibility tree, every element carrying an id like `e42`. No coordinates: there is nothing to aim. |
| `act` | `press`, `focus`, `select`, `show_menu`, `confirm`, `cancel`, `increment`, `decrement`, `scroll_to_visible`, `raise` — on an element, by id, through accessibility. |
| `set_value` | Replace a field's text in one step, then read it back and say whether the app kept it. |
| `send_keys` | A shortcut or text posted to *one process* (`CGEventPostToPid`), not to whatever has focus. |
| `open` | Launch an app, or open a URL or file in it, without bringing it forward. |

The run opens on a list of what is running — not on a screenshot of your
display, which would mostly be a picture of the one app buddy must not touch —
and the HUD gets out of the way after a moment. A confirm gate, or the run's
end, brings it back **without taking keyboard focus**: you are typing in
another app, and a gate that grabbed focus would put a stray Esc (deny) under
your fingers mid-sentence.

### The parts worth knowing about

**The guardrail is told the app buddy is acting in, not the app in front.** In
a normal run those are the same app. In hands-off the frontmost app is yours,
and checking Slack's Send button against your editor's allowlist entry would be
the classifier answering the wrong question. So hands-off actions are classified
against the *named* element, read from its own app's tree (`ax_target`): its
pid, its title, its window, the browser URL if it is one. The same classifier,
the same policy table, the same enforcement point — a press on **Send** is a
`send` (confirm when attended, refused when unattended), a value set into an
`AXSecureTextField` is a credential *whichever field has focus*, a value that
looks like an API key or a card number is refused like typing it would be,
Return sent to a chat app in the background is a send, and `open` is checked
against the app and domain allowlists.

**Element ids are never reused.** Every `look` numbers its elements afresh,
and the last four readings stay resolvable. Resetting to `e1` each time would
make a batch like "press e12, look, press e14" press whatever the *second*
reading called 14 — a different element, picked by an id the model read off the
first. An id from an older reading, or one whose element has gone, comes back
as a sentence the model can act on: *look at the window again*.

**What the OS does not guarantee is measured instead.** An app is free to
activate itself in response to a press (a link that opens the browser, say).
Every `act` records the frontmost app before and after; if it changed, buddy
hands focus back to your app and says so in the result. `set_value` reads the
field back, because "AX accepted the value" and "the page kept it" are
different things.

**Your keyboard and mouse are expected, so they are not narrated.** A normal
run writes "you used the keyboard while buddy was working" into the log. In
hands-off that is the whole point of the mode, so input is counted and nothing
is written.

**Hands-off survives standby.** It is saved with the transcript and a resumed
run comes back hands-off — and comes back without photographing the display,
for the same reason the first attempt did not.

### What is real, and what is not

`npm run check:hands` drives a **real press, a real value and a real window
capture through the real buddyd**, against a small window the suite opens
itself, behind whatever you have in front — and reads the results back from
that page. Measured: the press arrives with the frontmost app unchanged and the
pointer nowhere near the button; the value arrives *and fires the page's
`input` event*, which is what a React field needs to notice it; the window is
photographed at its own 420×240 rather than at the display's size.

One limit, measured rather than assumed: **Chromium ignores keystrokes posted
to a background window's process.** `send_keys` reaches native apps; in a
browser or most Electron apps, use `set_value` for text and `act` for buttons
— the tool's description tells the model exactly that. And how much any app
exposes through accessibility is the app's decision: a canvas, a game or a
thin Electron UI gives hands-off little to act on, which is why it is a switch
per run rather than the only way buddy works.

## The island and the ghost cursor

**On by default; both are in Settings › The island and the ghost cursor.**

**The island** is buddy's status, in the notch. The notch is the one strip of a
MacBook display that is never content — the camera is there and nothing else
can be — so it is the one place status can sit without covering anything. At
rest the island is *exactly* the notch, black on black, so it is invisible.
While a run works it grows a wing either side: buddy's mark on the left (hollow
for a hands-off run), the step count on the right. Each new step drops a
sentence down out of the notch for a couple of seconds — the goal, what it just
did, a progress line — then folds back to the wings, so a forty-step run does
not hold a banner over the menu bar for ten minutes. Hover it to open it, with
Stop. A question drops down and stays, amber, with **Review**; "done" stays for
six seconds; "needs you" stays, red, until dismissed; standby is wings with a
count. On a display without a notch it is a pill under the menu bar, and it can
be moved to the main display for someone who never looks at the laptop.

With the island on, the HUD no longer collapses to a pill in the middle of the
screen — it steps aside after three seconds, and a confirm gate brings it back.

**The ghost cursor** is a translucent pointer that glides to where buddy is
about to click, names what it is aiming at ("the “Send” button"), and ripples as
the real click lands. Typing shows a chip with the text; a shortcut shows its
keys (⌘⇧K). While a confirm gate is open the ghost waits, pulsing, over the
thing being asked about — so "approve clicking Send" has a place on screen. A
denied action is never previewed: the ghost only ever shows something buddy is
actually about to do. It is never drawn for a hands-off run, whose promise is
to leave the person's screen alone; the island says what it is doing instead.

### The parts worth knowing about

**The executor tells the ghost after classifying and before dispatching, and
then waits.** The lead (280 ms by default, a setting) is actually waited on
every click, so the ghost arrives first; typing is previewed with no wait, so it
does not slow a run that types a paragraph. A run with the ghost off waits for
nothing.

**buddy's own windows are left out of every screenshot buddy takes.** The HUD,
Home, the island and the ghost all belong to the Electron process that is
buddyd's parent, and buddyd now excludes that process from display captures.
Before this, a run's screenshots could include the HUD's own pill; now the
model never reads its own status and never sees the ghost it would otherwise be
tempted to click, and an observation never records buddy looking at buddy.

**Both windows can never take focus.** They are non-activating panels, created
unfocusable; the ghost is never interactive, and the island is click-through
everywhere except the shape it is drawing, and only while the pointer is over
it — so the menu bar either side keeps working.

**The notch geometry comes from buddyd**, because Electron does not expose
`safeAreaInsets`: the camera housing is the gap between `auxiliaryTopLeftArea`
and `auxiliaryTopRightArea`, as tall as the top inset.

### What is real, and what is not

`npm run check:island` pins the placement and every state against this Mac's
shape (a 185 × 32 notch on a 1728-point panel beside a monitor), measures the
ghost contract through the real executor and the real Operator — the intent
arrives before the event and the lead is waited; a gate holds the ghost; a deny
and a hands-off run draw nothing — and then, for real: a magenta window this
suite opens is in buddyd's capture only when asked for, and the island window
sits at the display's top edge, over the menu bar, unfocusable.
`BUDDY_ISLAND_TOUR=<dir> npm run check:island` also photographs every island
state and the ghost on this screen.

## Commands

| | |
|---|---|
| `npm run dev` | Build the sidecar, then run the app with hot reload |
| `npm run build` | Build the sidecar and the app bundle |
| `npm run build:sidecar` | Build `buddyd` alone |
| `npm run check:m1` | The M1 exit-criteria checks (15 of them) |
| `npm run check:m2` | The M2 exit-criteria checks (66 of them) |
| `npm run check:m3` | The M3 exit-criteria checks (66 of them) |
| `npm run check:m4` | The M4 exit-criteria checks (50 of them) |
| `npm run check:voice` | The "hey buddy" checks (26 of them) — matcher, routing, the listener, and the real `buddyd` |
| `npm run check:memory` | The M5 checks (39 of them) — the real embedder, the real sqlite-vec index, retrieval quality on a benchmark, learning through a scripted rollup |
| `npm run check:island` | The island and ghost-cursor checks (15 of them) — placement, every state, the ghost's contract with the executor, and real captures. `BUDDY_ISLAND_TOUR=<dir>` also photographs every state |
| `npm run check:hands` | The hands-off checks (26 of them) — the tool surface, the guardrails against the named app, the loop, and a real press, value and window capture through the real `buddyd` |
| `npm run live:run` | One real two-app run against a live Opus 5 (needs `ANTHROPIC_API_KEY`) |
| `npm run live:standby` | Story B end to end against live Opus 5 + Haiku 4.5 |
| `npm run live:learn` | Story C: two days of learning, a correction, Ask and goal inference against live Sonnet 5 + Opus 5, in a throwaway database (~$0.20) |
| `npm run fetch:model` | Fetch and verify the embedding model (idempotent) |
| `npm run typecheck` | Both tsconfigs |
| `npm run eval:goal` | The goal-inference eval (needs `ANTHROPIC_API_KEY`) |
| `npm run eval:record` | Re-record the eval's real-screenshot fixtures |
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

**This was confirmed in M4, by doing it.** The app was rebuilt (a new `cdhash`),
installed over the running copy, and launched straight into `OBSERVING` with
Screen Recording and Accessibility both still granted.

**One thing the certificate does not carry across a rebuild: your API key.**
`safeStorage` ties its Keychain item to the exact binary that wrote it, so a
re-signed build cannot decrypt a key the previous build stored. macOS will
prompt for your login password once, and buddy will tell you in Settings that
it has a stored key it cannot read. Paste the key in again and it is
re-encrypted for the new build. Unlike the Screen Recording failure this one is
loud, and it is not a bug in the signing setup — it is what a Keychain ACL is.

**What is actually stable across rebuilds is the Designated Requirement, not
the hash.** Verified on the M4 build: `codesign -d -r-` returns

```
designated => identifier "com.cyrus.buddy" and certificate leaf = H"205a03e7…"
```

before and after re-signing, while the `cdhash` changes every time. The identifier
and the certificate leaf are what a self-signed identity keeps constant, and that
is why the Screen Recording grant survives a rebuild where an ad-hoc signature
loses it.

One thing to know about the ordering: `electron-builder` signs the bundle *before*
it builds the `.dmg`, so the app inside the `.dmg` carries electron-builder's
signature and `sign-app.sh` re-signs the extracted `release/mac-arm64/buddy.app`.
Both have the same Designated Requirement, so the grant is stable either way —
`sign-app.sh` matters when you build the sidecar separately, or re-sign after
editing it.

## What M5 built — buddy learns you

```
src/main/memory/
  embed.ts        potion-base-8M: a WordPiece tokenizer and a mean, in TypeScript
  vectors.ts      the memory index: text + vector per item, sqlite-vec, BM25
  index.ts        keeps the index in step with the rows — computed, not hooked
  recall.ts       hybrid search: meaning and words, fused, aged, diversified
  facts.ts        beliefs: confidence, evidence, and decay computed at read time
  learn.ts        the merge: what a rollup proposes, and what actually changes
  episodes.ts     every run, and every goal the person overrode
  rhythm.ts       the week, from the free T0 signal
  context.ts      what goal inference, the Operator and Ask are each given
  service.ts      one object the app talks to
src/shared/teach.ts            "remember that …", parsed the same in both processes
src/renderer/views/You.tsx     what buddy has learned, and the buttons to correct it
scripts/fetch-embedding-model.sh
evals/memory-retrieval/        30 memories, 26 questions, the retrieval yardstick
```

### The parts worth knowing about

**The embedding model runs no neural network.** potion-base-8M is a Model2Vec
*static* model: a 29,528 × 256 table with one vector per WordPiece token. A
sentence is embedded by tokenizing it and averaging its rows — about 20 µs, on
the main process, with no ONNX runtime, no worker and no network. It was chosen
by measurement, on a retrieval set shaped like buddy's memory
(`evals/memory-retrieval`): top-3 hit rate **96%**, against 65% for BM25 alone
and 46% for Apple's on-device `NLEmbedding` — which costs nothing to ship and
was the first thing tried. A transformer through onnxruntime-node would score
somewhat higher and is a 300 MB native dependency. The tokenizer is a port of
the Hugging Face one the model was trained with, and it is pinned against token
ids from the reference library: a token split one way instead of another is a
different row of the table, and the vector would drift with no error anywhere.

**The vector database is sqlite-vec, inside buddy's own SQLite file.** 160 KB
of C, loaded into the same better-sqlite3 handle as everything else, so a note
and its vector are written in one transaction. But the vec0 table is an
*accelerator*, not the truth: every vector is also a row in `memory_vectors`,
and if the extension will not load, nearest-neighbour search becomes a scan of
those rows and returns the same results — the checks assert they agree to 1e-4.
The next launch where it loads rebuilds the accelerator from the rows. Same
argument as the wakeups table: the row is the thing that survives.

**What is owed is computed from the rows, never hooked.** There is no "embed
this" call in the note store, the rollup, or the fact store. The index asks
SQLite which items have no row, a row older than their `updated_at`, or a row
for something deleted, and fixes exactly those — after every observation, every
rollup and every edit, and in bounded slices before every search. A crash, a
restart, or a write from a path nobody remembered loses nothing. A year of
observations (20,000 rows) indexes in 1.2 s.

**Both halves of recall search the same rows.** Keywords and meaning are two
indexes over one table: the exact text an item is embedded from is also what
FTS5 indexes. The first version searched the notes', observations' and facts'
own FTS tables and pooled the BM25 scores, and that was quietly wrong — each
table has its own statistics, so a weak match in a small table outscored a
strong one in a big table. One corpus, one IDF.

**Fusion is a weighted sum of scores, and that was measured, not assumed.**
The first cut used reciprocal-rank fusion, the textbook default — and the
retrieval check caught it being **worse than meaning alone** (top-3 73% against
96%). RRF's damping makes rank 1 and rank 5 nearly equal, so being found by
both searches at all outweighed being found *well* by one, and in a memory
nearly everything shares a word with nearly everything. It is now 0.8 × cosine
+ 0.2 × BM25 normalised to the query's best keyword match, then weighted by age
and belief, then re-ranked for diversity (six observations of the same ten
minutes are one memory, not six results). On the retrieval set: top-1 **85%**,
top-3 **96%**, MRR **0.91** — better than either half alone, and
`npm run check:memory` fails if a change makes that worse.

**Learning rides the rollup; it is not a second model call.** The hourly
summary is shown what buddy already believes that bears on this hour (found by
meaning), what the person rejected, and the runs since last time — and returns,
beside the recap, at most five `learnings`: add, reinforce, revise or retract,
each naming an F-number it was shown. Then the same rule as the relation merge
applies: **prompt-level reuse keeps the memory readable; the mechanical merge is
what makes it correct.** Whatever comes back goes through `learnFact`, which
finds the existing belief before writing a new one.

**"The same belief" needs the same meaning *and* the same words.** A static
embedding is a mean of word vectors, so "prefers dark mode" and "prefers light
mode" are 0.92 apart in cosine — merge on meaning alone and buddy would count
evidence for the opposite of what it saw, or block a correct belief because it
resembles a rejected one. So a merge needs cosine ≥ 0.85 *and* three-quarters
of the content words in common. "Prefers replying in Slack threads rather than
DMs" reinforces "prefers to reply in the Slack thread rather than by DM";
"light" never reinforces "dark".

**Beliefs fade unless they are seen again, and that costs no clock.** Each
fact stores its confidence as of the last sighting; what anything acts on is
that decayed by age, computed when it is read. A project halves in 21 days, a
habit in 45, a preference in 180, a skill in a year, and evidence slows it — a
habit seen sixteen times outlasts one seen once. Below 0.25 a belief goes
dormant: still listed, labelled *fading*, no longer brought up. Nothing runs
overnight to make that true, so a Mac shut for a fortnight wakes with
fortnight-old beliefs at exactly the strength they should have. A first
sighting is capped at 0.6 — one hour of watching is a hypothesis — and each
confirmation closes 30% of the gap to certainty.

**The person's word outranks the model's.** A belief the person confirmed, or
said, or edited, is pinned: it does not fade, and a rollup can reinforce it but
never revise or retract it. A belief they reject is *kept*, greyed, as a list
of things never to learn again — "wrong" and "forget" are different buttons
because they mean different things. An F-number is honoured only if that fact
was in what the rollup was shown: a made-up id that happened to exist would let
a hallucination edit an unrelated belief. Credentials never become beliefs —
the guardrail's API-key, card-number and seed-phrase detectors run on every
sentence before it is stored.

**Corrections are the most valuable thing buddy sees all day.** When the HUD
offered "Send Priya a DM" and the person typed "Reply in the thread" instead,
that is written down as a correction episode — not discarded with the HUD. The
next goal inference that looks similar is shown it (`<past_corrections>`), with
the instruction that where the screen supports both, what they chose beats what
buddy proposed. The next rollup is shown it too, and usually turns it into a
preference. Picking buddy's *second* guess is recorded as well; typing over the
200 ms provisional goal is not, because that was never buddy's judgement.

**Every stage that acts gets a different slice.** Goal inference gets the
profile (strongest beliefs, early in the bundle with the other stable blocks),
matching corrections, the week's line for this hour, and older recaps that match
the screen — each block present only when it has something in it, so the eval
fixtures render byte-identically to before. The Operator gets "how this person
works": the beliefs and past runs that match *this goal*, framed as background
that never changes the goal, widens the allowlist or authorises anything — and
no heading at all when there is nothing relevant. Ask gets the beliefs that
bear on the question plus the strongest ones, so "what do you know about me?"
has an answer, with F-number citations it can be checked against.

**The week is learned for free.** The T0 signal already says, every two
seconds, which app is in front and how long since the last keystroke. Summed per
app per local hour that is an exact record of when and in what someone works —
no model, no screenshot, and it outlives the daily frame purge because it is
integers rather than pictures. Idle time, gaps from sleep, and apps on the
exclusion list are not counted: knowing how long someone spent in their password
manager is looking at it.

**"Remember that …" is a third route in the Ask box.** Checked before the
question test, shown as a green *remember* chip before Enter, and stored in the
person's own words, pinned — rewriting "I prefer threads" into "Prefers threads"
with a model would be putting words in their mouth in the one place buddy
promised to take them as given. Telling buddy something it was once told was
wrong stores the new sentence and keeps the old rejection as history.

**Learning can be turned off, and that is honoured below the prompt.** Off,
the rollup is told so *and* anything it returns anyway is ignored; goal
inference, the Operator and Ask get none of it; the week stops recording.
Nothing is deleted. "Forget everything learned" deletes beliefs (rejected ones
included), episodes and the week — and leaves notes and the run log, which are
what happened and have their own delete buttons. Deleting a run deletes what
was learned from it.

## What M5 verifies

`npm run check:memory` runs 39 checks. Unlike M3 and M4, the expensive-looking
half is **not** replaced: the embedder is the bundled model, the vector index is
the bundled sqlite-vec, and retrieval quality is measured on a real retrieval
set. Both are local, deterministic and free, so there is nothing to stub. The
one thing replaced is, again, the language model.

- **Tokenizer parity** with the reference library — accents, CJK, emoji,
  punctuation-as-words, an over-long word — and the vector to 1e-5.
- **vec0 and the scan agree** on nearest neighbours, the index **survives the
  extension not loading** with identical results, and **rebuilds the
  accelerator** from rows written while it was away.
- **The index is computed from rows**: every kind of memory once, a second sync
  doing nothing, an edit re-embedded, a delete leaving no vector, and **a
  different model emptying and rebuilding** rather than mixing two spaces.
- **A v1 database migrates** and its existing observations become searchable.
- **The merge**: a re-worded belief reinforced, an opposite kept separate at
  cosine 0.92, a rejection never re-learned, telling overriding a rejection,
  credentials refused from either direction.
- **The arithmetic**: two half-lives to dormant, skills fading slower, evidence
  slowing decay, pinned beliefs not fading, diminishing reinforcement.
- **Learning through the real NotesEngine** and a scripted Sonnet: the prompt
  carries the relevant belief, the rejection and the correction; the reply
  reinforces one, adds one and has one blocked; the run is marked learned from.
  With learning off, nothing is learned even when the model returns some.
- **A model cannot rewrite a confirmed belief** or touch one it was not shown.
- **Runs**: accepted, alternative, corrected, typed and provisional goals told
  apart; waiting → resumed → done recorded as one episode with one correction;
  deleting the run forgetting both.
- **Retrieval quality**: keywords alone 62% top-1, meaning alone 81%, hybrid
  85% — with top-3 96% and MRR 0.91 — on 26 questions; a question with no word
  in common with its answer; recency and diversity; Ask citing a fact; the Notes
  search widening by meaning.
- **The stages**: the inference bundle carries the profile, the correction and
  the week, and none of it with learning off; **all five eval fixtures render
  byte-identically** with empty memory; the Operator's section appears for a
  Jira goal, leaves out an irrelevant belief, and is absent for a cake order.
- **The week** from synthetic signals: 40 minutes at 10:00, with idle time, the
  password manager and a sleep gap not counted.
- **Scale**: 20,000 observations embedded in 1.2 s; median recall 11 ms.
- **Both providers' schema converters** accept the new rollup and Ask shapes.

What it does **not** cover: whether a live Sonnet learns *good* beliefs from a
real afternoon. `npm run live:learn` is the harness for that — two days of a
person's habits rolled up separately, a correction, Ask and goal inference, all
live, in a throwaway database. It has not been run against the API yet: the key
this was built with had no credit when it was tried.

## What M4 built — the waiting, and the rest of the app

```
src/main/agent/
  standby.ts      the poll, the cheap check, the resume, the exhaustion
  context.ts      the transcript that survives a restart, images stripped
src/main/
  notify.ts       three notifications, and only three
  providers.ts    §9.1's matrix as data, plus the OpenAI-compatible client
  notes/ask.ts    FTS5 + the notes into context (M5 put vector search behind the same seam)
  store/timeline.ts  days, apps, and "delete this day now"
src/renderer/
  views/Timeline.tsx        the day scrubber and the filmstrip
  components/standby.tsx    what buddy is waiting for, and how to stop it
  components/ask.tsx        one input that either answers or runs
```

### The parts worth knowing about

**The wait is a row, not a timer.** A `setTimeout` for five minutes does not
fire on a Mac that slept for four of them, and "buddy is still there forty
minutes later" is the entire claim of Story B. So the schedule lives in SQLite
and a short poll asks what is due. Quitting buddy does not cancel anything; the
next launch reads the same rows and says out loud what it found. An overdue
wakeup fires **once**, not once per interval missed — a check that did not happen
has nothing to catch up on, because the condition is either true now or it is not.

**A check buddy could not run does not spend an attempt.** No key, a wedged
sidecar, a capture that failed, a 502 from the API — none of those is an answer
about the condition. Burning one of twelve attempts on each would turn a
five-minute outage into a wakeup that quietly gave up on something the user was
promised. Only a real answer counts.

**The check is cheap on purpose, and the number matters.** One downscaled
screenshot and the condition string through Haiku 4.5 costs **$0.0028**. Twelve
of those — an hour of checking every five minutes — is under four cents. The same
hour through Opus would be a reason not to offer the feature.

**Resume is the same run, continuing.** Same row in `runs`, same step sequence
continuing rather than restarting, and the saved transcript replayed into the
request so the model does not re-create the page it was supposed to be filling
in. The wake checks are in the run log too: waiting is part of what a run did,
and a log that shows twenty clicks and then an hour of nothing cannot answer
"was it actually watching".

**The budgets restart on a resume; the run row does not.** A run that waited
forty minutes would blow a ten-minute wall clock before its first click, so each
attempt gets its own step, time and cost budget. The row stays cumulative, so
the Run Log still shows what the whole thing cost.

**The saved transcript keeps the blocks and throws away the pictures.** Three
live screenshots per wait is over a megabyte of base64 showing a screen that has
since changed, and the resume takes a fresh one as its first act. The
`tool_result` blocks stay, because dropping one orphans its `tool_use` and
invalidates the conversation on the next request — so an image becomes a
placeholder and the structure is untouched. A six-screenshot transcript is 1.1 KB
on disk instead of 1.2 MB.

**Ask-about-my-day needs both halves of its retrieval.** Searching for the
question's terms answers "what did Priya want" and returns *nothing* for "what
did I do this morning?" — which has no distinctive term in it and is the
commonest question there is. So the recent recaps, tasks and relations go in
regardless. The answer cites note ids, and a citation that does not resolve to
something actually sent is dropped rather than rendered as a chip that opens
nothing.

**The Timeline's countdown is read from the frames, not from the setting.**
Retention is stamped on a frame when it is written, so somebody who changed the
setting yesterday has frames from two regimes in one directory. Showing the
current setting would display a number that is simply not when the files go.
Days are grouped by *local* date in SQL, matching the vault's own directory
names — a UTC key would put this morning in yesterday for anyone west of
Greenwich.

**Settings says the Claude-only rule where it matters.** The provider table is
generated from the capability flags, and the Operator's availability is shown
with the *same sentence* `orchestrator.start()` throws. One message, one author:
the UI cannot end up disagreeing with the guard about why the hotkey is
unavailable.

**Every provider is addressable, and its models are named rather than
compiled in.** Settings carries a base URL for Anthropic and OpenAI as well as
for the local runtime, plus a model id per Anthropic role — Operator, T2, T3,
goal inference, Q&A, and the standby check. Blank means the first-party host and
the first-party id, which the field shows as its placeholder. The two halves go
together on purpose: a gateway that fronts the Messages API usually renames the
models too, and a base URL on its own would reach the gateway and 404 on every
call. Spend is priced by the first-party id found *inside* the name, so
`anthropic.claude-sonnet-5-v1:0` still meters — which matters because
`dailyCapUsd` is a safety control, and a cap where every call costs $0 is a cap
that is off.

**Each configured provider has a Test connection button.** It makes one tiny
real call per *distinct* model id, through the configured host and key, and says
what failed in words that name the thing to change: a rejected key (401), a
model id the endpoint does not serve (404 — "either the id or the URL is
wrong"), nothing listening on the port, a host that does not resolve. Anthropic
probes every id the six roles use, and each line names the roles that id
serves, because the gateway case is exactly the one where five roles connect and
the sixth does not. The OpenAI and local paths are tested the way buddy uses
them — a JSON-schema request validated by zod — since a local model that answers
"hello" but ignores `response_format` would pass a chat ping and then fail every
observation. Probes do not retry (a retry hides a flaky gateway), and they are
metered under *connection tests*.

## What M4 verifies

`npm run check:m4` runs 50 checks against the real modules, with the same one
thing replaced as M2 and M3: the **model**. The `StandbyManager`, the
`AgentRunner`'s resume path, the `Operator`, the store, the transcript
serialisation, the Timeline queries, the retention sweep and the FTS5 retrieval
are all shipping code.

- **The wakeup surviving a restart**, asserted by closing the database and
  reopening it — which is what quitting buddy does — then constructing a fresh
  manager and finding the schedule still there.
- **The reschedule arithmetic**: one attempt spent, the next check exactly one
  interval out, the run still waiting, and the model's own sentence in the run
  log rather than a bare `false`.
- **Three ways of being unable to look** — no key, a failed capture, a failing
  API — none of which spends an attempt, and a real check afterwards that does.
- **Exhaustion**, with the run's real step count and dollars preserved rather
  than zeroed, the number of looks in the outcome text, and nothing firing
  afterwards.
- **Resume carrying prior context**, asserted by reading the request the resumed
  run actually sent: the earlier conversation is in it, the condition is in it,
  what the check saw is in it, and every `tool_use` still has its `tool_result`.
  Plus that the steps append rather than overwriting the first attempt's.
- **Standby composing** — wait → resume → wait — with a fresh wakeup, a fresh
  attempt budget, and the accumulated context still there.
- **A met condition with no transcript stopping**, rather than starting the task
  over from a goal string, which is the behaviour this whole feature exists to
  avoid.
- **Retention against the Timeline**: two days of frames, the sweep taking
  exactly the expired one, "delete this day now" unlinking the PNGs while the
  note that cites them survives and reports them expired.
- The provider matrix, the strict-mode schema conversion, the settings
  normalisations, and that `notes.embedding` is `NULL` everywhere.

What it does **not** cover: a live model call, and whether macOS actually
displays a notification (the notifier is injected, so what is asserted is that
they fire).

### The two live runs

`npm run live:run` and `npm run live:standby` are the only things here that talk
to the real API, and they exist because the check suites structurally cannot.

**`live:run`** does a real two-app task — read two numbers out of a TextEdit
scratch document, add them in Calculator, type the total back — and then answers
the three questions M2 left open. It finished the task in **41 steps, 62 s,
$0.226**, and the harness checked the file rather than the model's summary.

- **`toolset_name: "computer"` is accepted**: 39 computer `tool_result` blocks
  across 7 turns, zero API errors, in any run.
- **Prompt caching works**: `cache_read_input_tokens` 6,346 → 9,511 → 13,258 →
  14,813 → 18,799 → 22,209 → 23,128. No silent invalidator.
- **Pruning does not desync pairing**: 7 images → 4 pruned → 3 left, pairing
  intact on both sides of the prune, and the API accepted the pruned
  conversation.

It also found three things no scripted client could, and two of them were bugs:

1. **A gate answered synchronously was silently dropped and the run hung
   forever.** `askUser()` emitted the `gate` event before installing the
   promise's resolver, so an immediate answer found nothing to resolve and the
   promise was never settled. The HUD never hit it, because an answer over IPC
   is always a tick late. The first live run stopped dead at step 3 holding the
   keyboard, with no error anywhere.
2. **A halted run leaves an unanswered batch, and standby is the first thing
   that ever re-sends one.** A denied gate, a kill switch, or a blown budget
   returns from the loop without pushing that batch's results — correctly,
   because the model gets no further turn after a block. The API is blunt about
   what that means later: *"tool_use ids were found without tool_result blocks
   immediately after"*. `sealTranscript` now answers every orphan with an error
   result saying the block did not run. This was nearly blamed on pruning: the
   first harness only checked pairing *after* the prune and reported seven
   orphans as a pruning failure. Measuring both sides showed they were already
   there.
3. **A GUI calculator costs one step per digit.** Given 30 steps, the run
   reached the right answer and ran out of budget on the way back to TextEdit.
   `8616 + 5821 =` is eleven clicks. The step budget counts tool calls, not
   intentions.

Installing the build and actually opening it found two more, which neither the
checks nor the live harnesses could — neither of them opens a window:

4. **The packaged app opened a blank window.** `windows.ts` resolved the preload
   script and the renderer's HTML relative to `import.meta.url`, which is right
   while that module lives in `out/main/index.js` and wrong once rollup hoists it
   into `out/main/chunks/` — and what decides the hoist is how many modules
   import it. Adding `notify.ts` made it two. So a path's correctness depended on
   a bundler heuristic reacting to an unrelated file, it was invisible in
   development (where the renderer is served over HTTP), and in production the
   `ERR_FILE_NOT_FOUND` went to a renderer console nobody has open. Both paths
   now come from `app.getAppPath()`, and a failed load is logged where buddy's
   own log will show it.

5. **A re-signed build could not read its own stored API key, and said so every
   few seconds.** The Screen Recording grant survives a rebuild — that is what
   the self-signed certificate is for — but the Keychain item `safeStorage`
   writes is tied to the binary and does not. Since `./scripts/sign-app.sh` is a
   normal step here, so is this. It is now latched and logged once with the real
   explanation, and Settings says *"buddy has a stored key it cannot read"* with
   the one action that fixes it.

**`live:standby`** is Story B with nothing scripted. A document says `STATUS:
pending`; Opus 5 reads it, cannot proceed, and calls `finish(waiting)` with a
condition. The database is then **closed and reopened** — the wait survives it,
because the wait is a row. The document flips to `READY`. The real
`StandbyManager` captures the real screen and asks **Haiku 4.5**, which sees it
on the first check for **$0.00214**. The *same run* resumes on Opus 5 with its
saved transcript, appends `SHIPPED`, saves, and finishes `done` — 12 cumulative
steps, $0.126, one wake check and one resume step in the run log, the wakeup
consumed and the transcript cleaned up.

## What M3 built — the memory

```
src/main/notes/
  engine.ts       the three clocks: T2 every ~3 min, T3 hourly, and midnight
  observer.ts     T2 — frames + the T0 log → Haiku 4.5 → one observation row
  rollup.ts       T3 — observations → recap, relations, tasks → Sonnet 5
  identity.ts     the relation merge: "Priya" and an email are one person
  session.ts      a contiguous run of activity, ended by idle or a sleeping display
  spend.ts        the daily meter and the cap that pauses observing
  downscale.ts    the Observer's image ceiling, which is NOT the Operator's
src/main/agent/
  inference.ts    the Context Bundle, built from real rows, to Opus 5
  activation.ts   the hotkey: a local guess in 200 ms, a reading in eight seconds
src/main/store/notes.ts   observations, notes, relations, tasks, links, FTS5
```

### The parts worth knowing about

**The hotkey shows a goal before it has one.** Goal inference takes a median of
8.6 seconds and up to 22 on an ambiguous case, and a hotkey that shows nothing for
eight seconds is a hotkey people stop pressing. So activation is two events: a
provisional goal read straight off the newest open task note — one indexed SQLite
query, measured at 0.17 ms — and then the model's reading, which replaces it *in
place*. Nothing appears above the goal after the first paint, because a layout
that pushes the headline down at second nine reads as a different screen rather
than the same one, updated.

**Relations are merged in code, not in the prompt.** People arrive spelled five
ways in an afternoon — "Priya" in a window title, "@priya" in a mention, "Priya
Raman" in a reviewer list, an email in a header. The extractor is shown what
already exists and usually reuses it, but "usually" is not a data model, so every
upsert runs the merge regardless of what came back: exact identifier, then any
alias, then a given-name-to-full-name match. When a row's identifier is promoted
(a first name becoming an email) the old spelling becomes an alias in the same
transaction, or the next "Priya" starts a sixth row. Two rows that should always
have been one get folded together, links repointed, frequencies summed.

The rule that must *not* be loose is the other direction: `Priya Raman` and
`Arjun Raman` are two people, and a merge that fused them would be invisible and
permanent.

**The Observer's image ceiling is not the Operator's, and they do not share a
constant.** Haiku 4.5 caps images at 1568 px and ~1.15 MP; Opus 5 caps at 2576 px
and 3.75 MP. 1080p exceeds the first and not the second. One shared constant would
silently break whichever tier changed second — as a 400 on the cheap tier that
reads like the observer being broken, or as a quietly wasted 2.6× on image tokens
for every observation of every day. Two ceilings, two homes, and a check that
asserts they are different numbers.

**The daily cap pauses observing and never blocks you.** Goal inference and the
Operator spend past it, because they are things you asked for in the moment. A
cost control that turns the hotkey into a blank stare is not a cost control; it is
an outage with a plausible explanation. What the cap is actually for is the
Observer running all night against a machine somebody left logged in.

**Notes outlive the screenshots they came from, and say so.** Frames expire
daily; a note that cites three of them still shows three, with the expired ones
labelled rather than dropped. A silently shorter list would be a quiet lie about
where the note came from.

**Every note is editable and deletable.** That is a product requirement, not a
convenience: an assistant that remembers something wrong about your colleague and
gives you no way to fix it is worse than one that remembers nothing.

## What M3 verifies

`npm run check:m3` runs 66 checks against the real modules. One thing is
replaced — the **model**, by a scripted structured-output client — because every
invariant worth testing here is about what the engine does with a response.

- **The relation merge**, across four spellings converging on one row, a bare
  first name still finding the row after its identifier was promoted to an email,
  two separate rows folded together when a sighting links them, links repointed
  rather than cascaded away, and the unique index never violated by a promotion.
- **The task lifecycle**: every transition including reopening a `done` task, an
  invalid status rejected at the write with a sentence rather than as a `CHECK`
  violation three layers down, `next_check_at` that cannot drift from `status`,
  and scope widening session → day → week for open tasks only.
- **Tier cadence.** An application switch triggers T2; a window-*title* change
  does not, because a title changes on every keystroke in an autosaving document.
  Six switches in two seconds bill one call; the seventh, 46 seconds later, bills
  one more. The interval timer is shown firing on its own with no switch at all.
- **The daily cap actually pausing T2 and T3** — asserted by the model never being
  called, not merely by a flag being read — while goal inference and the Operator
  still spend, and raising the cap resuming observing without waiting for midnight.
- **Retention against notes that cite expired frames**: the note survives, the
  frame is reported `expired` rather than omitted, and it keeps its app name.
- **FTS5** through an edit, a delete, prefix queries, per-tab scoping, and every
  character that is FTS5 syntax — `"`, `*`, `-`, `NEAR`, `:` — because a parse
  error in a live-search box means results vanish as the user types an apostrophe.
- **Goal inference end to end**: the bundle built from real rows (three frames,
  two observations, open tasks only, five minutes of signals, relations matching
  the apps on screen), the provisional goal measured against its 200 ms budget,
  `target_apps` seeding the allowlist, a dismissed activation aborting the request
  rather than billing for it, and a slow first activation unable to clobber a fast
  second.
- **The prompt's two hard-won findings** are pinned, so a rewrite cannot lose them
  quietly: the profile rule framed as reversibility rather than app category, and
  explicit per-flag risk definitions.

What it does **not** cover: a live model call, and whether the notes are any good.

### Whether the notes are any good

That half of M3's exit criterion — *"the notes it shows are recognizably true"* —
is not mechanically testable, so it was checked the only way it can be: buddy was
run against this machine and what it wrote was read.

## What M2 built — the Operator

```
src/main/agent/
  runner.ts       the computer-use loop: batching, fail-stop, pruning, caching
  executor.ts     the ONE place a CGEvent is dispatched, and so the one place
                  guardrails are enforced and coordinates are translated
  guardrails.ts   classify() + the §7.1 policy matrix, pure and synchronous
  killswitch.ts   all three switches, converging on one fire()
  budget.ts       steps / wall clock / dollars, checked before every batch
  tools.ts        computer_toolset_20260801 + describe_focused_window + finish
  prompt.ts       the Operator system prompt
  orchestrator.ts one run at a time, and one place that knows which
sidecar/Sources/
  Input.swift     CGEvent synthesis for all 17 toolset members
  Target.swift    the guardrail's pre-dispatch AX read, and the input tap
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

**Touching the keyboard does not stop a run.** It did in the first cut of M2,
and that was wrong: buddy drives the same mouse and keyboard the user has their
hands on, so scrolling to watch it, or fixing a typo in another app, killed the
run for a reason the user could not always reconstruct. Stopping is now always
explicit — the hotkey, Stop, or the ABORT file — and the event tap survives as
an annotation on the run log instead. PRD §7.3 has the full argument.

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

**A confirm gate can be answered "for the rest of this run."** A task that sends
fifteen Slack messages otherwise asks fifteen times, and by the fourth the user
is clicking Approve without reading — which is worse than not asking, because it
produces the paperwork of consent without the substance. The grant is scoped to
the action class *and* the app, so approving one Slack message never becomes
permission to send an email; it is never persisted; it is offered on the second
ask rather than the first; and a denial is never grantable, because a denial
never reaches a gate. The HUD says which grants are live while the run goes.

**Leashless mode is unattended with every gate open.** Every class, including the
two that are denied under both other profiles: it will send mail, delete files,
install software, complete a purchase, and type a card number or an API key,
with nobody asked. It is off by default, has to be turned on in Settings behind a
confirmation that names what it permits, is refused by `startRun` until then, and
is never buddy's own suggestion. The kill switches and the budgets still apply,
and they are the only things that do. PRD §7.1 states the cost plainly.

**Its prompt matches its table.** The Operator is told *nothing is refused*,
rather than inheriting the unattended wording. When it inherited it, the model
was told in one breath that nobody was watching and that sending was refused
outright, and it did the only thing left: stopped and announced what it would
not do — a refusal nothing enforced and nothing logged, on the profile the user
turned on precisely so it would not happen. The prompt is not the mechanism, so
it must not claim a limit the mechanism does not have.

**It has no allowlist** — not one it ignores. The difference shows up in the run
log: a list that is present and then overridden still classifies every step in a
non-listed app as `off_allowlist` before allowing it, so a leashless run reading
two apps filled its log with rows naming a rule that could never apply. Now a
read is recorded as a read. Which apps it touched is still on every step, read
from the accessibility tree at dispatch. The HUD does not show an app set for
it, and `startRun` clears one if a caller sends it anyway.

**Run screenshots outlive the daily purge**, because the Run Log is the trust
surface and a log whose pictures vanish overnight cannot answer "what did buddy
click". They live under `runs/<id>/`, not in the frame vault, and deleting a run
deletes them.

## What M2 verifies

`npm run check:m2` runs 60 checks against the real modules. Two things are
replaced, and only two: the **model**, by a scripted client that returns the
exact content blocks a turn would; and on a machine without Accessibility, the
**sidecar's input path**. Everything between those seams is shipping code.

What that covers, concretely:

- **All three kill switches fired mid-run**, with seventeen more turns of work
  queued behind them, each shown to park the run with its log intact. A kill
  switch that was never actually fired mid-run is not tested, so each one is.
- **Human input does not stop a run**, and is recorded. A `human_input`
  notification is delivered mid-run with more work queued behind it, and the run
  is shown to carry on and finish — while the log gains the line saying the user
  touched the machine. The old behaviour (stop on any keystroke) was removed
  deliberately; PRD §7.3 says why.
- **`BUDDY_MAGIC` actually discriminates.** buddy synthesizes an F19 keystroke
  and no `human_input` notification arrives; an identical F19 from another
  process produces one. That is what makes the takeover note mean anything, and
  until it was tested this way both halves passed vacuously because of the tap's
  arm delay.
- **The guardrail matrix**, all three profiles, including that a gated action
  confirms in attended and parks in unattended, that a credential field denies
  in both, that a deny is never followed by an alternate route — the model gets
  no further turn at all — and that leashless allows every class, is refused
  until Settings enables it, still records the class each step would have been
  gated under, and is handed a system prompt that does not invent a refusal the
  table does not have.
- **Session grants**: four sends behind two asks and one grant, a grant in Slack
  that does not cover Mail, a grant that does not survive into the next run, and
  a denial that no grant can widen because it never reaches a gate.
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

**That sentence was false until M4, and the way it was caught is worth keeping.**
The vocabulary check proved buddyd's 17 action names by sending each one a
*well-formed* request — so it really clicked, really triple-clicked, really held
the mouse button down, and really typed the letter `a` into whatever window the
person running the suite had focused. It was found by those letters arriving in
a chat window during an M4 run. It had also been quietly causing a flaky failure
two checks later: a triple-click at 1,1 opens the Apple menu, an open menu grabs
the cursor, and `CGWarpMouseCursorPosition` then reports success while the
pointer does not move — so *"real CGEvent dispatch moves the pointer"* failed
for a reason that had nothing to do with CGEvent dispatch. The probe now sends
`coordinate: []`, which fails validation inside buddyd before anything is
synthesized. The only things that still execute are a cursor read and a
one-second `wait`.

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

What buddy learns about you (M5) is stored here and indexed here: the embedding
model and the vector index run on this Mac, and nothing is sent anywhere to be
embedded. Learned beliefs **do** leave as model input, the same way notes do —
the relevant ones go with each hourly summary, each goal inference, each run and
each question. The You tab shows every one of them, and Settings › Memory turns
learning off.
