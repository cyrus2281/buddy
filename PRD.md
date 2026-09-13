# buddy — Product Requirements Document

**Version** 0.1 · **Date** 2026-09-12 · **Status** Ready to build
**Platform** macOS 14+ (built and tested on 15.7) · **Timeline** 4 days to demo

---

## 1. What buddy is

buddy is a macOS app that watches how you work, builds a durable memory of it, and — on one keystroke — takes over your machine and finishes what you were doing.

Two halves, always both running:

- **The Observer** (passive, continuous): screenshots the screen, notices what changed, writes structured notes. Screenshots expire daily. Notes are permanent.
- **The Operator** (active, on demand): reads the recent screen + the notes, infers *what you were doing*, and drives the mouse and keyboard to finish it. No prompt required.

The product claim is the absence of a prompt. Every other computer-use tool asks "what do you want?" buddy already knows, because it was watching.

### Non-goals for v1

- Windows / Linux. Signed, notarized distribution. Multi-user or cloud sync.
- Vector search, wake-word activation, voice I/O. (All four have explicit seams — §9.)
- Buddy operating a machine nobody is logged into, or across a lock screen.

---

## 2. Users and the two stories

**Primary user:** a knowledge worker who lives in 6–10 apps and loses 20 minutes a day to context reloading.

**Story A — "finish this."** You are mid-way through filing a Jira ticket from a Slack thread. Meeting starts. You hit `⌥⌘Space`. buddy says *"Filing SAM-4412 from Priya's thread — pasting repro steps next."* You hit Enter and walk away. It finishes and leaves a run log.

**Story B — "watch for this."** You asked a coworker for a decision and can't proceed without it. You hit the hotkey. buddy sees the blocked state, does what it can, then goes to standby with *"checking Slack every 5 min for Priya's reply; will resume drafting when it lands."* Forty minutes later it wakes, sees the reply, and finishes.

Story A is the demo. Story B is the differentiator.

---

## 3. Architecture

```
buddy.app  (Electron shell, unsigned/self-signed — free to install)
│
├── main  (Node 22 + TypeScript)
│   ├── Orchestrator      state machine, single source of truth
│   ├── CaptureScheduler  tiered observation pipeline (§5)
│   ├── NotesEngine       observations → recap / relation / task notes
│   ├── AgentRunner       Claude computer-use loop (§6)
│   ├── Guardrails        profile policy, enforced in the executor (§7)
│   ├── Store             SQLite (better-sqlite3) + frame vault on disk
│   ├── Providers         Anthropic | OpenAI | Local, capability-gated (§9)
│   └── Sidecar           spawns + supervises `buddyd`
│
├── renderer  (React 19 + TS + Tailwind + Framer Motion)
│   └── HUD · Home · Notes · Timeline · Run Log · Settings  (§8)
│
└── buddyd  (Swift binary, in Contents/MacOS/, JSON-RPC over stdio)
    ├── capture(display|window|region) → PNG, Retina→logical downscale
    ├── ax_tree(pid?) → accessibility tree (roles, titles, frames, values)
    ├── target_info(x?,y?) → the guardrail's one pre-dispatch read: frontmost
    │                        app, focused element, page URL, element under the
    │                        pointer (§7.2)
    ├── input(action) → CGEvent synthesis
    ├── watch_input() → event tap; pushes `human_input` for anything untagged
    │                    (a run-log annotation, not a kill switch — §7.3)
    ├── secure_input() → Bool  (IsSecureEventInputEnabled)
    ├── frontmost() → {bundleId, appName, windowTitle, idleSeconds}
    └── permissions() → {screenRecording, accessibility}
```

### 3.1 Why this stack

Electron owns the UI because a polished, animated interface is a hard v1 requirement and React + Framer Motion gets there in hours, not days. Swift owns everything TCC-gated because ScreenCaptureKit, CGEvent, and AXUIElement have no usable JS bindings. Verified on this machine: `swiftc` compiles ScreenCaptureKit + ApplicationServices against the Command Line Tools SDK — **no Xcode, no Apple Developer account, nothing to pay for.**

Distribution for testing: unsigned `.dmg` via `electron-builder`; first launch is right-click → Open. To keep TCC grants stable across rebuilds, sign with a **free self-signed certificate** created in Keychain Access — an ad-hoc signature changes every build and silently revokes Screen Recording each time.

The Electron/Swift split is a UI decision, not an architectural one. Every macOS primitive lives behind the `buddyd` JSON-RPC surface, so replacing the shell later touches no capture, input, or agent code.

### 3.2 State machine

```
IDLE ──start──▶ OBSERVING ──hotkey──▶ ARMED ──confirm──▶ ACTING
                    ▲                   │                  │
                    │                   └──esc──┐          ├─▶ done ──────▶ OBSERVING
                    │                           ▼          ├─▶ waiting ──▶ STANDBY ──wake──▶ ACTING
                    └───────────────────────────┴──────────┴─▶ blocked ──▶ NEEDS_HUMAN
```

`PAUSED` is orthogonal and reachable from anywhere (menu bar, hotkey, exclusion-list match). Observation halts entirely; no capture, no model calls.

---

## 4. Data model (SQLite)

```sql
frames(id, ts, display_id, path, w, h, bundle_id, app_name, window_title,
       phash, ocr_text, expires_at, deleted_at)

observations(id, ts_start, ts_end, summary, apps_json, entities_json,
             confidence, frame_ids_json)          -- raw, machine-written

notes(id, type, title, body, created_at, updated_at, salience,
      source_obs_json, embedding BLOB NULL)       -- type: recap|relation|task
note_links(note_id, related_note_id, kind)
notes_fts(title, body)                            -- FTS5, v1 search

relations(note_id, kind, identifier, display_name, aliases_json,
          frequency, last_seen_at)                -- person|app|product|customer|tool
tasks(note_id, status, scope, last_seen_at, next_check_at, artifacts_json)
                                                  -- scope: session|day|week

runs(id, started_at, ended_at, profile, goal, status, steps, cost_usd, outcome_json)
run_steps(run_id, idx, tool, input_json, result_json, frame_path, is_error, ts)
wakeups(id, run_id, fire_at, condition, interval_s, attempts, max_attempts)
settings(key, value)                              -- never secrets; see §7.4
```

`notes.embedding` is `NULL` in v1 and exists so vector search is a backfill job, not a migration.

`wakeups` is the standby schedule and it is **the only copy** — there is no
in-memory mirror. M4's manager polls it rather than holding a timer per row,
because a `setTimeout` for five minutes does not fire on a Mac that slept for
four of them, and "buddy is still there forty minutes later" is the entire claim
of Story B. A run's saved conversation lives beside its screenshots at
`runs/<id>/context.json` rather than in a column: it is a blob nothing queries,
and it is deleted with the run.

### 4.1 The three note types

| Type | Answers | Scope | Written by |
|---|---|---|---|
| **Recap** | "What have I been doing?" | session / day / week | Rollup, hourly + on session end |
| **Relation** | "Who and what do I work with?" | permanent, deduped | Extractor, incremental |
| **Task** | "What am I working on right now?" | session / day / week, with status | Extractor + rollup |

A **session** is a contiguous run of activity ending after 10 minutes idle or a display sleep.

Tasks carry `status ∈ open | blocked | waiting | done` and are the primary input to goal inference. A task that goes `blocked` or `waiting` is exactly what Story B resumes.

