import { describe, expect, it } from "vitest";

import {
  commitChainCheck,
  extractRowIds,
  extractShas,
  forwardCheck,
  guardNonEmpty,
  inverseCheck,
  ledgerCheck,
} from "../scripts/check-canon-lib.mjs";

// Ruling 153: a guard that has never been observed FAILING has not been
// verified. Every check below is planted with the violation it exists to catch
// AND run against a clean control, so "0 violations" can never mean "0 inputs
// parsed". Ruling 122: an input class the sweep cannot parse is a failure, not
// a skip, so that case is planted too.
//
// This file is .mjs, not .ts, matching test/check-tokens-matcher.test.mjs. A
// .ts test importing an untyped .mjs lib fails `tsc` with TS7016, which is how
// the first version of this file turned the typecheck gate red.

const ENTRY = "CLAUDE.md";

/** A minimal but structurally faithful canon set that should pass every check. */
function cleanCanon() {
  return new Map([
    [ENTRY, "Entry point. Campaign canon starts at parity/DECISIONS.md."],
    [
      "parity/DECISIONS.md",
      "Rulings 1-155. Live volume parity/DECISIONS-VOL3.md. Ledger parity/PARITY-ROWS.md.",
    ],
    ["parity/DECISIONS-VOL3.md", "Rulings 185 onward. Companion parity/DECISIONS.md."],
    [
      "parity/PARITY-ROWS.md",
      [
        "Index.",
        "| section | document | rows |",
        "| Marketing | parity/ROWS-M.md | 2 |",
        "| **Total** | | **3** | |",
      ].join("\n"),
    ],
    [
      "parity/ROWS-M.md",
      ["| M1 | /a | l | f | FIXED:abc1234 |", "| M2 | /b | l | f | PARTIAL:none |"].join("\n"),
    ],
    ["parity/ROWS-S.md", "| S1 | /c | l | f | UNCHECKED |"],
  ]);
}

/** ROWS-S is cited from the index so the clean set is fully reachable. */
function cleanCanonLinked() {
  const docs = cleanCanon();
  const index = docs.get("parity/PARITY-ROWS.md");
  docs.set("parity/PARITY-ROWS.md", `${index}\n| App shell | parity/ROWS-S.md | 1 |`);
  return docs;
}

const allShasResolve = () => true;

describe("check-canon: negative control", () => {
  it("reports zero violations on a clean canon set, having actually parsed it", () => {
    const docs = cleanCanonLinked();
    expect(guardNonEmpty(docs)).toEqual([]);

    const forward = forwardCheck(docs);
    expect(forward.violations).toEqual([]);
    // The count assertion is the point: 0 violations must not be reachable by
    // parsing nothing.
    expect(forward.citedCount).toBeGreaterThan(0);

    const inverse = inverseCheck(docs, ENTRY);
    expect(inverse.violations).toEqual([]);
    expect(inverse.reachedCount).toBe(docs.size);

    const ledger = ledgerCheck(docs, "parity/PARITY-ROWS.md");
    expect(ledger.violations).toEqual([]);
    expect(ledger.counted).toBe(3);
    expect(ledger.declared).toBe(3);

    const chain = commitChainCheck(docs, allShasResolve);
    expect(chain.violations).toEqual([]);
    expect(chain.checked).toBe(1); // PARTIAL:none is not a sha
  });
});

describe("check-canon: forward check (ruling 135)", () => {
  it("catches a citation to a destination that does not exist", () => {
    const docs = cleanCanonLinked();
    docs.set("parity/DECISIONS.md", `${docs.get("parity/DECISIONS.md")} See parity/GHOST.md.`);
    const { violations } = forwardCheck(docs);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("parity/GHOST.md");
  });
});

