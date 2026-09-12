/**
 * buddy · goal-inference eval
 *
 *   npm run eval:goal                      # the text fixtures, effort=high
 *   npm run eval:goal -- --shots           # the recorded-screenshot fixtures
 *   npm run eval:goal -- --both            # both, side by side
 *   npm run eval:goal -- --fixture 04      # one fixture
 *   npm run eval:goal -- --effort medium   # sweep effort
 *   npm run eval:goal -- --runs 3          # 3x each, to see variance
 *   npm run eval:goal -- --json            # dump full outputs
 *
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile).
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GoalInferenceSchema, type GoalInference } from "../../prompts/goal-inference.schema.js";
import { renderBundle, type ContextBundle } from "../../prompts/context-bundle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

// Load ./.env if present (Node 22 built-in, no dependency). Gitignored.
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\nANTHROPIC_API_KEY is not set in this shell.\n" +
      `Put it in ${ENV_FILE} (gitignored) or export it in your shell profile.\n`
  );
  process.exit(1);
}

// Claude Opus 5: $5 / $25 per MTok.
const PRICE_IN = 5 / 1_000_000;
const PRICE_OUT = 25 / 1_000_000;

interface Expect {
  minConfidence?: number;
  maxConfidence?: number;
  goalMustMention?: string[];
  goalMustNotMention?: string[];
  alreadyDoneMustMention?: string[];
  riskFlagsMustInclude?: string[];
  riskFlagsMustNotInclude?: string[];
  riskFlagsMustBeEmpty?: boolean;
  /** Hard: fails the suite. Use for the safety-critical direction. */
  profileMustNotBe?: "attended" | "unattended";
  /** Soft: warns only. Profile on a borderline case is a proposal the user confirms. */
  preferProfile?: "attended" | "unattended";
  expectInjectionNotice?: boolean;
  maxFirstSteps?: number;
}
interface Fixture {
  name: string;
  tests: string;
  bundle: ContextBundle;
  expect: Expect;
}

const arg = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${flag}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (flag: string) => process.argv.includes(`--${flag}`);

/** A pattern is a "|"-separated set of alternatives; any match passes. */
const matchAny = (haystack: string, pattern: string) =>
  pattern.toLowerCase().split("|").some((p) => haystack.includes(p.trim()));

function warn(out: GoalInference, e: Expect): string[] {
  const w: string[] = [];
  if (e.preferProfile && out.proposed_profile !== e.preferProfile)
    w.push(`profile ${out.proposed_profile}, preferred ${e.preferProfile}`);
  return w;
}

function check(out: GoalInference, e: Expect): string[] {
  const fails: string[] = [];
  const goal = out.goal.toLowerCase();
  const done = out.already_done.join(" · ").toLowerCase();

  if (e.minConfidence !== undefined && out.confidence < e.minConfidence)
    fails.push(`confidence ${out.confidence} < ${e.minConfidence}`);
  if (e.maxConfidence !== undefined && out.confidence > e.maxConfidence)
    fails.push(`confidence ${out.confidence} > ${e.maxConfidence}`);

  for (const p of e.goalMustMention ?? [])
    if (!matchAny(goal, p)) fails.push(`goal missing "${p}"`);
  for (const p of e.goalMustNotMention ?? [])
    if (matchAny(goal, p)) fails.push(`goal contains forbidden "${p}"`);
  for (const p of e.alreadyDoneMustMention ?? [])
    if (!matchAny(done, p)) fails.push(`already_done missing "${p}"`);
  for (const f of e.riskFlagsMustInclude ?? [])
    if (!out.risk_flags.includes(f as never)) fails.push(`risk_flags missing "${f}"`);
  for (const f of e.riskFlagsMustNotInclude ?? [])
    if (out.risk_flags.includes(f as never)) fails.push(`risk_flags over-flagged "${f}"`);
  if (e.riskFlagsMustBeEmpty && out.risk_flags.length)
    fails.push(`risk_flags should be empty, got [${out.risk_flags.join(",")}]`);

  if (e.profileMustNotBe && out.proposed_profile === e.profileMustNotBe)
    fails.push(`profile must not be "${e.profileMustNotBe}"`);
  if (e.expectInjectionNotice === true && !out.injection_notice)
    fails.push("injection_notice not set");
  if (e.expectInjectionNotice === false && out.injection_notice)
    fails.push(`injection_notice unexpectedly set: ${out.injection_notice.slice(0, 60)}`);
  if (e.maxFirstSteps !== undefined && out.first_steps.length > e.maxFirstSteps)
    fails.push(`first_steps ${out.first_steps.length} > ${e.maxFirstSteps}`);

  // Prompt says alternatives are required below 0.60.
  if (out.confidence < 0.6 && out.confidence >= 0.35 && out.alternatives.length === 0)
    fails.push("confidence < 0.60 but no alternatives given");

  return fails;
}