**Scope widens on its own.** A `session` task still open when the session ends
becomes `day`; a `day` task still alive at midnight becomes `week`. It only ever
widens, and only for tasks that are not `done`. Without this, `scope` is a label
nobody ever changes and every task in the database reads as "session" forever.

**`done` can be reopened**, and the transition is logged. Refusing it would make
the memory uncorrectable, which is the one thing §8.3 says it must not be.

---

## 5. The Observer

Continuous full-fidelity capture sent to a model is unaffordable and unnecessary. Four tiers, each an order of magnitude cheaper than the one above it.

| Tier | Cadence | Cost | Does |
|---|---|---|---|
| **T0** signals | 2 s | free | Frontmost app, window title, idle time, display changes. Detects context switches. |
| **T1** frames | 15 s (configurable) | free | Screenshot → pHash. If pHash distance < 8 **and** app unchanged, discard and extend the current segment. Otherwise persist. Typical keep rate 20–35%. |
| **T2** observe | every 3 min, or on an **app** switch (debounced) | ~$0.005 | 3–6 most-changed new frames + the T0 event log → **Haiku 4.5**, structured output → one `observation` row. |
| **T3** rollup | hourly + session end + midnight | ~$0.05 | Observations → recap notes; extract and merge relation + task notes. **Sonnet 5**. |

**What "context switch" means at T2, and why it is narrower than at T1.** The T0
signal marks a switch whenever the frontmost **app or window title** changes,
which is the right trigger for a free screenshot and a ruinous one for a billed
model call — a title changes on every keystroke in a document with an autosaving
name. T2 triggers on a change of **application**, no more often than
`observeMinGapMs` (45 s default), and only with at least two new frames behind
it. Without the floor, alt-tabbing between two windows bills an observation per
keypress. Measured on the machine this was built on, T2 costs about **$0.005**
per observation rather than the $0.01 estimated here.

**Budget:** ~$1.50–2.50 per 8-hour day. Surfaced live in Settings as a running daily total with a hard cap that pauses T2/T3 when hit.

**The cap pauses T2 and T3. It never blocks the user.** Goal inference, the
Operator, and M4's wake checks all spend past it, because they are things a
person asked for in the moment, and a cost control that silently turns the
hotkey into a blank stare is not a cost control — it is an outage with a
plausible explanation. The risk R5 is actually about is the Observer running all
night against a machine somebody left logged in, and that is exactly what the cap
stops.

**Tier sizing gotcha:** Haiku 4.5 caps images at 1568 px long edge / ~1.15 MP. Downscale observer frames to **1366×768** (1.05 MP). Operator frames go to Opus 5 and use a different ceiling — §6.2.

**OCR:** macOS `VNRecognizeTextRequest` runs locally in `buddyd` on kept frames. Free, no network, and makes FTS5 search cover screen text, not just note prose. Ships in M3 if time allows; nothing depends on it.

### 5.1 Retention

- **Frames:** `expires_at = ts + retentionDays` (default 1, range 1–7). Purge sweep on launch and hourly; unlinks the file and tombstones the row.
- **Notes, observations, runs:** kept indefinitely. Exportable as JSON. Deletable per-item and in bulk from the UI.
- **Run-step screenshots** are the one exception to the daily purge, and they have to be: the Run Log is the trust surface (§8.5), and a log whose pictures vanish overnight cannot answer "what did buddy click". They live with the run under `runs/<id>/`, not in the frame vault, so the sweep never sees them — and deleting a run deletes them with it. The Run Log says so on its face rather than leaving the user to infer that one kind of screenshot outlives the other.
- **Exclusion list:** bundle IDs and window-title regexes that are never captured. Ships pre-populated with 1Password, Keychain Access, and Passwords. Private/incognito browser windows are excluded by title heuristic, and so are **billing and payment pages** — added in M3 after watching a real observation quote a card's last four digits back from a billing screen that happened to be open. Nothing was malfunctioning: §5.2 says plainly that frames go to a model. But a payment page is credential-adjacent in the same way a password manager is, and leaving it out costs nothing. Every rule is disableable. When the AX tree reports a focused `AXSecureTextField`, T1 skips the frame entirely.

### 5.2 Privacy, stated plainly

Screenshots never leave the machine **except** as model input during T2, T3, goal inference, and every Operator turn. That is the product. The UI must say so in Settings without euphemism, show the running per-day image count, and offer a one-click Pause that is honored everywhere.

---

## 6. The Operator

### 6.1 Activation → goal inference

1. Hotkey (`⌥⌘Space` default, rebindable via an in-app recorder) → `ARMED`.
2. HUD springs in and shows a **provisional goal within ~200 ms** read straight from the newest open task note — zero model latency. Measured inference latency is a **median of 8.6 s and up to 22 s** on ambiguous cases (§6.7), so this local provisional goal is not a nicety — it is the only thing standing between the hotkey and a ten-second blank stare. Treat it as load-bearing.
3. In parallel, a **Context Bundle** goes to Opus 5:
   - the last 3 kept frames (newest at full logical resolution)
   - the last 2 observations
   - all `open` / `blocked` / `waiting` task notes
   - relation notes matching the apps on screen
   - the last 5 minutes of T0 signals
4. Structured output refines the HUD in place. Canonical schema in
   [`prompts/goal-inference.schema.ts`](prompts/goal-inference.schema.ts):
   ```jsonc
   { "goal": "Fill the empty 'Blockers' heading in the Notion page 'Q3 Migration' with the connector-rename issue from Priya's 11:04 message in #sam-eng",
     "confidence": 0.88,
     "alternatives": [],                      // required below 0.60
     "evidence": ["Notion 'Q3 Migration' open, cursor in empty 'Blockers' body (frame 3)",
                  "Priya's 11:04 message re-read twice in #sam-eng (obs 14:26-14:31)"],
     "already_done": ["Page created with four headings", "Overview filled with three bullets"],
     "first_steps": ["Focus the Notion window", "Click into the body under 'Blockers'"],
     "proposed_profile": "attended",
     "risk_flags": [],
     "target_apps": ["notion.id", "com.tinyspeck.slackmacgap"],
     "injection_notice": null }
   ```
   Three fields carry more weight than they look:
   - **`already_done`** is what makes "continue" mean continue. Without it the operator
     re-creates the page it is supposed to be filling in.
   - **`target_apps`** seeds the unattended allowlist, so the user confirms the app set in
     the same keystroke as the goal. The allowlist is built per run from inference rather
     than being static config nobody maintains.
   - **`injection_notice`** quotes any on-screen text that tried to instruct the model (§7.4).
     Non-null is surfaced in the HUD and never changes the goal, profile, or risk flags.
5. User presses **Enter** to run, **types** to amend or correct the goal, or **Esc** to cancel. Confirmation is explicit — no auto-proceed countdown in v1.
6. If `confidence < 0.5`, buddy states its two best guesses (`alternatives`) and asks rather
   than acting. Confidence bands are anchored explicitly in the prompt, because an inflated
   score costs a wrong action on someone's computer while a deflated one costs one question.

The prompt lives in [`prompts/goal-inference.system.md`](prompts/goal-inference.system.md) and
is exercised by [`evals/goal-inference`](evals/goal-inference/README.md) — five fixtures covering
category-instead-of-action goals, recency-over-activity errors, inventing a task from idle
browsing, on-screen prompt injection, and re-asking an already-answered question. Run it after
every prompt edit: `npm run eval:goal`.

