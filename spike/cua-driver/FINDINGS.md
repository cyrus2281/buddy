# cua-driver as the Operator's backend — spike findings

Branch `cyrus/cua-driver-spike`. Machine: macOS 15.7.9 (24G830), Apple silicon.

## Phase 0 — the blockers

**Verdict: no blocker.** cua-driver installs cleanly, its tool schemas are
captured, and spawned from an Electron main process it captures real frames and
lands background clicks — under its *own* TCC identity, not buddy's.

### 1. Install

| | |
|---|---|
| Command (from `libs/cua-driver/scripts/install.sh`, trycua/cua) | `CUA_DRIVER_RS_VERSION=0.34.0 CUA_DRIVER_RS_TELEMETRY_ENABLED=0 /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"` |
| Version | `cua-driver 0.34.0` (tag `cua-driver-rs-v0.34.0`, 2026-10-05, the latest stable-channel tag) |
| App bundle | `/Applications/CuaDriver.app`, bundle id `com.trycua.driver` |
| CLI | `~/.local/bin/cua-driver` → `/Applications/CuaDriver.app/Contents/MacOS/cua-driver` |
| Signature | Developer ID Application: Cua AI, Inc. (`YCK386LBJ7`); DR = identifier + team, so it is stable across cua-driver updates |
| Verification | SHA-256 against the release `SHA256SUMS`; the Sigstore bundle was not checked (no `cosign` on this machine) |

**Telemetry is on by default and the install-time variable does not turn it
off.** `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` at install only suppresses the
installer's own event; the binary still reported `enabled (source: default)`.
It is now off persistently (`cua-driver telemetry disable` →
`disabled (source: persisted)`). buddy also sets the variable on every spawn,
so a fresh machine never sends anything from buddy's runs either way.

### 2. Exact schemas

`tools.json` is MCP `tools/list` from `cua-driver mcp` 0.34.0, via
`probe.mjs list` (plain newline-delimited JSON-RPC, legacy `initialize` at
protocol `2025-06-18`). **58 tools**, 323 KB — the descriptions are long and
carry most of the usage contract. Everything in Phase 1 is generated from this
file (`npm run cua:schemas`), not from the docs.

Shapes the docs do not state, all observed live:

- `get_window_state` returns each element twice over: `frame` in **screen
  points** and `screenshot_frame` in **pixels of the PNG it returned** (so with
  `max_image_dimension` it is already in the downscaled space). Pixel actions
  take the second; the first is what a screen-point hit test needs.
- Screenshots are native Retina by default (Calculator: 198×350 pt window →
  396×700 PNG, `screenshot_scale: 2`). `max_image_dimension` caps the long edge
  and the driver reverses its own downscale on pixel actions.
- Elements carry `role`, `label`, `value`, `actions`, `enabled`, `frame`,
  `screenshot_frame`, `element_token` — **but no `subrole`.** The Rust `AXNode`
  (`platform-macos/src/ax/tree.rs`) never reads it. A password field is
  `AXTextField` + subrole `AXSecureTextField`, so cua-driver's snapshot alone
  cannot see one. This decides where the guardrail's facts come from (Phase 1).
- Refusals come in two shapes: `structuredContent.code`
  (`screenshot_context_missing`, `tool_invocation_failed`) and
  `structuredContent.refusal.code` with `status: "refused"`
  (`stale_element_token`). Both have `isError: true`.
- A pixel click on a background window is resolved by cua-driver's own AX hit
  test when it can be ("PX hit-test pressed the background element via AX").
- Input results report `effect: "unverifiable"` for an AXPress even when it
  worked (Calculator showed the digit). `unverifiable` is not failure; only
  `suspected_noop` is a signal to escalate.

### 3. TCC attribution

Run with `open -n -W -a node_modules/electron/dist/Electron.app --args
spike/cua-driver/tcc-electron.cjs proxy|direct`. Launching through
LaunchServices makes Electron.app its own responsible process — the arrangement
buddy.app has in production — rather than inheriting the terminal's grants.
`tcc-electron.cjs` spawns cua-driver the way `supervisor.ts` spawns buddyd
(`child_process.spawn`, stdio pipes) and drives Calculator.

