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

### 4.1 The three note types

| Type | Answers | Scope | Written by |
|---|---|---|---|
| **Recap** | "What have I been doing?" | session / day / week | Rollup, hourly + on session end |
| **Relation** | "Who and what do I work with?" | permanent, deduped | Extractor, incremental |
| **Task** | "What am I working on right now?" | session / day / week, with status | Extractor + rollup |

A **session** is a contiguous run of activity ending after 10 minutes idle or a display sleep.

Tasks carry `status ∈ open | blocked | waiting | done` and are the primary input to goal inference. A task that goes `blocked` or `waiting` is exactly what Story B resumes.

---

## 5. The Observer

Continuous full-fidelity capture sent to a model is unaffordable and unnecessary. Four tiers, each an order of magnitude cheaper than the one above it.

| Tier | Cadence | Cost | Does |
|---|---|---|---|
| **T0** signals | 2 s | free | Frontmost app, window title, idle time, display changes. Detects context switches. |
| **T1** frames | 15 s (configurable) | free | Screenshot → pHash. If pHash distance < 8 **and** app unchanged, discard and extend the current segment. Otherwise persist. Typical keep rate 20–35%. |
| **T2** observe | every 3 min, or immediately on context switch | ~$0.01 | 3–6 most-changed new frames + the T0 event log → **Haiku 4.5**, structured output → one `observation` row. |
| **T3** rollup | hourly + session end + midnight | ~$0.05 | Observations → recap notes; extract and merge relation + task notes. **Sonnet 5**. |

**Budget:** ~$1.50–2.50 per 8-hour day. Surfaced live in Settings as a running daily total with a hard cap that pauses T2/T3 when hit.

**Tier sizing gotcha:** Haiku 4.5 caps images at 1568 px long edge / ~1.15 MP. Downscale observer frames to **1366×768** (1.05 MP). Operator frames go to Opus 5 and use a different ceiling — §6.2.

**OCR:** macOS `VNRecognizeTextRequest` runs locally in `buddyd` on kept frames. Free, no network, and makes FTS5 search cover screen text, not just note prose. Ships in M3 if time allows; nothing depends on it.

### 5.1 Retention

- **Frames:** `expires_at = ts + retentionDays` (default 1, range 1–7). Purge sweep on launch and hourly; unlinks the file and tombstones the row.
- **Notes, observations, runs:** kept indefinitely. Exportable as JSON. Deletable per-item and in bulk from the UI.
- **Run-step screenshots** are the one exception to the daily purge, and they have to be: the Run Log is the trust surface (§8.5), and a log whose pictures vanish overnight cannot answer "what did buddy click". They live with the run under `runs/<id>/`, not in the frame vault, so the sweep never sees them — and deleting a run deletes them with it. The Run Log says so on its face rather than leaving the user to infer that one kind of screenshot outlives the other.
- **Exclusion list:** bundle IDs and window-title regexes that are never captured. Ships pre-populated with 1Password, Keychain Access, and Passwords. Private/incognito browser windows are excluded by title heuristic. When the AX tree reports a focused `AXSecureTextField`, T1 skips the frame entirely.

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

### 6.7 Measured: goal inference

From [`evals/goal-inference`](evals/goal-inference/README.md), Opus 5, 5 fixtures × 2–3 runs:

| | |
|---|---|
| Cost per activation | **~$0.024** (~$0.12 per 5-fixture suite) |
| Latency, median | **8.6 s** |
| Latency, worst (ambiguous case) | **22 s** |
| `effort=medium` vs `high` | median 8.0 s vs 8.3 s — **no meaningful latency win**, and medium is less stable |

**Use `effort: "high"`.** The sweep's answer is that medium buys nothing here.

Two findings that changed the design:

- **The profile rule must be about reversibility, not app category.** Classifying by "documents and local files" left the model split 50/50 on writing into a shared team doc, across repeated runs and two rewordings. Reframing the question as *"if this goes wrong with nobody watching, how hard is it to undo?"* resolved it. A wrong paragraph can be deleted; a sent email cannot be recalled.
- **Profile on a borderline case is advisory, and the eval treats it that way.** The residual instability (`blocked-resume` proposes `unattended` in roughly 5 of 7 runs) always errs toward `attended`, never toward unattended on something risky. Since the user confirms the profile in the same keystroke as the goal, a borderline case landing on `attended` costs one keypress. The eval asserts the safety-critical direction hard (`profileMustNotBe`) and the preference softly (`preferProfile`, warns only).

Risk flags needed explicit per-flag definitions. Left loose (*"flag what the task plausibly reaches"*), the model flagged `sends_message` for writing a document and `posts_public` for a Linear issue — collapsing every run into `attended` and making the unattended profile unreachable. Over-flagging is not a safe default; it trains users to click through confirmations.

---

## 7. Guardrails

Both profiles ship in v1. They share one enforcement point and differ only in a policy table, so the second profile is a data change, not a second implementation.

### 7.1 Policy

| Action class | Attended | Unattended |
|---|---|---|
| Screenshot, scroll, navigate, read | allow | allow — allowlisted apps + domains only |
| Type into editor / doc / non-submitting field | allow | allow if app allowlisted |
| Send message, email, post, comment, PR | **confirm** | **deny → `needs_human`** |
| Purchase, payment, checkout | **deny** | **deny** |
| Credentials, passwords, 2FA, API keys | **deny** | **deny** |
| Delete outside `~/.buddy/scratch` | **confirm** | **deny → `needs_human`** |
| Install software, change system settings | **confirm** | **deny** |
| Open an app or domain not on the list | **confirm** | **deny → `needs_human`** |

A deny **parks the run**. buddy never routes around it, never looks for an alternate path to the same effect, and never asks the model how to proceed past it. `needs_human` is a terminal state with a notification and a preserved log.

### 7.2 Enforcement point

Classification runs in the **executor**, immediately before dispatching a `CGEvent` — never in the prompt. The model is not asked to police itself.

Signals, in order of trust:
1. **AX tree** (authoritative): focused element role is `AXSecureTextField` → credential deny. Target button's `AXTitle` matches `/^(send|post|publish|submit|buy|pay|place order|confirm|delete)/i` → gate.
2. **App + domain** (authoritative for unattended): frontmost bundle ID and, for browsers, the AX-read address bar URL against the allowlist.
3. **Keystroke content** (heuristic): typed text matching card-number, seed-phrase, or `sk-`/`ghp_` key shapes → deny regardless of profile.

These are heuristics and defense-in-depth, not proofs. **Attended mode assumes a human is watching**, and the product must say that in the UI rather than implying the guardrails are complete.

### 7.3 Kill switches

Four, independent, all always live during `ACTING`:

1. **Global hotkey** `⌥⌘.` — immediate hard stop.
2. **Sentinel file** `~/.buddy/ABORT` — stat'd every turn. Works when the UI is wedged.
3. **Human takeover** — a real keystroke or click during `ACTING` pauses the loop instantly. Buddy's own events are filtered by the `BUDDY_MAGIC` tag from §6.4, so it never trips on itself. Implemented as a **listen-only** `CGEventTap` on the session tap, watching key-down, the three mouse-downs, and scroll — listen-only so a wedged buddy cannot also wedge the user's keyboard. It ignores everything for its first 0.6 s, or the Return that confirmed the run reads as the user taking over from it.
4. **Menu bar Stop** — always present, always enabled.

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

### 8.5 Run Log
Every run, expandable to per-step: action, target, result, and the screenshot at that step. This is the trust surface — when buddy does something wrong, this is where the user finds out what and why.

### 8.6 Settings
Provider keys · hotkey recorder · capture interval · retention days · exclusion list · allowlists (apps + domains) · profile defaults · budget caps · permission status with Grant buttons and live state · daily spend meter.

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

### 9.1 Provider matrix

| Provider | Operator | Observer (T2/T3) | Q&A |
|---|---|---|---|
| **Anthropic** (required) | Opus 5 + `computer_toolset_20260801` | Haiku 4.5 / Sonnet 5 | Sonnet 5 |
| **OpenAI** (optional) | — not supported | yes | yes |
| **Local / Ollama** (optional) | — not supported | yes, vision model required | yes |