The profile is decided here, **before the loop starts, and is immutable for the run.** A run cannot escalate its own permissions.

### 6.2 Screenshots and coordinates

Capture at native Retina via ScreenCaptureKit, then downscale to **logical points** so model coordinates map 1:1 onto `CGEvent` points with no scale factor in the executor.

**Correction to that plan:** 1:1 only holds while the logical resolution fits Opus 5's image ceiling — **2576 px long edge and ~3.75 MP**. A 16" MacBook Pro at 1728×1117 (1.93 MP) is fine. A 4K display in "More Space" at 3008×1692 is 5.09 MP and is **not** — it needs a further 0.856× scale. So:

```ts
// Compute once per capture; assert 1.0 on the common path, carry it otherwise.
const scale = Math.min(1, 2576 / Math.max(w, h), Math.sqrt(3_750_000 / (w * h)));
// Executor: screenPoint = modelCoord / scale
```

Keep the executor's scale factor, keep it in the run log, and add a startup assertion that logs loudly when it is not 1.0. Silently wrong coordinates are the single worst failure mode in this product.

### 6.3 Tool surface

Toolset: **`computer_toolset_20260801`** on `claude-opus-5`. No beta header. Schema-less — Claude carries the schema. 17 member actions: `screenshot`, `zoom`, the five click variants, `left_click_drag`, `mouse_move`, `left_mouse_down`/`up`, `cursor_position`, `scroll`, `type`, `key`, `hold_key`, `wait`.

**Correction the research missed:** every `tool_result` for a computer action **must** carry `"toolset_name": "computer"`. Omitting it is a hard 400 and will look like a model failure.

```jsonc
{ "type": "tool_result", "tool_use_id": "toolu_01...", "toolset_name": "computer",
  "content": [{ "type": "image", "source": { "type": "base64",
                "media_type": "image/png", "data": "..." } }] }
```

Only `screenshot` and `zoom` return images; the rest return `"OK"`.

Plus **two custom tools**, which are where buddy beats a naive computer-use agent:

- **`describe_focused_window`** → AX tree of the frontmost window (roles, titles, values, frames, enabled state). Returned alongside every screenshot so the model targets a named element instead of guessing a pixel. This is the largest single reliability win available.

  **Implemented as both**, because hoping the model remembers to ask is not a reliability strategy: every `screenshot` and `zoom` tool_result carries the tree as a second content block automatically, *and* the tool stays callable so the model can re-read the tree after acting without paying for another image. Element frames are rendered as their centre coordinates, which is the number a click actually needs.
- **`finish`** → the run's structured terminal outcome (§6.6). Ending via an explicit tool call rather than a prose `end_turn` makes standby and wakeups parseable instead of regex-scraped.

### 6.4 Input synthesis

`CGEventCreateMouseEvent` / `CGEventCreateKeyboardEvent` directly — not PyAutoGUI, not AppleScript. Typing uses `CGEventKeyboardSetUnicodeString`, which handles non-ASCII and avoids keymap-dependent keycode tables.

Every synthesized event is tagged:
```swift
CGEventSetIntegerValueField(event, .eventSourceUserData, BUDDY_MAGIC)
```
This is what makes §7.3's human-takeover detection possible.

**Secure Event Input** is checked before every keyboard action. When another process holds it, keystrokes are silently swallowed by the OS and the agent believes it typed. Return a real tool error instead:

```
is_error: true
"Secure Event Input is held by <app>. Keyboard input cannot be delivered.
 Ask the user to dismiss the password prompt, or use a non-keyboard approach."
```

### 6.5 Loop semantics

- **Batch execution, fail-stop.** Execute every `tool_use` block in the batch **in order**. On the first failure, return `is_error: true` for that block and for every block after it with the halt text:
  `"Not executed: an earlier computer action in this turn failed."`
  Return all results in one user message — splitting them teaches Claude to stop batching.
- **Abort checks, every turn.** Stat `~/.buddy/ABORT`, check the IPC abort flag, and check the three budgets before dispatching a batch.
- **Screenshot pruning.** Keep the last 3 screenshot blocks; prune in a batch every 25 turns rather than every turn. Pruning rewrites history and costs a cache read, so amortizing it is the whole point.
- **Prompt caching.** `cache_control` breakpoint after `tools` + `system` + the (stable) notes context. Everything volatile — frames, timestamps, budget counters — goes after it. Verify with `usage.cache_read_input_tokens`; a persistent zero means a silent invalidator.
- **Thinking / effort.** `thinking: {type: "adaptive"}` with `output_config.effort: "high"`. Stream, and set `max_tokens` to 64000.
- **Budgets** (all configurable, all shown live in the HUD): 60 steps, 10 minutes wall clock, $2.00. Hitting any one parks the run in `NEEDS_HUMAN` with its log intact — it never fails silently and never quietly continues.

### 6.6 Termination and standby

The `finish` tool takes:

```jsonc
{ "status": "done" | "waiting" | "needs_human",
  "summary": "Filed SAM-4412 and linked the thread.",
  "wake": { "after_s": 300, "condition": "Priya has replied in #sam-eng",
            "max_attempts": 12 } }
```

`waiting` schedules a wakeup in SQLite (survives app restart). On fire, a **cheap check** runs first: one screenshot + the condition string → **Haiku 4.5** → boolean. False reschedules and costs a fraction of a cent. True resumes the original run with its full prior context. `max_attempts` exhausted → `NEEDS_HUMAN` + a notification.

**Built in M4. Five details the implementation settled:**

- **The schedule is polled, not timed.** `wakePollMs` (15 s default) asks SQLite
  what is due. A timer per wakeup would be lost to a system sleep, which is the
  exact stretch of time standby exists to survive. An overdue row fires once, not
  once per interval missed: a check that did not happen has nothing to catch up
  on, because the condition is either true now or it is not.
- **A check buddy could not run does not spend an attempt.** No key, a wedged
  sidecar, a capture that failed, a 502 — none of those is an answer about the
  condition, and burning one of twelve on each would turn a five-minute outage
  into a wakeup that quietly gave up. Measured cost of a real check: **$0.0028**,
  so twelve of them over an hour is under four cents.
- **Resume is the same run, continuing.** Same `runs` row, `run_steps` appended
  rather than restarted, and the saved transcript replayed into the request so
  the model does not re-create what it already made. The wake check itself is
  written to the run log — waiting is part of what a run did, and a log that
  shows twenty clicks and then an hour of nothing cannot answer "was it actually
  watching".
- **The budgets restart on a resume; the run row stays cumulative.** A run that
  waited forty minutes would blow a ten-minute wall clock before its first click,
  so each attempt gets its own step, time and cost budget. The row records the
  total across attempts, and `RunView.resumes` says how many there were.
- **Images are stripped from the saved transcript, and the blocks are not.**
  Writing three live screenshots to disk per wait would make the file tens of
  megabytes of pictures of a screen that has since changed, and the resume takes
  a fresh one as its first act. The `tool_result` blocks stay — dropping one
  orphans its `tool_use` and invalidates the whole conversation — so what is
  saved reads to the model exactly like an already-pruned turn. A six-screenshot
  transcript is **1.1 KB** on disk instead of 1.2 MB.