describe("check-canon: inverse check from the AGENT entry point (rulings 166, 191)", () => {
  it("catches an orphan that holds canon but nothing reaches", () => {
    const docs = cleanCanonLinked();
    docs.set("parity/DECISIONS-VOL9.md", "Rulings nobody can reach.");
    const { violations } = inverseCheck(docs, ENTRY);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("parity/DECISIONS-VOL9.md");
    expect(violations[0]).toContain("NOT reachable");
  });

  it("is measured from the agent entry point, not from canon's own root", () => {
    // The exact defect 191 names: reachable from parity/DECISIONS.md, but the
    // entry point an agent actually opens does not cite the campaign at all.
    const docs = cleanCanonLinked();
    docs.set(ENTRY, "Repo rules. No mention of the campaign.");
    const fromEntry = inverseCheck(docs, ENTRY);
    const fromCanonRoot = inverseCheck(docs, "parity/DECISIONS.md");
    expect(fromEntry.violations.length).toBeGreaterThan(0);
    expect(fromCanonRoot.violations.length).toBeLessThan(fromEntry.violations.length);
  });

  it("fails loud when the entry point itself is absent", () => {
    const docs = cleanCanonLinked();
    docs.delete(ENTRY);
    const { violations } = inverseCheck(docs, ENTRY);
    expect(violations[0]).toContain("entry point");
  });
});

describe("check-canon: ledger reconciliation", () => {
  it("catches a declared total that disagrees with the rows counted", () => {
    const docs = cleanCanonLinked();
    docs.set("parity/ROWS-S.md", "| S1 | /c | l | f | UNCHECKED |\n| S2 | /d | l | f | UNCHECKED |");
    const { violations } = ledgerCheck(docs, "parity/PARITY-ROWS.md");
    expect(violations.some((v) => v.includes("declares 3 rows, 4 counted"))).toBe(true);
  });

  it("catches the same row id appearing in two section files", () => {
    const docs = cleanCanonLinked();
    docs.set("parity/ROWS-S.md", "| M1 | /c | l | f | UNCHECKED |");
    const { violations } = ledgerCheck(docs, "parity/PARITY-ROWS.md");
    expect(violations.some((v) => v.includes("row M1 appears in both"))).toBe(true);
  });

  it("FAILS LOUD rather than skipping when the total is unparseable (ruling 122)", () => {
    const docs = cleanCanonLinked();
    docs.set("parity/PARITY-ROWS.md", "Index with no machine-readable total at all.");
    const { violations, declared } = ledgerCheck(docs, "parity/PARITY-ROWS.md");
    expect(declared).toBeNull();
    expect(violations.some((v) => v.includes("could not run"))).toBe(true);
  });
});

describe("check-canon: commit chain (rulings 128, 136)", () => {
  it("catches a row citing a sha that is not a commit", () => {
    const docs = cleanCanonLinked();
    const { violations } = commitChainCheck(docs, () => false);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("abc1234");
  });

  it("treats PARTIAL:none as an explicit no-commit form, not a bad sha", () => {
    const shas = extractShas("parity/ROWS-M.md", "| M2 | /b | l | f | PARTIAL:none |");
    expect(shas).toEqual([]);
  });

  it("splits a multi-sha chain into each commit", () => {
    const shas = extractShas("x.md", "| M3 | /c | l | f | PARTIAL:aaa1111+bbb2222 |");
    expect(shas.map((s) => s.sha)).toEqual(["aaa1111", "bbb2222"]);
  });
});

describe("check-canon: empty-input guard (ruling 122)", () => {
  it("refuses to report clean over an empty canon set", () => {
    expect(guardNonEmpty(new Map())).toHaveLength(1);
    expect(guardNonEmpty(new Map())[0]).toContain("EMPTY");
  });

  it("parses row ids rather than counting pipe characters", () => {
    expect(
      extractRowIds("| M3b | /x | l | f | FIXED:abc |\nnot a row\n| S12 | /y | l | f | X |"),
    ).toEqual(["M3b", "S12"]);
  });
});