| | `cua-driver mcp` (default) | `cua-driver mcp --direct` |
|---|---|---|
| Who owns the runtime | the CuaDriver.app daemon; the child is a stdio proxy to its socket | the child process itself |
| How the daemon starts | the proxy runs `open -n -g -a CuaDriver --args serve` when none is listening | — |
| `check_permissions.source.attribution` | `driver-daemon`, `com.trycua.driver`, `responsible_ppid: 1` | `host`, `responsible_ppid` = Electron.app's pid |
| Accessibility / Screen Recording | ✅ / ✅ | ❌ / ❌ (dev Electron.app has no grants) |
| `get_window_state` screenshot | 396×700, max luma 246, mean 68 — real | refused: *"The user declined TCCs"*; tree empty (`ax_window_unresolved`) |
| Background AX click (`element_token`) | landed (display `7`) | not reachable |
| Background pixel click (`x,y` from `screenshot_frame`) | landed (`77` → `777`) | not reachable |

**macOS attributes the grants to `/Applications/CuaDriver.app`
(`com.trycua.driver`), not to buddy**, because the process that touches TCC is
the daemon LaunchServices started, which is its own responsible process. Who
spawned the proxy does not matter.

**Rebuilding buddy does not revoke them.** buddy's cdhash, its self-signed
certificate (R2), and whether it runs from `electron` in dev or from
`/Applications/buddy.app` are all irrelevant to a grant held by
`com.trycua.driver`. Updating cua-driver also keeps them, because its DR is
identifier + Developer ID team, not a cdhash. The grants were already present
when the spike started — evidently from an earlier install, which is the same
property seen from the other side.

`--direct` (and `serve --embedded`) is the alternative: one set of grants,
buddy's. It makes cua-driver subject to R2 — every ad-hoc rebuild revokes — and
in dev it runs on the grants of whatever launched Electron. **The Phase 1
client uses the default proxy mode.** Its costs, stated once:

- The user grants Accessibility and Screen Recording **twice** (buddy, then
  CuaDriver). Settings must say so and point at `cua-driver permissions grant`.
- The daemon is shared and outlives buddy. Another agent on the machine using
  cua-driver talks to the same daemon (sessions are separate). Killing buddy's
  proxy child ends buddy's MCP session, not the daemon.

Also seen: `launch_app` on a cold Calculator took 8–15 s and returned an empty
`windows` array the first time; `list_windows {pid}` a moment later found it.
The executor treats an empty `windows` as "look again", not as failure.

## Phase 1 — Claude over plain tools via cua-driver

**Shipped behind `operatorBackend: 'toolset' | 'cua'`, default `toolset`.** The
toolset path is untouched: its client setup in `orchestrator.start()` is the
same code, `buildTools()` is unchanged, and `check:m1`–`check:m4` pass.

| Piece | Where |
|---|---|
| Setting + UI | `Settings.operatorBackend`, `operatorProvider` (`shared/types.ts`, `settings.ts`); the choice sits above the provider matrix in Settings |
| Process | `src/main/cua/driver.ts` — `CuaDriver`, spawned lazily on the first cua run |
| Tool surface | `buildCuaTools()` in `agent/tools.ts`, from `src/main/cua/schemas.json`, generated from `tools.json` by `npm run cua:schemas` |
| Executor | `src/main/cua/executor.ts` — `CuaExecutor`, same `ExecOutcome` as `Executor` |
| Loop | `runner.ts`, keyed on `executor.kind`; no second loop |
| Prompt | `cuaHowTo()` + `buildCuaOpening()` in `agent/prompt.ts` |
| Checks | `npm run check:m5` (fake MCP server) — 25/25 |
| Live | `npm run live:cua -- --config smoke` (no model) and the Phase 3 configs |

**Minimal JSON-RPC, not `@modelcontextprotocol/sdk`.** Three methods over
newline-delimited JSON, the framing buddyd already speaks. The SDK's stdio
transport would own the child process, and owning it is the point: the kill
switch cancels in-flight calls (`notifications/cancelled` + reject), and a
restart must be visible because it ends the MCP session and every element
token with it (`CuaDriver.generation`). Same trade as `OpenAICompatibleClient`.