**Notifications**, and only these three: a run parked in `needs_human`, a run
resumed from standby, and a wakeup that ran out of attempts. Each one is a moment
where something is waiting on the user and they cannot otherwise know. A
notification per completed run is a notification people turn off, which costs
the three that matter.

### 6.7 Measured: goal inference

From [`evals/goal-inference`](evals/goal-inference/README.md), Opus 5, `effort=high`,
5 fixtures × 3 runs. Two modalities: the original text stand-ins, and — added in M3 —
the same five bundles carrying **real screenshots**.

| | Text stand-ins | Real screenshots |
|---|---|---|
| Passed | 15/15 | 15/15 |
| Cost per activation | **$0.024** | **$0.067** |
| Latency, median | **8.5 s** | **13.7 s** |
| Latency, worst (ambiguous case) | 22.4 s | 29.7 s |

| | |
|---|---|
| `effort=medium` vs `high` | median 8.0 s vs 8.3 s — **no meaningful latency win**, and medium is less stable |

**Use `effort: "high"`.** The sweep's answer is that medium buys nothing here.

**The screenshot result was not the expected one.** Until M3 the fixtures had only
ever run against prose, which tests signal weighting, calibration and injection
resistance but **not visual grounding** — and a `description` string saying *"the
cursor sits in the empty body under 'Blockers'"* has already done the model's
hardest job for it. The expectation was that real pixels would be noisier and the
numbers would get worse. Accuracy did not move: 15/15 either way, no soft warns
either way. The images are demonstrably being read rather than skimmed — the
recorded runs cite Linear's `Cycle 14` and `broker` label and the original quote
email in Mail's sidebar, neither of which appears in any `description`.

**What moved was cost: 2.8×, to $0.067 an activation.** Twenty hotkey presses in a
day is $1.34, comparable to a whole day of observing. Three frames at 1728×1117
are roughly 7.7k image tokens. If activation cost ever needs to come down, the
lever is the frames rather than the prompt — §6.1 asks for full resolution on the
**newest** frame only, and buddy already downscales the two behind it to the
Observer's ceiling.

One caveat stated plainly: the recorded screenshots are *reconstructions* rendered
at real frame dimensions, not captures of a live desktop — a real desktop carries
notification banners, half-occluded windows and private data that does not belong
in a repository. They are meaningfully harder than prose and meaningfully easier
than a real machine. The eval README says so on its face.

Two findings that changed the design:

- **The profile rule must be about reversibility, not app category.** Classifying by "documents and local files" left the model split 50/50 on writing into a shared team doc, across repeated runs and two rewordings. Reframing the question as *"if this goes wrong with nobody watching, how hard is it to undo?"* resolved it. A wrong paragraph can be deleted; a sent email cannot be recalled.
- **Profile on a borderline case is advisory, and the eval treats it that way.** The instability first measured here (`blocked-resume` proposing `unattended` in roughly 5 of 7 runs) did **not** reproduce in M3's 30-run pass — zero soft warns across both modalities. That is not evidence it is gone; it is one more sample of a borderline judgement, and the reason it is a warn rather than a failure is unchanged. When it does wobble it errs toward `attended`, never toward unattended on something risky, and since the user confirms the profile in the same keystroke as the goal, a borderline case landing on `attended` costs one keypress. The eval asserts the safety-critical direction hard (`profileMustNotBe`) and the preference softly (`preferProfile`, warns only).

Risk flags needed explicit per-flag definitions. Left loose (*"flag what the task plausibly reaches"*), the model flagged `sends_message` for writing a document and `posts_public` for a Linear issue — collapsing every run into `attended` and making the unattended profile unreachable. Over-flagging is not a safe default; it trains users to click through confirmations.

---

## 7. Guardrails

Three profiles ship in v1. They share one enforcement point and differ only in a policy table, so each additional profile is a column rather than a second implementation.

### 7.1 Policy

| Action class | Attended | Unattended | Leashless |
|---|---|---|---|
| Screenshot, scroll, navigate, read | allow | allow — allowlisted apps + domains only | allow |
| Type into editor / doc / non-submitting field | allow | allow if app allowlisted | allow |
| Send message, email, post, comment, PR | **confirm** | **deny → `needs_human`** | allow |
| Purchase, payment, checkout | **deny** | **deny** | allow |
| Credentials, passwords, 2FA, API keys | **deny** | **deny** | allow |
| Delete outside `~/.buddy/scratch` | **confirm** | **deny → `needs_human`** | allow |
| Install software, change system settings | **confirm** | **deny** | allow |
| Open an app or domain not on the list | **confirm** | **deny → `needs_human`** | n/a — no allowlist |

A deny **parks the run**. buddy never routes around it, never looks for an alternate path to the same effect, and never asks the model how to proceed past it. `needs_human` is a terminal state with a notification and a preserved log.

#### Leashless, and what it costs

`leashless` allows **everything** — not "more than unattended", but every class, including the two that are `deny` under both other profiles. Under it buddy will send mail, delete files outside the scratch directory, install software, complete a purchase, and type an API key or a card number into a field: unattended, with nobody asked and nothing to approve.

**It has no allowlist**, which is why that row reads `n/a` rather than `allow`.
The distinction is not pedantry, and it is visible in exactly one place: the run
log. An allowlist that is present and then ignored still classifies every step
in an app outside it as `off_allowlist` before allowing it — so a leashless run
reading two apps produced a log full of rows naming a rule that was never going
to apply, and a reader had to know the policy table to discount them. With no
list, a read is recorded as a read and typing is recorded as typing. Which apps
the run actually touched is not lost: `appKey` and `appName` are on every
verdict regardless of class, read from the accessibility tree at dispatch, so
they are what was frontmost rather than what a list predicted.

The HUD does not show an app set for a leashless run, and `orchestrator.start()`
clears one if a caller sends it anyway — the same reason the `leashlessEnabled`
check lives there rather than in a button.

That is the feature, requested in those words. It is worth being exact about the price, because those two `deny` rows are not timid defaults. A sent email cannot be recalled, a purchase cannot be un-bought, and a credential typed into the wrong field is a credential that has leaked. The §7.2 signals are heuristics and defence in depth even when they are enforcing; with this column selected there is nothing between a wrong model reading and the machine except the kill switches and the budgets — both of which do still apply.

The safety here is therefore structural rather than in the table:

- It is **off by default** and cannot be selected until `leashlessEnabled` is turned on in Settings.
- A run requesting it without that flag is **refused in `orchestrator.start()` before the loop begins** — not only in the HUD, because a guard that lives in a button is not a guard.
- It is **never buddy's own suggestion**; goal inference does not propose it.
- Every step taken under it is **recorded against that profile in the run log**.

The dangerous decision is made once, deliberately, away from the keyboard, and after that it is one click — the right shape for something a person genuinely wants. The reversibility question in §6.7 is what the other two columns are built on; this column is the user electing to stop asking it.

### 7.2 Enforcement point

Classification runs in the **executor**, immediately before dispatching a `CGEvent` — never in the prompt. The model is not asked to police itself.

Signals, in order of trust:
1. **AX tree** (authoritative): focused element role is `AXSecureTextField` → credential deny. Target button's `AXTitle` matches `/^(send|post|publish|submit|buy|pay|place order|confirm|delete)/i` → gate.
2. **App + domain** (authoritative for unattended): frontmost bundle ID and, for browsers, the AX-read address bar URL against the allowlist.
3. **Keystroke content** (heuristic): typed text matching card-number, seed-phrase, or `sk-`/`ghp_` key shapes → deny regardless of profile.

