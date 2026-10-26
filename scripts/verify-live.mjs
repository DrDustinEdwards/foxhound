// The live gate's verify for Foxhound: run by devkit's worker-deploy.yml after /health reports the commit this run
// deployed. Exit 0 passes, 1 refuses (devkit rolls the deploy back), 3 could not decide (the job fails, nothing moves).
//
// 1. The home page answers 200. Anything else after five minutes is a refusal.
// 2. Every content-hashed asset the home page names answers 200. A Worker rollout takes a few minutes to reach every
//    colo, and a colo still on the previous version names that version's assets (observed 2026-07-28: an unstyled page
//    from a stylesheet 404). That is a rollout that has not converged, not a bad build, so after five minutes it is
//    exit 3: the job fails loudly and the deploy stays.
//
// Each read carries a cache-busting query, as the old CI step did, so no edge copy answers for the Worker.

const ORIGIN = "https://foxhoundapp.com";
const ATTEMPTS = 30;
const WAIT_MS = 10_000;
const sha = (process.env.EXPECT_SHA ?? "").slice(0, 12) || "manual";

const status = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    return { code: res.status, text: res.status === 200 ? await res.text() : "" };
  } catch {
    return { code: 0, text: "" };
  }
};

let last = "no attempt ran";
let homeBroken = false;
for (let i = 1; i <= ATTEMPTS; i++) {
  const home = await status(`${ORIGIN}/?ci=${sha}-${i}`);
  homeBroken = home.code !== 200;
  if (homeBroken) {
    last = home.code ? `home page answered ${home.code}` : "home page did not answer";
  } else {
    const refs = [...new Set(home.text.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g) ?? [])];
    if (refs.length === 0) {
      last = "home page names no hashed assets";
    } else {
      const bad = [];
      for (const ref of refs) {
        const { code } = await status(`${ORIGIN}${ref}`);
        if (code !== 200) bad.push(`${ref} (${code || "no answer"})`);
      }
      if (bad.length === 0) {
        console.log(`verify-live: home page 200 and all ${refs.length} assets it names answer 200.`);
        process.exit(0);
      }
      last = `assets not answering 200: ${bad.join(", ")}`;
    }
  }
  console.log(`attempt ${i}: ${last}`);
  if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, WAIT_MS));
}

if (homeBroken && !last.includes("did not answer")) {
  console.error(`verify-live: REFUSED. After five minutes the ${last}.`);
  process.exit(1);
}
console.error(`verify-live: could not confirm the rollout after five minutes (${last}). The deploy stays.`);
process.exit(3);