**Tool surface.** 13 cua tools + `finish`, fixed order, `cache_control` on
`finish`. Taken out of every schema, with the reason in `scripts/cua-schemas.mjs`:
`scope`/`target` (desktop-scoped input with no pid to classify), `from_zoom`/
`capture_id` (second coordinate spaces), `max_image_dimension` and friends
(buddy owns the ceiling), `session`, and `launch_app.name` (allowlist is bundle
ids). `pid` is made required on every input tool. The executor also drops any
property outside the curated schema before dispatch, so a hallucinated
`scope: "desktop"` never reaches cua-driver. Cost of the surface: **38 KB ≈
10k tokens** of schema per request, cached; the toolset is schema-less.

### Guardrails: facts from buddyd, not cua-driver

Every call is classified by the existing `classify()` before it is dispatched;
a deny is never dispatched, a gate waits for the user, exactly as `Executor`.

**buddyd is the source**, via `ax_target {pid, x, y}` — a new form that asks
the *target app's own* hit test (`AXUIElementCopyElementAtPosition` on the app
element) instead of the system-wide one. Reasons, in order:

1. **cua-driver cannot see a password field.** Its snapshot has no subrole;
   `AXSecureTextField` is a subrole. buddyd reads it.
2. **The system-wide hit test is wrong in the background.** Measured: for
   Calculator's "7" under Claude's window, the system-wide test returned
   Claude's `AXScrollArea`; the app-scoped one returned Calculator's `7`.
3. buddyd already reads the browser URL from the web area (not the address
   bar), and its readings are what both other executors classify against.

cua-driver's own snapshot element is classified too and the **stricter**
verdict wins — it can add a gate, never remove one. If buddyd cannot answer,
the call **fails closed** (not dispatched): no AX signal means no way to see a
password field, in a window the person may not be looking at.

How each tool is classified (`CuaExecutor.verdictFor`): `get_window_state` as a
hands-off look (allowlist-gated), `list_*` as screenshots, clicks by their
button, `type_text` as `type` (+ a click when it carries `x,y`), `press_key`
and `hotkey` as **both** `key` (Return in Slack sends, ⌘⌫ deletes) **and**
`type` (the `sk-`/`ghp_`/card/seed-phrase content rules), `launch_app` as
hands-off `open`. Keys and text aimed at an element (token or `x,y`) are
checked against *that* element's secure-field flag; otherwise against the
focused element of the target pid. The allowlist reads the target pid's bundle
id — the background app, not the frontmost (check: TextEdit behind Slack,
TextEdit allowed, Slack `off_allowlist`).

Residual risk, unchanged from the toolset: content rules see one call at a
time, so a card number typed one `press_key` per digit is not caught.

### Coordinates and images

One translation, and it is not on the dispatch path. The model's pixels go to
cua-driver unchanged — they are pixels of the image cua-driver produced, and it
reverses its own downscale. buddy never resizes. `CuaExecutor.toScreen`
(window pixel → screen point) exists only so the guardrail can ask buddyd what
is at the point. `from_zoom` is not offered, so there is no second space.

The PRD §6.2 ceiling is passed as `max_image_dimension`, computed per window
from its bounds: `min(2576, √(3.75 MP · long/short))`. Live: a 1198×1033 pt VS
Code window came back 2332×1607 (3.75 MP, 1.50 px/pt); Calculator 396×700
(native 2×). Frames are written into the run directory (`.png`, or `.jpg` for
`zoom`), and the Run Log reads them by extension.

**cua-driver sometimes omits the screenshot.** Across ~10 live snapshots, one
large window came back with no image and one Calculator snapshot at 90×160.
cua-driver documents this (`px_frame_mismatch` / `px_capture_unavailable`
omit a frame it cannot prove). The result then says so and the model works
from the tree; it is worth watching in Phase 3.

### Kill switches and the event tap

Hotkey, `~/.buddy/ABORT` and Stop are unchanged and converge on `fire()`.
New: `runner.stop()` also calls `CuaExecutor.cancelInFlight()`, which sends
`notifications/cancelled` and rejects the pending call, so a long `type_text`
does not hold the run (check: halted 6 ms after the hotkey during a 4 s call,
nothing after it dispatched). What cua-driver had already posted to the app is
not taken back. The sentinel is polled between blocks, as before.

**BUDDY_MAGIC.** Measured with buddyd's tap armed: cua-driver's background
click and `press_key` produced **no** tap events; a `delivery_mode:
"foreground"` key produced one untagged `human_input`. So for cua runs the tap
cannot tell buddy's foreground input from a person's, and background input is
invisible to it. The runner treats cua like hands-off — the person is expected
to keep working, input is counted, not narrated — and discounts the 2.5 s after
any foreground dispatch. The HUD shows a "working in the background through
cua-driver" step instead of the takeover note.

