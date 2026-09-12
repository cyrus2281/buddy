# goal-inference eval

Exercises the highest-leverage prompt in buddy: the one that turns "user hit the hotkey"
into an actionable goal with no typing.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm install
npm run eval:goal
```

Five fixtures, each testing one failure mode:

| Fixture | Failure it guards against |
|---|---|
| `01-clean-resume` | Goals that name a project instead of the next concrete move |
| `02-competing-tasks` | Picking the most *recent* task over the most *active* one |
| `03-nothing-resumable` | Inventing a task when the user was just browsing |
| `04-injection` | Acting on on-screen text that impersonates an instruction |
| `05-blocked-resume` | Re-asking a question that was already answered on screen |

## Limitation worth knowing

Fixtures carry `description` strings instead of real screenshots, so they exercise
signal weighting, calibration, and injection resistance — **not visual grounding**,
which is where the real production risk lives. Once M1 capture works, record real
bundles into `fixtures/` with `imageBase64` populated; `renderBundle` already handles
both and the assertions are unchanged.

## Hard vs soft assertions

`check()` failures fail the suite; `warn()` findings only print. The split matters:
profile on a genuinely borderline case (writing into a shared team doc) is a *proposal*
the user confirms in one keystroke, and it lands on `attended` when the model hesitates
— the safe direction. So `profileMustNotBe` is asserted hard (injection must never
propose `unattended`) while `preferProfile` only warns. Don't promote a warn to a fail
without a product reason; you'll end up tuning the prompt against your own preference.

## Knobs

```bash
npm run eval:goal -- --fixture 04        # one fixture
npm run eval:goal -- --effort medium     # effort sweep: is high worth the latency?
npm run eval:goal -- --runs 3            # variance across repeated runs
npm run eval:goal -- --json              # full structured output per run
```

Each run writes to `runs/` (gitignored), including per-call latency, so you can diff
prompt revisions.

Measured on Opus 5: **~$0.024 and 8.6 s median per activation**, up to 22 s on ambiguous
cases. `effort=medium` saves no meaningful latency and is less stable — stay on `high`.

## Iterating

Edit `prompts/goal-inference.system.md`, re-run, compare. Prefer tightening the
judgment criteria over adding rules — Opus 5 degrades under over-prescriptive
prompts, and a decision tree here will generalize worse than a stated principle.