These are heuristics and defense-in-depth, not proofs. **Attended mode assumes a human is watching**, and the product must say that in the UI rather than implying the guardrails are complete.

### 7.3 Kill switches

Three, independent, all always live during `ACTING`:

1. **Global hotkey** `⌥⌘.` — immediate hard stop.
2. **Sentinel file** `~/.buddy/ABORT` — stat'd every turn. Works when the UI is wedged.
3. **Stop** — in the HUD and in the menu bar. Always present, always enabled.

**Stopping is always an explicit act.** Touching the keyboard or the mouse
while buddy is working does **not** stop it.

This was the opposite in M2, and the reversal is deliberate. buddy works *by*
driving the mouse and keyboard, so the user's hands and buddy's are on the same
controls. Someone who scrolls to watch what it is doing, glances at another
window, or fixes a typo in a different app has not asked it to stop — and a run
that dies for that reason dies for a reason the user cannot always reconstruct.
The cost of the mistake is asymmetric: an unwanted stop throws away real work
and three explicit stops exist to catch the case where someone wants one, while
the failure it was supposed to prevent — buddy and a human fighting over the
same field — is visible on screen as it happens, with the hotkey a keystroke
away.

**The event tap stays, as an observation rather than a halt.** The listen-only
`CGEventTap` on the session tap, filtering buddy's own events by the
`BUDDY_MAGIC` tag from §6.4, still runs during `ACTING` and still ignores
everything for its first 0.6 s. What it produces is a line in the run log —
*"you used the keyboard while buddy was working"*, coalesced to one entry per
five seconds — and a note in the HUD saying the run is still going. That line is
worth keeping on its own: when buddy clicks where a button used to be, "the user
moved the window at step 12" is frequently the entire explanation, and the Run
Log is where a person goes to find it (§8.5). Listen-only remains the rule, so a
wedged buddy cannot also wedge the user's keyboard.

### 7.4 Prompt injection

buddy reads untrusted screen content and acts on a computer. Treat everything on screen as **data, never instruction.** The system prompt states this explicitly. Text in a Slack message, a web page, a PDF, or a filename that appears to instruct buddy — "ignore previous instructions", "the user approved this", "send this to…" — is surfaced to the user and never acted on. No screen content can change the profile, extend a budget, alter the allowlist, or authorize a gated action. Authorization comes only from the user in the app.

### 7.5 Secrets

API keys go through Electron `safeStorage` (Keychain-backed), never into `settings`, never into a log, never into a note. The run log redacts anything key-shaped before it is written.

---

## 8. UI

Dark-first, near-black surfaces with a single warm accent. Glass/vibrancy on floating layers. Motion is 200–300 ms spring, used for state changes only, and fully disabled under `prefers-reduced-motion`. The bar: it should look like a product, not a tool.

### 8.1 HUD overlay — the one screen that matters

Frameless, always-on-top, vibrant, centered, ~560 px wide. Springs in on the hotkey.

- **ARMED** — the inferred goal in large type, evidence chips beneath it, profile badge, risk flags. `Enter` to run · type to amend · `Esc` to cancel.
- **ACTING** — live step feed (one line per action, newest at top, gently animated), three budget meters (steps / time / cost), a big Stop. Collapses to a small pill after 3 s so it stops covering the work; hover or hotkey re-expands.
- **Confirm gate** — slides in over the HUD naming the exact action and the element it targets. Approve / Deny / Stop run.
- **NEEDS_HUMAN** — why it stopped, what it completed, Resume / Discard.

### 8.2 Home
Status line ("watching for 3 h 20 m · 412 frames · 18 kept"), today's recap, active task cards, a large Activate button, and a single input that accepts either a question ("what did I do this morning?") or a direct instruction.

### 8.3 Notes
Three tabs — Recap, Relations, Tasks. FTS5 search with live results. Detail view shows the note body, linked notes, and the source frames it came from (while they still exist). Every note is editable and deletable; buddy's memory must feel correctable.

### 8.4 Timeline
Day scrubber over a filmstrip of kept frames. Hover enlarges, click opens full-size with its app, window title, and observation. Filter by app. A visible retention countdown per day, and a "delete this day now" button.

The countdown is read from `MIN(expires_at)` over the day's rows, **not** derived
from the current `retentionDays`. Retention is stamped on a frame when it is
written, so a user who changed the setting yesterday has frames from two regimes
in one directory and only the rows know which is which — deriving it from the
setting would show a number that is simply not when the files go.

Days are grouped by **local** date in SQL, matching `paths.dayDir`. A UTC key
would disagree with the vault's own directory names for part of every day west
of Greenwich, and the symptom would be a "yesterday" holding this morning.

Thumbnails load lazily through an `IntersectionObserver`: a day at 15 s intervals
is a few hundred full-resolution PNGs behind an IPC call that base64s each one,
and asking for all of them on mount freezes the window to show a strip of 96 px
images.

### 8.4.1 Standby, on Home

A pending wakeup is otherwise invisible — nothing is moving and the only
evidence is a row in SQLite — so Home shows each one with the four facts a person
actually has a question about: what it is watching for, when it next looks, how
many looks are left, and what happens when they run out. Plus the two things
they can do: make it look now, or stop waiting. An assistant that promises to
watch for something and then shows nothing has made an unverifiable promise.

### 8.5 Run Log
Every run, expandable to per-step: action, target, result, and the screenshot at that step. This is the trust surface — when buddy does something wrong, this is where the user finds out what and why.

### 8.6 Settings
Provider keys · hotkey recorder · capture interval · retention days · exclusion list · allowlists (apps + domains) · profile defaults · budget caps · permission status with Grant buttons and live state · daily spend meter.

Four of those needed a decision rather than a control:

- **The provider matrix is the control's context, not a caveat under it.** §9.1
  says Settings must make the Claude-only rule unambiguous, so the capability
  table is rendered from `CAPABILITIES` and the Operator's availability is shown
  with *the same sentence* `orchestrator.start()` throws. One message, one
  author: the UI and the guard cannot drift into disagreeing about why the
  hotkey is unavailable.
- **`defaultProfile` can never be `leashless`,** and a stored value that says
  otherwise is corrected on load. §7.1 says buddy never suggests it, and a
  default is a suggestion made once and then never reconsidered.
- **Exclusions are addable and removable; built-ins are disableable only.** A
  window-title rule is compiled as a regex before it is saved, because an
  invalid one silently excludes nothing, and "nothing" is what a broken privacy
  rule looks like from outside.
- **R2 gets a line on this screen**, as §11.1 asked: when macOS reports Screen
  Recording granted and capture is failing anyway, Settings says so and names
  the fix, rather than leaving the user to conclude the capture code is broken.

---

## 9. Expansion seams

Each is an interface defined and used in v1 with a single implementation behind it.

