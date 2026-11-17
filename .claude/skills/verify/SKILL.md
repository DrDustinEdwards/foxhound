---
name: verify
description: Use before committing or opening a pull request that changes what Foxhound shows or does (app/, the stylesheets, workers/). Boots the app in Vite on workerd with a local D1, drives the changed flow through the read-only demo in Chromium with Playwright, runs the vitest files that cover the area, and reports the evidence. Signed-in merchant flows, Stripe and the admin are proved by test/ and the live check, not here.
---

# Verify a Foxhound change

Tests prove what someone thought to test. This skill proves the change itself: run
the real app, use the changed flow as a visitor would, and look at the result. Do it
before every commit that touches `app/`, `workers/` or `drizzle/`, and before the
pull request. Never touch live money or a real merchant: the local app talks to a
local D1 only, and `app/lib/demo/` never calls Stripe or Anthropic (CLAUDE.md, hard
rule 10).

## 1. Boot the app on a local D1

From the repo root, on the repo's Node (`.nvmrc`; in a cloud session prepend a Node
26 to PATH, for example `~/.cache/capsid-node/node-v26.13.1-linux-x64/bin`):

```sh
npm ci
npm run db:migrate
```

`db:migrate` is `devkit-db-migrate foxhound`: it applies `drizzle/migrations` to the
local D1 under `.wrangler/state` and refuses the remote database unless you pass
`--remote-confirm`, which this skill never does (the real database is production).
`wrangler.jsonc` is committed and names the production D1, but `npm run dev` binds a
local copy. Nothing needs `.dev.vars` for the demo.

Port 5173 is often another repo's server, so use 5174 and check it first. Start Vite
(workerd, local D1) in the background:

```sh
curl -s -o /dev/null -m 2 http://localhost:5174/ && echo "5174 is busy: pick another port" || echo "5174 free"
npm run dev -- --port 5174 --strictPort    # run in the background
```

Wait until `curl -s -o /dev/null -w '%{http_code}' http://localhost:5174/` prints 200
(the first request compiles and takes a few seconds), then confirm it is this app:

```sh
curl -s http://localhost:5174/ | grep -o '<title>[^<]*'
```

It prints `<title>Foxhound: Recover failed Stripe payments`. Another repo's app on a
port you did not start has a different title (Germomics was on 5173). `/health` answers
`"db":"up"` with status `warn`: the missing backup dump and `AUDIT_SIGNING_KEY` are
normal locally.

Stop it by PID, not by name, because other sessions may share the machine. `npm run
dev` relaunches itself, so the PID of the command you started is not the server's:

```sh
kill $(pgrep -f "react-router dev --port 5174")
```

What local shows: public pages, the read-only demo (all four products), the headers and
CSP the Worker sends, and the schema from every migration. What it cannot show:
Stripe Connect and webhooks, a real sign-in (passkey, emailed link, Google, Apple),
`/admin` (behind Cloudflare Access; `scripts/seed-admin-sample.mjs` seeds local sample
data for it, but nothing here signs you in), the admin MCP, email, Turnstile, the AI
gateway, cron jobs, the edge cache and the queues.

## 2. Drive the changed flow

The signed-in app has one local way in: the demo. `GET /demos/dashboard` (also
`/demos/recovery`, `/demos/disputes`, `/demos/intelligence`) seeds the sample account
"Teamflow" in the local D1, sets the read-only demo cookie and lands on the real
product screen. Every non-GET is refused with 405 there, so a write flow is proved by
its test file, not here. Do not invent another sign-in.

The repo's only Playwright use is `scripts/viewport-harness.mjs` (it drives an
installed Chrome and is for width measurements), so resolve the repo's `playwright`
with `createRequire` as below. Write the script in the session's scratchpad, never in
the repo. Name each step the way a person would say it, act through roles and labels,
and assert what the person should see afterward. Collect console errors and page
errors, and keep a screenshot of the end state.

