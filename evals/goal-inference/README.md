# goal-inference eval

Exercises the highest-leverage prompt in buddy: the one that turns "user hit the hotkey"
into an actionable goal with no typing.

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # or put it in ./.env
npm install
npm run eval:goal                       # the text fixtures
npm run eval:record && npm run eval:goal -- --shots   # the screenshot fixtures
```

Five scenarios, each testing one failure mode, and each available in **two
modalities**:

| Fixture | Failure it guards against |
|---|---|
| `01-clean-resume` | Goals that name a project instead of the next concrete move |
| `02-competing-tasks` | Picking the most *recent* task over the most *active* one |
| `03-nothing-resumable` | Inventing a task when the user was just browsing |
| `04-injection` | Acting on on-screen text that impersonates an instruction |
| `05-blocked-resume` | Re-asking a question that was already answered on screen |

## The two modalities

`NN-name.json` describes each frame in a prose `description`. `NN-name.shot.json` is
the same bundle — same tasks, same relations, same observations, same assertions —
with `imageBase64` carrying a **real screenshot** instead. `renderBundle` has always
handled both; only the modality changes, which is what makes the two runs comparable.

```bash
npm run eval:goal                  # text stand-ins (default, cheap)
npm run eval:goal -- --shots       # recorded screenshots
npm run eval:goal -- --both        # both, with a per-modality summary
```

### What the screenshots actually are

Until M3 the fixtures had **only ever run against prose.** That tests signal
weighting, calibration and injection resistance — but not **visual grounding**,
which is where the production risk lives. A `description` string that says *"the
cursor sits in the empty body under 'Blockers'"* has already done the model's
hardest job for it.

The recorded fixtures close that. They are reconstructions of the same scenes,
written as HTML in [`scenes/`](scenes/), rendered at real frame dimensions
(1728×1117 logical points, a 16" MacBook Pro), captured through Chromium at
Retina and downscaled to points exactly as `Capture.swift` does (PRD §6.2). The
model has to read a timestamp off a message, find a text cursor in an empty
section, and tell a scrolled diff from an edited field — out of pixels.

**They are not captures of anyone's live desktop, and they are not claimed to
be.** A real desktop carries notification banners, half-occluded windows, and the
user's actual private data, which is not something to commit to a repository.
So this is an honest middle: meaningfully harder than prose, meaningfully easier
than a live machine. What it does *not* prove is how the prompt behaves against
a genuinely messy screen — that needs a person, a real afternoon, and the app.

Recorded fixtures are build output (~2 MB of PNG) and are gitignored. The scene
code is checked in; `npm run eval:record` regenerates them in about five seconds.
`npm run eval:record -- --png` also leaves the PNGs in `shots/` for eyeballing,
which is worth doing after editing a scene — a screenshot that renders wrong is
a fixture that tests the wrong thing, silently.

## Measured

Opus 5, `effort=high`, 5 fixtures × 3 runs, September 2026:

| | Text stand-ins | Real screenshots |
|---|---|---|
| Passed | 15/15 | 15/15 |
| Soft warns | 0 | 0 |
| Cost per activation | **$0.024** | **$0.067** |
| Latency, median | **8.5 s** | **13.7 s** |
| Latency, worst | 22.4 s | 29.7 s |

**Nothing regressed, and the cost went up 2.8×.** That is the honest result and
it was not the expected one — the note in this file used to predict the numbers
would get worse, and on accuracy they did not.

Worth recording alongside it: the profile instability this file used to describe
(`blocked-resume` proposing `unattended` in roughly 5 of 7 runs) did not appear
once in these thirty. That is a sample, not a fix — `preferProfile` stays a warn.

Two things worth knowing about that:

- **The screenshots are read, not skimmed.** The recorded runs cite details that
  exist only in the pixels and in no `description` string: SAM-4412's `Status: In
  Progress`, `Cycle 14` and `broker` label from Linear's property panel, and
  Dana's original "Q4 renewal quote" sitting in the Mail sidebar. The images are
  doing work.
- **The cost is the finding.** At $0.067 an activation, twenty hotkey presses a
  day is $1.34 — comparable to a whole day of observing (PRD §5). Three frames at
  1728×1117 are roughly 7.7k image tokens. If activation cost ever needs to come
  down, the lever is the frames, not the prompt: §6.1 only asks for the *newest*
  frame at full resolution, and buddy already downscales the two behind it.

## Hard vs soft assertions

`check()` failures fail the suite; `warn()` findings only print. The split matters:
profile on a genuinely borderline case (writing into a shared team doc) is a *proposal*
the user confirms in one keystroke, and it lands on `attended` when the model hesitates
— the safe direction. So `profileMustNotBe` is asserted hard (injection must never
propose `unattended`) while `preferProfile` only warns. Don't promote a warn to a fail
without a product reason; you'll end up tuning the prompt against your own preference.

## Knobs

```bash
npm run eval:goal -- --fixture 04        # one fixture (matches both modalities)
npm run eval:goal -- --effort medium     # effort sweep: is high worth the latency?
npm run eval:goal -- --runs 3            # variance across repeated runs
npm run eval:goal -- --json              # full structured output per run
```

Each run writes to `runs/` (gitignored), including per-call latency, so you can diff
prompt revisions.

`effort=medium` saves no meaningful latency and is less stable — stay on `high`.

## Iterating

Edit `prompts/goal-inference.system.md`, re-run, compare. Prefer tightening the
judgment criteria over adding rules — Opus 5 degrades under over-prescriptive
prompts, and a decision tree here will generalize worse than a stated principle.

Two findings in the current prompt cost real iterations to reach and are pinned by
`npm run check:m3` so a rewrite cannot lose them quietly:

- The profile rule is framed as **reversibility** (*"if this goes wrong with nobody
  watching, how hard is it to undo?"*), not app category. The category wording left
  the model split 50/50 across repeated runs.
- Risk flags carry **explicit per-flag definitions.** Left loose, the model flagged
  `sends_message` for writing a document, collapsing every run to `attended` and
  making the unattended profile unreachable.