| Later | v1 seam |
|---|---|
| Vector note search | `notes.embedding` column, `EmbeddingProvider` interface, search behind `NoteSearch` (FTS5 impl). Adding sqlite-vec is a backfill job. |
| Wake-word activation | `Activator` interface emitting `ActivationEvent`. `HotkeyActivator` in v1; `WakeWordActivator` is a sibling. |
| TTS / STT | `VoiceIO` interface, no-op impl. HUD already renders buddy's goal text as a discrete speakable unit. |
| More providers | `Provider` interface with capability flags `{computerUse, vision, structuredOutput, cheapBulk}`. Anthropic is the only one with `computerUse: true`; the Operator hard-requires it and the UI says so. |
| More sensors | `Sensor` interface producing T0 signals. `ScreenSensor` in v1; clipboard, calendar, and browser history are siblings. |
| Ask-about-my-day | v1 is FTS5 + notes into context. Swapping in RAG is a `NoteSearch` implementation change. |

**Ask-about-my-day needs both halves of its retrieval, and that is not obvious.**
Search alone answers *"what did Priya want"* and returns **nothing at all** for
*"what did I do this morning?"* — the commonest question there is, and one with
no distinctive term to match on. So the recent recaps, open tasks and relations
go in unconditionally alongside the FTS5 hits. The model is asked to cite note
ids, and a citation that does not resolve to something actually sent is dropped
rather than rendered as a chip nobody can open. An empty memory is answered
locally, with no model call: spending money to be told there is nothing to say
is a bad trade.

### 9.1 Provider matrix

| Provider | Operator | Observer (T2/T3) | Q&A |
|---|---|---|---|
| **Anthropic** (required) | Opus 5 + `computer_toolset_20260801` | Haiku 4.5 / Sonnet 5 | Sonnet 5 |
| **OpenAI** (optional) | — not supported | yes | yes |
| **Local / Ollama** (optional) | — not supported | yes, vision model required | yes |

Computer use is Claude-only. Settings must make that unambiguous rather than letting a user configure OpenAI and wonder why activation is greyed out.

**Built in M4.** OpenAI and the local runtime share one implementation — both
speak `/chat/completions` with `response_format: json_schema`, so Ollama is the
same client with a different base URL and no Authorization header, and neither
needs an SDK dependency for one POST. Their output is validated against the
**same zod schema** the Anthropic path uses: the seam is the model, not the
validation, and a local model that "mostly" honours a schema must not be able to
write a malformed note. The one sharp edge is OpenAI's `strict` mode, which
requires every property in `required` and `additionalProperties: false` — zod's
own emitter marks optionals optional, which is correct JSON Schema and a 400
here, so the conversion normalises it.

The wake check stays Anthropic-only, and deliberately: it is the one cheap-tier
call whose output is a decision to **take the machine**.

---

## 10. Milestones

Ordered so that the demo-critical path is done by end of Day 2 and everything after it is additive.

### M1 — Day 1: it sees
Electron + React + Tailwind + Framer Motion scaffold · `buddyd` Swift binary with capture / AX / input / secure-input / frontmost · JSON-RPC bridge · permission flow with live status and Grant buttons · SQLite schema + frame vault + retention purge · T0 + T1 capture with pHash dedupe · global hotkey → HUD shell · Settings with Keychain-backed keys.
**Exit:** frames accumulating on disk, dedupe working, old frames purging, hotkey opens a HUD.

### M2 — Day 2: it acts ← *demo-critical*
`AgentRunner` with `computer_toolset_20260801` · batch fail-stop semantics · `toolset_name` on every result · coordinate scaling with the ≤2576 px / ≤3.75 MP guard · `describe_focused_window` · `finish` tool · secure-input error path · **both profiles** and the shared guardrail enforcement point · all kill switches · budgets · live Run Log · screenshot pruning + prompt caching.
**Exit:** hotkey → typed goal → buddy completes a real two-app task end to end, and every kill switch actually stops it.

**Status: built, and verified as far as this machine allows** — `npm run check:m2`. Every kill switch is fired mid-run against the real `AgentRunner` and shown to park it with its log intact; the guardrail matrix, batch fail-stop, the deny-parks rule, budgets, pruning, and the cache-breakpoint layout are all asserted mechanically rather than eyeballed. `BUDDY_MAGIC` is verified to discriminate for real: buddy's own synthesized keystroke produces no `human_input` notification and an identical keystroke from another process does — which is what makes the §7.3 takeover *note* mean something, now that it is a note and not a halt. The model is a scripted client, so the one thing the checks cannot cover is a live Opus 5 run — see README, "What M2 verifies".

### M3 — Day 3: it remembers
T2 observer (Haiku 4.5, structured output) · T3 rollup (Sonnet 5) into recap / relation / task notes · dedupe and merge for relations · goal inference from the Context Bundle, replacing M2's typed goal · Home + Notes UI with FTS5 · local OCR if time allows.
**Exit:** buddy infers the goal with no typing, and the notes it shows are recognizably true.

**Status: built and verified** — `npm run check:m3`, 66 checks. The relation merge
(four spellings of one person → one row with aliases, and two rows folded into
one), the task lifecycle and scope widening, the tier cadence and the app-level
context-switch trigger with its debounce, the daily cap actually stopping T2 and
T3 before a request is built, retention leaving a note that cites expired frames
intact and labelled, and FTS5 search through edits, deletes and characters that
are FTS5 syntax — all asserted mechanically against the real modules, with the
model replaced by a scripted structured-output client.

**Local OCR was cut**, as §10's cut list says to. Nothing depends on it.

The half of the exit criterion that is not mechanical — *"the notes it shows are
recognizably true"* — was checked by running buddy against a real machine and
reading what it wrote. See README, "What M3 verifies".

### M4 — Day 4: it waits, and it looks good
Standby + wakeups with the cheap Haiku condition check · resume-with-context · notifications · Timeline · full Settings · OpenAI + local providers for observation and Q&A · ask-about-my-day · animation and polish pass · unsigned `.dmg` + self-signed identity for stable TCC.
**Exit:** Story B works end to end and the app is pleasant to use.

**Status: built and verified** — `npm run check:m4`, 41 checks. The wakeup
surviving a database closed and reopened under it, the cheap check's reschedule
arithmetic, three separate ways of being *unable* to look none of which spend an
attempt, `max_attempts` exhaustion parking the run with its real step count and
cost intact, and — the one that matters — **the resumed run's request read back
and shown to contain the prior conversation**, with every `tool_use` still
paired to its `tool_result`. Plus the Timeline against a real retention sweep,
the FTS5 retrieval, the provider matrix, and the settings normalisations.