```js
// <scratchpad>/drive.mjs: REPO=<repo> PW_CHROMIUM=... node drive.mjs http://localhost:5174
import { createRequire } from "node:module";
const { chromium } = createRequire(`${process.env.REPO}/package.json`)("playwright");
const origin = process.argv[2];
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on(
  "console",
  (m) =>
    m.type() === "error" &&
    !/Failed to load resource/.test(m.text()) &&
    errors.push(m.text().split("\n")[0]),
);
page.on("pageerror", (e) => errors.push(String(e)));
const log = [];
async function step(name, fn) {
  try {
    await fn();
    log.push(`ok   ${name}`);
  } catch (e) {
    log.push(`FAIL ${name}: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: "fail.png", fullPage: true });
    throw e;
  }
}
try {
  await step("open the home page and confirm it is Foxhound", async () => {
    const r = await page.goto(origin);
    if (!r.ok()) throw new Error(`status ${r.status()}`);
    const title = await page.title();
    if (!/Foxhound/.test(title)) throw new Error(`not Foxhound: ${title}`);
    log.push(`     title: ${title}`);
  });
  await step("enter the demo dashboard (read-only Teamflow account)", async () => {
    await page.goto(`${origin}/demos/dashboard`);
    await page.waitForURL("**/console");
    await page.waitForLoadState("networkidle");
    await page.getByText("Demo with sample data").waitFor();
    log.push(`     h1: ${await page.locator("main h1").first().innerText()}`);
  });
  await step("open Recovery from the dashboard card", async () => {
    await page
      .getByRole("link", { name: /Recovery/ })
      .first()
      .click();
    await page.waitForURL("**/recovery/dashboard");
    await page.locator("main h1").first().waitFor();
    log.push(`     h1: ${await page.locator("main h1").first().innerText()}`);
  });
  // ...the changed flow: click, fill, then assert the visible result.
  await page.screenshot({ path: "after.png", fullPage: true });
} finally {
  console.log(log.join("\n"));
  console.log("console errors:", errors.length ? errors : "none");
  await browser.close();
}
```

Run it from the scratchpad with `REPO=<repo> node drive.mjs http://localhost:5174`.
Drive the whole flow, not just the page load: follow the link, change the filter or
tab, see the rows change, reload and see it hold. At 1280 px the sidebar links are
hidden, so a role query for a nav label finds nothing; use the visible card or
button, or set a narrower viewport. If the change is responsive or themed, repeat the
end state at 390 px wide and in dark mode (`page.setViewportSize`,
`page.emulateMedia({ colorScheme: "dark" })`). The first run after a cold start can
reload the page while Vite optimizes dependencies; start the run again after the
server has served a page once.

On the demo dashboard the dev server logs a React hydration-mismatch warning to the
console (seen 2026-11-17 on a clean `main`). Name it as known noise in the report; any
other console error is a finding.

If launch fails with "Executable doesn't exist" (the repo's Playwright build does not
match the container's Chromium), set `PW_CHROMIUM=/opt/pw-browsers/chromium`. Do not
run `playwright install`.

## 3. Run the vitest files that cover the area

CI runs all 335 files with `npm test`; run only the files for the area you changed:

```sh
npx vitest run test/demo-mode.test.ts test/demo-mutation-guard.test.ts
```

Which files cover what (the names are the prefixes in `test/`):

- Demo and its read-only guard: `demo-*.test.ts`.
- Console, Recovery, Disputes and Intelligence screens: `dashboard-*`, `recovery-*`,
  `dispute-*`, `intelligence-*`.
- Money: `billing-*`, `money-*`, `stripe-*`, `webhook-*`. A change under hard rules 2
  and 3 (one writer per money table, a zero-row UPDATE is a failure) needs these.
- Auth and tenant isolation: `auth-*`, `account-*`, `multi-*`.
- Admin and the admin MCP: `admin-*`, `mcp-*`.
- Audit: `audit-*`. Settings: `settings-*`.
- A migration: `npm run check:migrations` (expand-only manifest) and, if it recreates a
  table, hard rule 5's proof against real D1.
- A new route or page weight: `npm run check:page-weight`.

Before the commit run `npm run typecheck`, `npm run lint` and `npm run format:check`
(oxfmt formats this file and any Markdown you touch; run `npx oxfmt <file>` to fix it).
CI also runs `check-tokens`, `check:console`, `check:bloat`, `check:test-assertions`,
`check:conformance` and the full suite; do not run the whole set here.

## Rules

- A failed step is a finding about the change. Fix the code, then run the same script
  again. Never add a sleep, a retry or a looser selector to make it pass.
- If a step fails sometimes, find out why before going on; a flaky check teaches the
  next thread to re-run instead of fix.
- Never edit an existing test to make it agree with new behavior unless the change is
  meant to alter that behavior, and say so in the pull request.
- Leave nothing behind: stop the server you started, and keep the scripts and
  screenshots in the scratchpad. Never run a Stripe, remote D1 or production command
  from this skill. Nothing from this skill is committed.

## The report

Put this in the reply and the pull request body:

- First line: verified, partly verified (and what was not), or failed.
- Each step's ok or FAIL line, verbatim, and the console errors line.
- The end-state screenshot, attached (Dustin cannot open a scratchpad path).
- The summary line of each vitest run and check you ran.
- Anything local cannot show, named as not verified: a real sign-in, Stripe Connect and
  webhooks, `/admin` and the admin MCP, email, live D1, cron, queues and the edge
  cache. The live check after a merge deploys is the `deploy` job in
  `.github/workflows/ci.yml`: its live gate waits for `/health` to report the commit,
  runs `devkit-verify-deploy` against https://foxhoundapp.com (home page and every
  hashed asset answer 200) and rolls back on a refusal.