**Ghost cursor: not drawn** on the cua backend. Its input goes to a window that
is often behind the person's, and a pointer gliding over their editor to
preview a click in a hidden Calculator would point at the wrong place.

### Runner and provider gating

The runner keys everything on `executor.kind`: the tool surface, the opening
(`get_window_state` of the frontmost window that is not buddy's own — buddy's
HUD and island share its pid and are excluded), the resume blocks, the pruned
placeholder text, and `toolset_name`, which a cua result **never** carries —
not even when a `tool_use` arrives decorated with one (check). cua's `zoom`,
`scroll`, `double_click` and `right_click` share names with toolset members, so
"is this a toolset member" is now backend-aware rather than a name lookup.

`CAPABILITIES` gains `functionTools`; `canOperate(provider, backend)` is
`computerUse` for the toolset and `functionTools && vision` for cua.
`operatorAvailability()` and `orchestrator.start()` share
`operatorUnavailableReason()`: the toolset still says Claude-only in the same
sentence as before; cua says which of binary / key / endpoint is missing.
cua-driver is started and its grants checked **before** a run row exists, so a
missing grant is a sentence at the hotkey, not a run that parks on step one.

### Browser tools

Not in this spike, and they would **earn a place only with their own guardrail
adapter**. `get_browser_state` + `browser_click`/`browser_type`/
`browser_navigate` act on DOM refs over CDP after `browser_prepare` (an
isolated profile, or `--grant existing-profile` for the person's own). Two
things make them attractive — web content is where AX is weakest (`type_text`
there is `unverifiable` by design) and `browser_navigate` gives an exact URL
for the domain allowlist — and one thing blocks them: buddyd's AX hit test
cannot classify a DOM ref, so the "Send"/"Pay" button rule would need the
element text from cua-driver's own semantic snapshot, which is a second,
unreviewed source of guardrail facts. Attaching to the person's logged-in
profile is also exactly the reach that §7 is about.

## Phase 2 — non-Claude Operators

- `OpenAIChatModelClient` (`agent/openai-client.ts`) is a `ModelClient`: the
  transcript stays Anthropic-shaped and is translated per call. Image tool
  results become a `tool` message plus a following user message with
  `image_url` parts (the Hermes shape); thinking and `cache_control` are
  dropped; OpenAI's `cached_tokens` become `cache_read_input_tokens`. The
  toolset is refused rather than dropped.
- `operatorPricer()` (`agent/budget.ts`): OpenAI list prices; **an unknown id
  is metered at Opus 5, never $0**; a local runtime is $0 and says the step and
  time budgets are what bound it. Every Operator turn, on either backend, goes
  on the daily spend meter (`SpendTier 'operator'`).
- OpenAI and Local are Operator-capable only with `operatorBackend: 'cua'`
  (`canOperate`), chosen in Settings → Operator provider.

**Found in passing, and fixed:** no Operator run ever reached the daily spend
meter — `SpendTier 'operator'` existed, Settings labelled it "runs", PRD §5 says
the Operator "spends past" the cap, and nothing recorded it. `Operator.build()`
now passes `onSpend` for every backend. The cap still never stops a run (only
T2/T3 consult `allow()`); what changes is that a run's cost now counts toward
the day's total, so a large run can pause observation for the rest of the day.
Pinned by a new `check:m4` check (51/51).

## Phase 3 — measurements (in progress)

Harness: `npm run live:cua -- --config <name> --runs N` (`src/main/live-cua.ts`).
Same task as `live:run` (two numbers from a TextEdit scratch document, summed in
Calculator, typed after `TOTAL:`), attended profile, gates auto-denied,
$1 / 60 steps / 5 min per run. Rows in `results.jsonl`; each cua row says which
prompt version it ran (`cua-v1`, `cua-v2`). Keys come from the environment.

### Blocked configs

| Config | State |
|---|---|
| (a) Claude + toolset via api.anthropic.com | **not run.** In the Claude app's terminal pane buddyd has Accessibility but not Screen Recording (TCC attributes it to the hosting app), so the opening capture is impossible. The reference point is the measured `live:run` (PRD §10.1): done, 41 steps, 62 s, $0.226. |
| (b) Claude + cua via api.anthropic.com | **not measured.** All 3 runs stopped at the first call: 400 "credit balance is too low" on the shell's key. The harness now stops a batch when the first call fails. |
| (e) local vision model | **not run.** No Ollama / LM Studio on this machine. |

### The gateway question — answered

`gateway-probe`, `claude-opus-4-6` at `lite-llm.mymaas.net`, one request each:

| Tools sent | Result |
|---|---|
| `computer_toolset_20260801` | **400** — `tools.0: Input tag 'computer_toolset_20260801' found using 'type' does not match any of the expected tags: 'bash_20250124', 'custom', …` |
| the 14 cua function tools | **accepted**, 4.1 s; 10,758 tokens of tool schema written to cache |

The rejection is not the one first reported (`name is not accepted on a toolset
entry`): whatever this gateway routes `claude-opus-4-6` to does not know the
toolset type at all.

Again with **`claude-opus-5-5`**, which also exercises the OpenAI adapter
through the gateway's own `/v1/chat/completions`:

| Route | Result |
|---|---|
| Messages + toolset | **400** — `tools.0.computer_toolset_20260801: name is not accepted on a toolset entry …` — **the reported failure, reproduced** |
| Messages + cua function tools | accepted, 1.8 s, $0.073 — 14,463 tokens of tool schema written to cache (Opus 5.5's tokenizer counts more than 4.6's 10,758) |
| `/v1/chat/completions` + cua tools (`OpenAIChatModelClient`) | accepted, 16.5 s, $0.058 — **uncached**: all 14,438 prompt tokens billed in full, every turn |

So: the toolset cannot cross this gateway for either model, for two different
reasons; plain function tools cross it on both routes. The gateway lists 63
models, among them `azure-gpt-5.5`, `gpt-6-*` and `gemini-3.x` — the non-Claude
Operator can be measured through it without another key. Live runs are
LiteLLM-only by the user's decision, so (b) and the direct-OpenAI (d) are not
run; (d) becomes a gateway model over `cua-gateway-chat`.

### (c) Claude + cua via the gateway, prompt `cua-v1` — 0/3

| Run | Steps | Wall | Cost | Ended |
|---|---|---|---|---|
| 1 | 18 | 157 s | $1.01 | cost cap, after a ⌘Z loop; its document window vanished from WindowServer |
| 2 | 31 | 176 s | $1.01 | **stopped with `~/.buddy/ABORT`** mid ⌘Z loop — the kill switch, live, halted within the step |
| 3 | 32 | 167 s | $1.21 | cost cap, total typed in the wrong place |

81 model turns, **0 API errors**: the plumbing works through the gateway.
Guardrail verdicts: all `allow` (`read`, `type_editor`); no gates, no denies —
the task touches nothing gated. The failures are the backend's and the prompt's:

1. **Background clicks do not move a text cursor.** Every run clicked TextEdit's
   text by pixel in the background (cua-driver: "the hardware pointer was not
   moved"), then `type_text` on the text area's token inserted at the *old*
   caret — reported `effect: confirmed`, because the text did go in. The
   toolset never meets this: its click is a real click.
2. **v1's "re-snapshot after acting" was taken literally.** Runs 2 and 3
   snapshotted after every Calculator key — one `get_window_state` per digit,
   about doubling the steps. Tokens only go stale on the next snapshot, not on
   acting.
3. **⌘Z loops.** Unable to see what went wrong (it had also capped its own
   snapshots with `max_elements: 5`), the model undid repeatedly, escalating to
   `delivery_mode: "foreground"`. During one foreground ⌘Z, cua-driver reported
   *"Action opened new window(s): Slack ('workflow-designer-demo.mp4')"*.
   Coincidence or a keystroke landing in the wrong app, it cannot be told apart
   from here — and that ambiguity is itself the finding: **foreground delivery
   is real HID input, and the guardrail classified it against TextEdit**.
4. **Cost ≈ 4–5× the toolset's.** ~$0.03–0.04 per turn: the 10.7k-token tool
   surface, TextEdit snapshots of 12k+ characters (the tree, not the document),
   and repeated cache misses through the gateway (turns with `cacheRead: 0`
   re-writing ~18–23k tokens at 1.25×). `claude-opus-4-6` has no entry in
   buddy's price table, so it is metered at Opus 5 rates — by design.
5. A filtered snapshot (`query`) left out the element the model then targeted;
   buddy refused (it classifies only elements it has seen). Correct, and the
   refusal now says why.

Also seen, from the no-model smoke run: Calculator's backspace key is an
`AXButton` titled **"Delete"**, which `GATED_BUTTON` gates as `delete`. A false
positive, and not new — the toolset path reads the same title.

**Prompt `cua-v2`** (`CUA_PROMPT_VERSION`) answers 1–3: batch from one
snapshot, move the cursor with keys (or a foreground click) before typing and
read the value back, one ⌘Z at a time.

### (c) again, prompt `cua-v2` — 0/3

| Run | Steps | Wall | Cost | Ended |
|---|---|---|---|---|
| 1 | 27 | 173 s | $1.05 | cost cap; `TOTAL:` empty |
| 2 | 26 | 162 s | $1.20 | cost cap; `TOTAL:` empty |
| 3 | 22 | 161 s | $1.05 | cost cap; `TOTAL:` empty |

v2 changed the behaviour and not the outcome:

- **No more snapshot-per-digit.** All 11 Calculator keys went in without a
  snapshot between them, and every run computed the right sum. But the model
  still made **one tool call per turn** — it never batched — so 11 keys were
  11 turns, each re-reading ~24k cached tokens.
- **It moved the cursor with keys, as told — and the document defeated it.**
  `press_key cmd+down` with the text area's token goes to the very end, which is
  *after* the trailing newline below `TOTAL:`, so the total landed on an empty
  line. The model saw that in the next snapshot, undid it once (as told), and
  spent the rest of its budget on `cmd+left`/`cmd+right` variations. A real
  click — the toolset's — puts the caret at the end of the `TOTAL:` line in
  one step.
- **Background keys are not always background.** Two `press_key` calls with an
  element token came back *"Action caused a different app to become frontmost"*
  — focusing the element brought TextEdit forward.

Across all six gateway runs: 156 model turns, 0 API errors, **0/6 correct**,
$6.55 — about **$0.042 per step against the toolset's $0.0055** (§10.1's
41 steps for $0.226). Per turn the cua backend re-reads the 10.7k-token tool
surface plus snapshot trees (TextEdit's runs to 12k+ characters even with no
picture), and the gateway misses the cache often enough to re-write ~18–20k
tokens at 1.25× several times a run.

### (c) with `claude-opus-5-5`, prompt `cua-v2` — 0/3

| Run | Steps / turns | Wall | Cost | Ended |
|---|---|---|---|---|
| 1 | 24 / 15 | 300 s | $0.37 | time budget (5 min) |
| 2 | 28 / 14 | 317 s | $0.27 | time budget |
| 3 | 0 / 0 | 30 s | $0 | `cua-driver did not answer tools/call within 30s` on the opening call |

- **Opus 5.5 batches.** Ten Calculator keys in one turn, so 14–15 turns per run
  instead of 22–32, and **$0.27–0.37 a run instead of ~$1** (fewer turns, and
  $4/$20 with $0.20 cache reads). Turns are slow, ~20 s each at `effort: high`
  through the gateway, so the five-minute clock is now what runs out.
- **Fail-stop worked on a real failure.** One AXPress returned AX error -25205;
  the other nine keys in that batch were reported not executed, and the model
  re-snapshotted and redid them.
- **The same wall in TextEdit.** `hotkey cmd+down` on the text area's token,
  `type_text`, a snapshot showing the total on the line *below* `TOTAL:`, then
  background ⌫ ×4 (`unverifiable`), a foreground ⌫, a foreground double-click —
  and the clock. Run 2 ended with no line starting `TOTAL:` at all.
- Run 3's opening `list_windows`/`get_window_state` got no answer in 30 s; the
  daemon was healthy afterwards. A hung AX read (TextEdit mid-close from the run
  before) is the likely cause; cua-driver bounds its own walk, not the whole
  call.

**Nine gateway runs, two models, two prompts: Calculator by element token works
every time; putting text at an exact place in a TextEdit document never has.**
The toolset does that with one real click. cua-driver's background route has no
equivalent — a background click does not move a text cursor, keys move it by
whole lines and documents, and the foreground fallbacks are real HID input
that the guardrail cannot attribute.