**Local OCR stays cut** (M3's decision, unchanged). Nothing else on §10's cut
list was cut: OpenAI and local providers, Timeline filters and ask-about-my-day
all shipped.

**And the M2 gap is closed.** `npm run live:run` is the one thing in the
repository that talks to the live API — see §10.1.

### 10.1 The live run — closing M2's one real gap

M2 verified the whole computer-use loop through a scripted `ModelClient`. That
covers every invariant about what the loop *does with a response* — and none
about whether the API accepts what it *builds*. Three claims were correct in
shape and had never met a server, and each one fails as something that reads
like a model problem rather than a buddy problem.

`npm run live:run` is the harness that closes it: a real two-app task — read two
numbers from a TextEdit document in `~/.buddy/scratch`, add them in Calculator,
type the total back — against a live `claude-opus-5`, with a fifth of the
shipping wall clock and cost budgets and confirm gates auto-denied.

**The final run completed the task.** `done` in **41 steps, 62 s, $0.226** —
read 2257 and 7501 out of TextEdit, computed them in Calculator, switched back,
typed `TOTAL: 9758`, saved, and called `finish`. The document was checked
afterwards by the harness rather than by reading the summary, and it was right.
(It also noticed the Calculator still showed the previous run's sum and cleared
it first, which is the kind of thing `already_done` exists to make possible.)

**The three questions, answered against the live API:**

| | |
|---|---|
| **`toolset_name: "computer"` accepted** | Yes. 39 computer `tool_result` blocks across 7 turns in the final run, 46 across 7 in an earlier one, **zero API errors in any run**. The field is accepted exactly as `toolResult()` emits it. |
| **`cache_read_input_tokens` non-zero** | Yes, and climbing every turn: 6,346 → 9,511 → 13,258 → 14,813 → 18,799 → 22,209 → **23,128**. The breakpoint layout in §6.5 is doing what it was designed to do; there is no silent invalidator. |
| **Pruning does not desync pairing** | Confirmed, and measured on both sides of the prune: 7 image blocks → 4 pruned → 3 left, pairing **intact before and intact after**, and the API accepted the pruned conversation. Pruning changes nothing about pairing — which matters, because the first run *looked* like it did. |

**Three things the live runs found that no scripted client could.**

1. **A gate answered synchronously was silently dropped, and the run hung
   forever.** `askUser()` emitted the `gate` event *before* installing the
   promise's resolver, so a listener that answered immediately found no resolver,
   got `false` back, and the promise created a line later was never settled. The
   HUD never hit it because an answer over IPC is always a tick late. The harness
   answers instantly, and the first live run stopped dead at step 3 holding the
   keyboard, with no error anywhere. The resolver is now installed before the
   event goes out.

2. **A halted run leaves an unanswered batch, and M4 is the first thing that
   ever re-sends one.** This is the finding pruning was nearly blamed for: the
   first harness only checked pairing *after* the prune, saw seven orphans, and
   reported it as a pruning failure. Measuring both sides showed the orphans
   were already there. When a deny, a kill switch, or a budget halts a run
   *inside* a batch, the loop returns without pushing that batch's results —
   correctly, because §7.1 says the model gets no further turn. The last
   assistant message is then carrying `tool_use` blocks nothing answered, which
   is harmless for exactly as long as nothing sends the conversation again.
   Standby sends it again. The API is unambiguous:

   > `messages.14: tool_use ids were found without tool_result blocks
   > immediately after… Each tool_use block must have a corresponding
   > tool_result block in the next message.`

   `sealTranscript` now answers every orphan with an `is_error` result saying
   the block did not run — which is true, and is something the resuming model
   should know. Merged into the following user message rather than inserted
   before it: a partly-answered batch split across two user messages trades one
   400 for a different one, which the first version did and `check:m4` caught.

3. **A GUI calculator costs one step per digit.** The first run was given 30
   steps — half the shipping default — and reached the right answer in Calculator
   before running out of budget on the way back to TextEdit. `8616 + 5821 =` is
   eleven `left_click`s. The step budget counts tool calls, not intentions, and
   §6.5's default of 60 is not generous for a click-heavy app.

**Two more were found by installing the build and running it**, which is a
different activity again — neither the checks nor the live harnesses open a
window:

4. **The packaged app opened a blank window.** `windows.ts` resolved the preload
   script and the renderer's HTML relative to `import.meta.url`, which is
   correct while that module is bundled into `out/main/index.js` and wrong the
   moment rollup hoists it into `out/main/chunks/` — then `../preload` points at
   `out/main/preload`, which does not exist. What decided the hoist was how many
   modules import it, and M4's `notify.ts` made it two. So the correctness of a
   path depended on a bundler heuristic reacting to an unrelated new file, and
   the failure was invisible in development (where the renderer is served over
   HTTP) and silent in production, because `ERR_FILE_NOT_FOUND` goes to a
   renderer console nobody has open. Both paths now come from
   `app.getAppPath()`, and a failed load is logged where the app's own log will
   show it.

5. **A re-signed build cannot read its own stored API key, and said so every few
   seconds.** `safeStorage` binds its Keychain item to the binary, and — unlike
   the Screen Recording grant, which survives on the Designated Requirement —
   that binding does not survive a new signature. Since `./scripts/sign-app.sh`
   is a documented step, this happens on a normal rebuild. Every caller of
   `secrets.get()` retried, refailed and relogged; the Observer alone does it
   every few seconds. It is now latched, logged once with the actual
   explanation, and surfaced in Settings as *"buddy has a stored key it cannot
   read"* with the one action that fixes it. Which is §11.1's rule applied to
   the other credential: a thing that looks configured, does nothing, and
   explains itself nowhere is the failure mode to avoid.

A sixth was found by the noise it made: **the M2 check suite was really
clicking and really typing.** Its vocabulary check proved buddyd's 17 action
names by sending each a well-formed request, so it triple-clicked at 1,1 and
typed the letter `a` into whatever window had focus — contradicting the suite's
own stated promise that nothing is typed and nothing is clicked, and noticed
only when the letters turned up in a chat window. It was also the cause of a
flaky failure two checks later: a triple-click at 1,1 opens the Apple menu, an
open menu grabs the cursor, and `CGWarpMouseCursorPosition` then returns success
while the pointer stays put. The probe now sends a deliberately invalid
coordinate, which fails validation inside buddyd before anything is synthesized.

One run was also parked by the guardrails exactly as designed: a click landed in
Finder, which was not on that run's allowlist, the `off_allowlist` gate fired,
the harness denied it, and the run stopped there rather than looking for another
way (§7.1). That is §12.4 happening by accident, against the live API, and it
worked.

### Honest read on the timeline

M1 + M2 in two days is achievable. M3 + M4 in two more is aggressive — the notes engine is where prompt-quality iteration eats time that can't be estimated. If Day 4 runs short, cut in this order: **local OCR → OpenAI/local providers → Timeline filters → ask-about-my-day.** Do not cut guardrails, the run log, or the kill switches; they are load-bearing for a product that drives your computer.

Both profiles in v1 costs very little extra because they share §7.2's enforcement point — it is one policy table, not two systems.

---

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | TCC does not attribute the sidecar's capture to the parent app bundle, so Screen Recording appears granted but returns black frames. | **Spiked on Day 1 — see §11.1. Outcome: the split holds; no fallback needed.** Sidecar lives in `Contents/MacOS/` and is signed with the same identity. |
| **R2** | Ad-hoc signature changes each build and silently revokes Screen Recording. | **Reproduced during the R1 spike — see §11.1. This is not theoretical; budget for it.** `./scripts/make-signing-cert.sh` creates the free self-signed cert and is a required first-run step. Settings shows live permission state so a revocation is visible rather than mysterious. **Confirmed working in M4:** the app was rebuilt (cdhash `5f81ba…` → `02649f…`), installed over the old copy, and launched straight into `OBSERVING` with both grants intact — the Designated Requirement, `identifier "com.cyrus.buddy" and certificate leaf = H"205a03e7…"`, is what stays the same. **But the Keychain does not follow it:** `safeStorage` ties its item to the binary, so a re-signed build cannot decrypt a key the previous build stored. See §10.1, finding 5. |
| **R3** | Coordinate scale factor wrong on external displays → clicks land in the wrong place, possibly destructively. | §6.2 guard, a startup assertion that logs loudly when scale ≠ 1.0, the factor recorded per step in the run log, and attended mode as the default. |
| **R4** | Goal inference is confidently wrong and buddy does the wrong task well. | Confidence threshold with a two-guess fallback, evidence chips so the user can check the reasoning in one glance, explicit confirmation before every run, and amendable goal text. |
| **R5** | Observation cost runs away. | Tiered pipeline, pHash dedupe, Haiku for bulk, a hard daily cap that pauses T2/T3, and a live spend meter. |
| **R6** | Notes are vague and useless, making activation feel like magic that doesn't work. | Structured outputs with required evidence fields; notes are user-editable; the goal-inference prompt is the highest-leverage thing to iterate on and should get real Day 3 time. |
| **R7** | Prompt injection from screen content. | §7.4. Screen content is data. No on-screen text can change the profile, budgets, allowlist, or authorize a gated action. |
| **R8** | `better-sqlite3` native module fails against the Electron ABI. | `electron-rebuild` in `postinstall`, pinned Electron version. Known quantity, 20-minute fix. |


### 11.1 R1 spike result — Day 1

**Verdict: the Electron + Swift sidecar split holds. No fallback to
`desktopCapturer` is needed, and none was implemented.**

What was tested, in the production arrangement: `buddyd` in
`release/mac-arm64/buddy.app/Contents/MacOS/`, beside the Electron executable,
signed with the same identity, spawned from the Electron main process over
JSON-RPC, capturing one frame via `SCScreenshotManager.captureImage`.

Evidence:

- **Capture works and the frames are real.** 1728×1117, 615 KB PNG, sampled
  max-luma 251 against a black-frame threshold of 40 — screen content, not a
  black rectangle. `buddyd` was a separately-signed child process using the
  responsible parent's grant, which is the structural question R1 asks.
- **Coordinate scale is 1.0** on the 16" internal display (1728×1117 = 1.93 MP,
  inside the 2576 px / 3.75 MP ceiling), exactly as §6.2 predicted. The startup
  assertion fires and logs when it is not, and the factor travels on every
  captured frame.