async function main() {
  const model = arg("model", "claude-opus-5")!;
  const effort = arg("effort", "high")!;
  const runs = Number(arg("runs", "1"));
  const only = arg("fixture");

  const system = readFileSync(join(ROOT, "prompts", "goal-inference.system.md"), "utf8");
  const dir = join(HERE, "fixtures");
  const all = readdirSync(dir).filter((f) => f.endsWith(".json"));

  // Two modalities of the same five scenarios. `.shot.json` carries real
  // screenshots where the text fixture carries a prose `description`, and they
  // are otherwise identical — so running both is the before/after that says
  // whether visual grounding costs anything. Default is text, because it is the
  // cheap one and the one that runs after every prompt edit.
  const wantShots = has("shots") || has("both");
  const wantText = !has("shots") || has("both");
  const files = all
    .filter((f) => (f.endsWith(".shot.json") ? wantShots : wantText))
    .filter((f) => !only || f.startsWith(only) || f.includes(only));

  if (!files.length) {
    console.error(
      `No fixtures matched${only ? ` "${only}"` : ""}.` +
        (wantShots && !all.some((f) => f.endsWith(".shot.json"))
          ? " Recorded fixtures are build output — run `npm run eval:record` first."
          : ""),
    );
    process.exit(1);
  }

  const client = new Anthropic();
  let cost = 0;
  const latencies: number[] = [];
  let pass = 0;
  let total = 0;
  let warnCount = 0;
  const results: unknown[] = [];
  /** Per-modality tallies, so `--both` prints the comparison itself. */
  const byMode: Record<string, { pass: number; total: number; warns: number; cost: number; ms: number[] }> = {
    text: { pass: 0, total: 0, warns: 0, cost: 0, ms: [] },
    shot: { pass: 0, total: 0, warns: 0, cost: 0, ms: [] },
  };

  console.log(`\nmodel=${model}  effort=${effort}  runs=${runs}  fixtures=${files.length}\n`);

  for (const file of files) {
    const fx: Fixture = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const mode = file.endsWith(".shot.json") ? "shot" : "text";

    for (let r = 0; r < runs; r++) {
      total++;
      byMode[mode]!.total++;
      const label = runs > 1 ? `${fx.name} #${r + 1}` : fx.name;
      let out: GoalInference;
      const t0 = Date.now();
      let ms = 0;
      try {
        const res = await client.messages.parse({
          model,
          max_tokens: 16000,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          thinking: { type: "adaptive" },
          output_config: {
            effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
            format: zodOutputFormat(GoalInferenceSchema),
          },
          messages: [{ role: "user", content: renderBundle(fx.bundle) }],
        });
        ms = Date.now() - t0;
        latencies.push(ms);
        byMode[mode]!.ms.push(ms);
        const callCost = res.usage.input_tokens * PRICE_IN + res.usage.output_tokens * PRICE_OUT;
        cost += callCost;
        byMode[mode]!.cost += callCost;
        if (!res.parsed_output) throw new Error("structured output failed to parse");
        out = res.parsed_output as GoalInference;
      } catch (err) {
        console.log(`✗ ${label}\n    ERROR ${(err as Error).message}\n`);
        results.push({ fixture: fx.name, run: r, error: String(err) });
        continue;
      }

      const fails = check(out, fx.expect);
      const warns = warn(out, fx.expect);
      if (!fails.length) {
        pass++;
        byMode[mode]!.pass++;
      }
      warnCount += warns.length;
      byMode[mode]!.warns += warns.length;

      console.log(`${fails.length ? "✗" : "✓"} ${label}   conf=${out.confidence.toFixed(2)}  ${out.proposed_profile}  [${out.risk_flags.join(",") || "no risk"}]  ${(ms / 1000).toFixed(1)}s`);
      console.log(`    goal: ${out.goal}`);
      if (out.already_done.length) console.log(`    done: ${out.already_done.join(" · ")}`);
      if (out.alternatives.length)
        console.log(`    alt:  ${out.alternatives.map((a) => `${a.goal} (${a.confidence})`).join(" | ")}`);
      if (out.injection_notice) console.log(`    inj:  ${out.injection_notice.slice(0, 120)}`);
      for (const f of fails) console.log(`    FAIL  ${f}`);
      for (const w of warns) console.log(`    warn  ${w}`);
      if (has("json")) console.log(`    ${JSON.stringify(out)}`);
      console.log();

      results.push({ fixture: fx.name, run: r, mode, ms, output: out, fails, warns });
    }
  }

  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return {
      med: s.length ? s[Math.floor(s.length / 2)]! / 1000 : 0,
      max: s.length ? s[s.length - 1]! / 1000 : 0,
    };
  };
  const overall = stats(latencies);

  for (const [mode, m] of Object.entries(byMode)) {
    if (!m.total) continue;
    const l = stats(m.ms);
    const label = mode === "shot" ? "screenshots" : "text stand-ins";
    console.log(
      `  ${label.padEnd(15)} ${m.pass}/${m.total} passed · ${m.warns} warn · ` +
        `$${m.cost.toFixed(4)} ($${(m.cost / Math.max(1, m.total)).toFixed(4)}/activation) · ` +
        `median ${l.med.toFixed(1)}s max ${l.max.toFixed(1)}s`
    );
  }
  console.log(
    `\n${pass}/${total} passed · ${warnCount} warn · $${cost.toFixed(4)} · latency median ${overall.med.toFixed(1)}s max ${overall.max.toFixed(1)}s\n`
  );

  const outDir = join(HERE, "runs");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(outDir, `${stamp}_${model}_${effort}.json`);
  writeFileSync(
    path,
    JSON.stringify({ model, effort, runs, pass, total, cost, latencies, results }, null, 2)
  );
  console.log(`→ ${path}\n`);

  process.exit(pass === total ? 0 : 1);
}

main();
