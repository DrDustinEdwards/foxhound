// Matchers for the canon integrity sweep (ruling 100, mechanised by ruling 192).
// Pure functions only: no filesystem, no git, no network, so every check can be
// exercised against planted violations in test/check-canon.test.ts without
// materialising a canon export. The CLI in check-canon.mjs supplies the I/O.
//
// WHY THIS IS A LIB AND NOT A SCRIPT: check-tokens.mjs established the split so
// the matchers are provable. Ruling 153 found a guard that had never been
// observed failing was worse than no guard, and ruling 122 that a silent skip
// is worse than a missing gate. Every function here therefore reports what it
// COULD NOT parse as loudly as what it found wrong.

/** A citation to another canon document, e.g. `parity/ROWS-S.md`. */
const CITATION_RE = /\b(parity\/[A-Za-z0-9._-]+\.md)\b/g;

/** A ledger row line: `| S2 | /console | legacy | foxhound | status |`. */
const ROW_RE = /^\|\s*([A-Z]{1,2}\d+[a-z]?)\s*\|/;

/** A declared total, e.g. `| **Total** | | **134** | |` or `Total declared 134`. */
const TOTAL_RE = /\*\*Total\*\*\s*\|\s*\|\s*\*\*(\d+)\*\*/;

/**
 * Commit shas cited in a status cell. Accepts `FIXED:abc1234`,
 * `PARTIAL:abc1234+def5678`, and the explicit no-commit form `PARTIAL:none`
 * which ruling 96 introduced so a bare PARTIAL could not be confused with a
 * dropped chain.
 */
const SHA_CLAUSE_RE = /\b(?:FIXED|PARTIAL):([A-Za-z0-9+]+)/g;

export function extractCitations(body) {
  return [...new Set((body.match(CITATION_RE) ?? []))];
}

/** Row ids declared in a canon document, in order. */
export function extractRowIds(body) {
  const ids = [];
  for (const line of body.split("\n")) {
    const m = ROW_RE.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

export function extractDeclaredTotal(body) {
  const m = TOTAL_RE.exec(body);
  return m ? Number(m[1]) : null;
}

/** Every sha token cited by a status cell, with the row it came from. */
export function extractShas(path, body) {
  const out = [];
  for (const line of body.split("\n")) {
    const row = ROW_RE.exec(line);
    if (!row) continue;
    for (const m of line.matchAll(SHA_CLAUSE_RE)) {
      for (const sha of m[1].split("+")) {
        if (sha === "none") continue; // ruling 96's explicit no-commit form
        out.push({ path, rowId: row[1], sha });
      }
    }
  }
  return out;
}

/**
 * FORWARD CHECK (ruling 135): every cited destination must exist.
 * `docs` is a Map of canonPath -> body.
 */
export function forwardCheck(docs) {
  const violations = [];
  let cited = 0;
  for (const [path, body] of docs) {
    for (const dest of extractCitations(body)) {
      cited++;
      if (!docs.has(dest)) {
        violations.push(`${path} cites ${dest}, which does not exist in the canon set`);
      }
    }
  }
  return { violations, citedCount: cited };
}

/**
 * INVERSE CHECK (ruling 166, re-pointed by ruling 191): every canon document
 * must be reachable by following citations FROM THE AGENT ENTRY POINT, not from
 * whichever document a reader of canon happens to open. Reachability is a
 * property of a path and a path has a beginning somebody chooses.
 */
export function inverseCheck(docs, entryPoint) {
  if (!docs.has(entryPoint)) {
    return {
      violations: [`entry point ${entryPoint} is not present in the canon set`],
      reachedCount: 0,
    };
  }
  const seen = new Set([entryPoint]);
  const queue = [entryPoint];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dest of extractCitations(docs.get(current))) {
      if (docs.has(dest) && !seen.has(dest)) {
        seen.add(dest);
        queue.push(dest);
      }
    }
  }
  const violations = [];
  for (const path of docs.keys()) {
    if (!seen.has(path)) {
      violations.push(`${path} holds canon but is NOT reachable from ${entryPoint}`);
    }
  }
  return { violations, reachedCount: seen.size };
}

/**
 * LEDGER RECONCILIATION: rows counted across the section files must equal the
 * total the index declares, and no row id may appear twice.
 */
export function ledgerCheck(docs, indexPath) {
  const violations = [];
  const seen = new Map();
  let counted = 0;
  for (const [path, body] of docs) {
    if (!/\/ROWS-[A-Z]\.md$/.test(path)) continue;
    for (const id of extractRowIds(body)) {
      counted++;
      if (seen.has(id)) {
        violations.push(`row ${id} appears in both ${seen.get(id)} and ${path}`);
      } else {
        seen.set(id, path);
      }
    }
  }
  const index = docs.get(indexPath);
  if (index === undefined) {
    violations.push(`ledger index ${indexPath} is absent, so the count cannot be reconciled`);
    return { violations, counted, declared: null };
  }
  const declared = extractDeclaredTotal(index);
  if (declared === null) {
    // Ruling 122: an unparseable input is a failure, never a skip.
    violations.push(`ledger index ${indexPath} declares no parseable total, so the count check could not run`);
  } else if (declared !== counted) {
    violations.push(`ledger declares ${declared} rows, ${counted} counted across the ROWS files`);
  }
  return { violations, counted, declared };
}

/**
 * COMMIT-CHAIN CHECK (rulings 128, 136): every sha a row cites must resolve to a
 * real commit. `resolves` is injected so the matcher stays pure and testable.
 */
export function commitChainCheck(docs, resolves) {
  const violations = [];
  let checked = 0;
  for (const [path, body] of docs) {
    for (const { rowId, sha } of extractShas(path, body)) {
      checked++;
      if (!resolves(sha)) {
        violations.push(`${path} row ${rowId} cites sha ${sha}, which is not a commit in this repo`);
      }
    }
  }
  return { violations, checked };
}

/** Ruling 122: refuse to report a clean sweep over nothing. */
export function guardNonEmpty(docs) {
  if (docs.size === 0) {
    return ["canon set is EMPTY: the sweep would report clean having read nothing"];
  }
  return [];
}