Computer use is Claude-only. Settings must make that unambiguous rather than letting a user configure OpenAI and wonder why activation is greyed out.

---

## 10. Milestones

Ordered so that the demo-critical path is done by end of Day 2 and everything after it is additive.

### M1 — Day 1: it sees
Electron + React + Tailwind + Framer Motion scaffold · `buddyd` Swift binary with capture / AX / input / secure-input / frontmost · JSON-RPC bridge · permission flow with live status and Grant buttons · SQLite schema + frame vault + retention purge · T0 + T1 capture with pHash dedupe · global hotkey → HUD shell · Settings with Keychain-backed keys.
**Exit:** frames accumulating on disk, dedupe working, old frames purging, hotkey opens a HUD.

### M2 — Day 2: it acts ← *demo-critical*
`AgentRunner` with `computer_toolset_20260801` · batch fail-stop semantics · `toolset_name` on every result · coordinate scaling with the ≤2576 px / ≤3.75 MP guard · `describe_focused_window` · `finish` tool · secure-input error path · **both profiles** and the shared guardrail enforcement point · all four kill switches · budgets · live Run Log · screenshot pruning + prompt caching.
**Exit:** hotkey → typed goal → buddy completes a real two-app task end to end, and every kill switch actually stops it.

**Status: built, and verified as far as this machine allows** — `npm run check:m2`. All four kill switches are fired mid-run against the real `AgentRunner` and shown to park it with its log intact; the guardrail matrix, batch fail-stop, the deny-parks rule, budgets, pruning, and the cache-breakpoint layout are all asserted mechanically rather than eyeballed. `BUDDY_MAGIC` is verified to discriminate for real: buddy's own synthesized keystroke does not trip the takeover switch and an identical keystroke from another process does. The model is a scripted client, so the one thing the checks cannot cover is a live Opus 5 run — see README, "What M2 verifies".

### M3 — Day 3: it remembers
T2 observer (Haiku 4.5, structured output) · T3 rollup (Sonnet 5) into recap / relation / task notes · dedupe and merge for relations · goal inference from the Context Bundle, replacing M2's typed goal · Home + Notes UI with FTS5 · local OCR if time allows.
**Exit:** buddy infers the goal with no typing, and the notes it shows are recognizably true.

### M4 — Day 4: it waits, and it looks good
Standby + wakeups with the cheap Haiku condition check · resume-with-context · notifications · Timeline · full Settings · OpenAI + local providers for observation and Q&A · ask-about-my-day · animation and polish pass · unsigned `.dmg` + self-signed identity for stable TCC.
**Exit:** Story B works end to end and the app is pleasant to use.

### Honest read on the timeline

M1 + M2 in two days is achievable. M3 + M4 in two more is aggressive — the notes engine is where prompt-quality iteration eats time that can't be estimated. If Day 4 runs short, cut in this order: **local OCR → OpenAI/local providers → Timeline filters → ask-about-my-day.** Do not cut guardrails, the run log, or the kill switches; they are load-bearing for a product that drives your computer.

Both profiles in v1 costs very little extra because they share §7.2's enforcement point — it is one policy table, not two systems.

---

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | TCC does not attribute the sidecar's capture to the parent app bundle, so Screen Recording appears granted but returns black frames. | **Spiked on Day 1 — see §11.1. Outcome: the split holds; no fallback needed.** Sidecar lives in `Contents/MacOS/` and is signed with the same identity. |
| **R2** | Ad-hoc signature changes each build and silently revokes Screen Recording. | **Reproduced during the R1 spike — see §11.1. This is not theoretical; budget for it.** `./scripts/make-signing-cert.sh` creates the free self-signed cert and is a required first-run step. Settings shows live permission state so a revocation is visible rather than mysterious. |
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
5. All four kill switches stop an in-flight run within one turn.
6. It goes to standby waiting on a condition, wakes on a timer, detects the condition, and resumes.
7. Frames from two days ago are gone; the notes made from them are not.
