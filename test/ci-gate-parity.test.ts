import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// A GATE THE PIPELINE DOES NOT RUN IS NOT A GATE (153, 318, ruling 378 call (b)).
//
// check-gates reported four wired gates (typecheck, lint, test, check-tokens)
// and CI ran three of them. Lint was the missing one, so it went red and stayed
// red across at least two sessions without anything noticing: check:all was the
// only thing that ran it, and nothing in the pipeline ran check:all. The failure
// was not that a gate broke. It was that the list of gates and the list of
// things actually enforced were two lists, and nothing compared them.
//
// So this compares them. BOTH SIDES ARE DERIVED, neither is transcribed: the
// gate list is parsed out of package.json's check:all chain using the same rule
// scripts/check-gates.mjs applies, and the enforced list is parsed out of the
// verify job in .github/workflows/ci.yml. Same shape as test/cron-registry's
// wrangler.jsonc derivation, and for the same reason: a hardcoded mirror of
// another file's contents goes stale on the first change that forgets it, and
// then reports the config as wrong when the config is right.
//
// It fails in both directions. A gate added to check:all but not to CI is a
// gate nothing enforces; a gate added to CI but not to check:all cannot be run
// locally before a push, which is the rule 335 exists for.

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function read(relativePath: string): string {
  return readFileSync(`${ROOT}/${relativePath}`, "utf8");
}

/** The npm script a `run:` command invokes, or null when it invokes none.
 *  `npm ci` and `npm install` are not script invocations and must not be
 *  mistaken for a script literally named "ci". */
function npmScriptName(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  if (parts[0] !== "npm") return null;
  if (parts[1] === "run") return parts[2] ?? null;
  // npm's lifecycle shorthands, which do invoke a package script. CI writes
  // `npm test` where check:all writes `npm run test`; they are the same gate,
  // and a comparison that missed that would report a false disagreement.
  if (["test", "start", "stop", "restart"].includes(parts[1] ?? "")) return parts[1];
  return null;
}

/** The gates check:all chains, parsed the way scripts/check-gates.mjs parses
 *  them: split on &&, drop check-gates itself because it checks the chain
 *  rather than the code. */
const CHECK_ALL_GATES: string[] = (() => {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  const chain = pkg.scripts?.["check:all"];
  if (typeof chain !== "string" || chain.trim() === "") {
    throw new Error("package.json has no check:all script; the parity test cannot mean anything");
  }
  return chain
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.endsWith("check-gates"))
    .map((s) => npmScriptName(s))
    .filter((s): s is string => s !== null);
})();

const CI_YAML = read(".github/workflows/ci.yml");

/** The `verify` job's block, from its key to the next job key at the same
 *  indent. Scoping matters: the deploy job runs db:migrate and wrangler, and
 *  neither is a gate. */
function jobBlock(yaml: string, jobName: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^  ${jobName}:\\s*$`).test(line));
  if (start === -1) throw new Error(`ci.yml has no \`${jobName}:\` job`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every command a block's steps run, including block scalars, ignoring
 *  comments so prose in a `#` line can never be read as a step. */
function runCommands(block: string): string[] {
  const lines = block.split("\n").filter((line) => !line.trim().startsWith("#"));
  const commands: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, indent, inline] = match;
    if (inline === "|" || inline === ">" || inline === "|-" || inline === ">-") {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") continue;
        const childIndent = /^\s*/.exec(lines[j])![0].length;
        if (childIndent <= indent.length) break;
        commands.push(lines[j].trim());
      }
    } else if (inline.trim() !== "") {
      commands.push(inline.trim());
    }
  }
  return commands;
}

const VERIFY_COMMANDS = runCommands(jobBlock(CI_YAML, "verify"));
const VERIFY_SCRIPTS = VERIFY_COMMANDS.map(npmScriptName).filter((s): s is string => s !== null);

// Steps the verify job runs that are deliberately NOT check:all gates. `build`
// is here because conventions require a build before every push while check:all
// does not chain one, so it is enforced in CI and asserted below on its own.
// `report:bloat` is here because it is a warn-only report, not a gate: it exits
// 0 on every finding (job_30ab4e0e8702) and still runs locally by name.
// Anything else appearing in CI without a check:all entry fails the second
// direction, which is the point.
const DECLARED_NON_GATE_STEPS = new Set(["build", "report:bloat"]);

describe("CI enforces exactly the gates check:all names", () => {
  // Guard the instrument before trusting it. An assertion that can pass by
  // reading nothing is the failure mode this whole file exists to catch, so a
  // parse that silently returned [] must not read as agreement.
  it("parsed a non-empty gate list out of package.json", () => {
    expect(CHECK_ALL_GATES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(CHECK_ALL_GATES).size).toBe(CHECK_ALL_GATES.length);
  });

  it("parsed a non-empty command list out of the ci.yml verify job", () => {
    expect(VERIFY_COMMANDS.length).toBeGreaterThanOrEqual(5);
    expect(VERIFY_SCRIPTS.length).toBeGreaterThanOrEqual(4);
  });

  it("scoped the parse to verify, so the deploy job's steps are not counted", () => {
    expect(VERIFY_COMMANDS.join("\n")).not.toContain("db:migrate");
    expect(VERIFY_COMMANDS.join("\n")).not.toContain("wrangler");
  });

  it("EVERY gate check:all chains is invoked in the CI verify job", () => {
    for (const gate of CHECK_ALL_GATES) {
      expect(
        VERIFY_SCRIPTS,
        `npm run ${gate} is a check:all gate that CI never runs, so nothing enforces it`,
      ).toContain(gate);
    }
  });

  it("AND EVERY npm script CI verify runs is a check:all gate, so a local run covers CI", () => {
    for (const script of VERIFY_SCRIPTS) {
      if (DECLARED_NON_GATE_STEPS.has(script)) continue;
      expect(
        CHECK_ALL_GATES,
        `CI runs npm run ${script} but check:all does not, so it cannot be run locally before a push (335)`,
      ).toContain(script);
    }
  });

  it("lint specifically is both chained and enforced, which is what 378 (b) turned on", () => {
    expect(CHECK_ALL_GATES).toContain("lint");
    expect(VERIFY_SCRIPTS).toContain("lint");
  });

  it("CI still builds, which check:all does not do and a push is not allowed without", () => {
    expect(VERIFY_SCRIPTS).toContain("build");
  });

  it("check-gates' minimum is consistent with the chain it counts", () => {
    const source = read("scripts/check-gates.mjs");
    const declared = /const MINIMUM_GATES = (\d+);/.exec(source);
    expect(declared, "check-gates.mjs no longer declares MINIMUM_GATES").not.toBeNull();
    const minimum = Number(declared![1]);
    // check-gates would report CHECK_ALL_GATES.length; if the minimum ever
    // exceeds what the chain actually holds, check-gates fails and says so.
    // This asserts the number it prints is not larger than the truth.
    expect(minimum).toBeLessThanOrEqual(CHECK_ALL_GATES.length);
    expect(minimum).toBeGreaterThanOrEqual(4);
  });
});