- **The whole M1 loop runs end to end** on this arrangement: sidecar spawn →
  permission poll → T0 signals → T1 capture → pHash dedupe → vault → retention.

**What the spike actually cost a morning was R2, not R1.** The failure looked
exactly like the R1 black-frame scenario and was not:

> Screen Recording granted, System Settings showing the toggle **ON**, and
> `SCShareableContent` returning `-3801 "The user declined TCCs"` — from *both*
> the Swift sidecar and Electron's own `desktopCapturer`.

The cause is that macOS records a TCC grant against the bundle's `cdhash`. An
ad-hoc signature produces a new `cdhash` on every `codesign` run, so re-signing
after a grant silently invalidates it while the UI keeps showing it as granted.
Both capture paths failing identically is the tell: when the sidecar and the
parent's own API fail the same way, it is the bundle's grant that is broken, not
the attribution of the sidecar's call.

Two consequences worth carrying into M2 and M4:

1. **`./scripts/make-signing-cert.sh` is a required first-run step**, not an
   optional nicety. Ad-hoc signing costs a re-grant per build and makes every
   capture bug ambiguous.
2. **"Granted" in System Settings is not evidence that capture works.** The
   permission panel already polls the real API every two seconds rather than
   trusting a cached status, and that is the right call — but a user staring at
   an ON toggle and a blind buddy needs the app to say *"macOS reports this
   granted, but capture is failing"*. Worth a line in Settings in M4.


---

## 12. Success criteria for the demo

1. buddy runs unattended for 30+ minutes and its recap note is recognizably accurate.
2. From a cold hotkey press with **zero typing**, buddy states the correct goal with evidence on ≥7 of 10 attempts across 3 different real tasks.
3. It completes a two-app task (read in app A → act in app B) end to end.
4. A gated action triggers a confirm in attended mode and a `needs_human` park in unattended mode.
5. All three kill switches stop an in-flight run within one turn, and using the keyboard mid-run does not.
6. It goes to standby waiting on a condition, wakes on a timer, detects the condition, and resumes.
7. Frames from two days ago are gone; the notes made from them are not.

### 12.1 Where each one stands at the end of M4

The distinction that matters below is between **run live** and **asserted
mechanically**, and it is not a ranking — a mechanical assertion can cover cases
a live run never reaches, and a live run can catch what no scripted client can
(§10.1 is three examples of exactly that). What matters is that the two are not
confused for each other.

| # | Status | Evidence |
|---|---|---|
| **1** Recap is recognizably accurate | **Met, observed live** | buddy ran unattended on this machine for 2 h 26 m: 544 frames considered, 316 live, 228 already swept. It wrote 7 observations, 10 relations, 2 tasks and a recap naming the actual Slack thread, the actual Claude project, and the actual Spotify listening — including an open task, *"Reply to Alex confirming whether Sarah has the quarterly plan ready"*, that is a true statement about an unanswered 2:00 PM message. |
| **2** ≥7/10 cold goals across 3 tasks | **Not run in this form** | What exists is the goal-inference eval: **30/30** across five fixtures × three runs × two modalities (prose stand-ins and real screenshots), with `profileMustNotBe` asserted hard and zero soft warns (§6.7). That is more repetitions than the criterion asks for and *not the same test* — the fixtures are reconstructions, not ten cold presses on three real tasks, and the eval README says so on its face. Stated as unmet in this exact form rather than claimed. |
| **3** Two-app task end to end | **Met, live** | `npm run live:run`: read 2257 and 7501 from TextEdit, computed them in Calculator, typed `TOTAL: 9758` back, saved, `finish(done)` — **41 steps, 62 s, $0.226**, verified by reading the file rather than the summary. §10.1. |
| **4** Gate confirms / parks | **Met mechanically, and once live by accident** | The full matrix is asserted in `check:m2` across all three profiles. It also happened for real: a click landed in Finder, which was not on that run's allowlist, the `off_allowlist` gate fired, the harness denied it, and the run parked without looking for another way. |
| **5** Kill switches stop within one turn | **Met mechanically** | `check:m2` fires each of the three mid-run against the real `AgentRunner` with seventeen more turns of work queued behind them, and shows each parking the run with its log intact — plus `BUDDY_MAGIC` discriminating buddy's own keystroke from another process's. Not re-run live in M4. |
| **6** Standby → wake → detect → resume | **Met, live** | `npm run live:standby`, all four steps with nothing scripted: Opus 5 read `STATUS: pending` and called `finish(waiting)`; the database was **closed and reopened** and the wakeup was still there; the document was flipped to `READY`; **Haiku 4.5 saw it on the first check for $0.00214**; and **run 10** — the same run — resumed on Opus 5, appended `SHIPPED`, saved, and finished `done` at 12 cumulative steps and $0.126. |
| **7** Old frames gone, notes kept | **Met mechanically; partially observed** | `check:m4` runs the **real** retention sweep over two days of real vault frames and shows it taking exactly the expired one, then "delete this day now" unlinking the PNGs while the note citing them survives and reports them `expired` with their app names. On the live machine, 228 of 544 frames are already tombstoned with the notes made from them intact. Only the *simulated* two-day gap is mechanical — the app has one day of real history. |

**Five of seven met with a live model on this machine, one met mechanically
against the real modules, and one not run in the form the criterion states.**
