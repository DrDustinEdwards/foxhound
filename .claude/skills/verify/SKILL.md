---
name: verify
description: Use before committing or opening a pull request that changes what Foxhound shows or does (app/, the stylesheets, workers/). Boots the app in Vite on workerd with a local D1, drives the changed flow through the read-only demo in Chromium with Playwright, runs the vitest files that cover the area, and reports the evidence. Signed-in merchant flows, Stripe and the admin are proved by test/ and the live check, not here.
---

# Verify a Foxhound change

Do it before every commit that touches `app/`, `workers/` or `drizzle/`, and before the
pull request. The local app talks to a local D1 only, and `app/lib/demo/` never calls
Stripe or Anthropic.

## 1. Boot the app on a local D1

From the repo root, on the repo's Node (`.nvmrc`; in a cloud session put a Node 26 on
PATH, the one the SessionStart hook installs under `~/.cache/capsid-node/`):

```sh
npm ci
npm run db:migrate
```

`db:migrate` applies `drizzle/migrations` to the local D1 under `.wrangler/state` and
refuses the remote database without `--remote-confirm`, which this skill never passes.
The demo needs no `.dev.vars`.

Port 5173 is often another repo's server, so use 5174 and check it first:

```sh
curl -s -o /dev/null -m 2 http://localhost:5174/ && echo "5174 is busy: pick another port" || echo "5174 free"
npm run dev -- --port 5174 --strictPort    # run in the background
```

Wait until `curl -s -o /dev/null -w '%{http_code}' http://localhost:5174/` prints 200
(the first request compiles), then confirm it is this app:

```sh
curl -s http://localhost:5174/ | grep -o '<title>[^<]*'
```

It prints `<title>Foxhound: Recover failed Stripe payments`. `/health` answers
`"db":"up"` with status `warn` locally (no backup dump, no `AUDIT_SIGNING_KEY`).

`npm run dev` relaunches itself, so the PID of the command you started is not the
server's. Stop it by PID, never by name:

```sh
kill $(pgrep -f "react-router dev --port 5174")
```

Local cannot show Stripe Connect and webhooks, a real sign-in, `/admin` (Access;
`scripts/seed-admin-sample.mjs` seeds sample data but nothing signs you in), the admin
MCP, email, Turnstile, the AI gateway, cron, the edge cache or the queues.

## 2. Drive the changed flow

The signed-in app has one local way in: the demo. `GET /demos/dashboard` (also
`/demos/recovery`, `/demos/disputes`, `/demos/intelligence`) seeds the sample account
"Teamflow" in the local D1, sets the read-only demo cookie and lands on the real
screen. Every non-GET is 405 there, so a write flow is proved by its test file.

Write the script in the session's scratchpad. Name each step as a person would say it,
act through roles and labels, assert what the person should see, collect console and
page errors, and keep a screenshot of the end state.

```js
// <scratchpad>/drive.mjs: PW_CHROMIUM=... node drive.mjs http://localhost:5174
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
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

Run it from the scratchpad. Drive the whole flow (act, see the result, reload and see it
hold); repeat the end state at 390 px and in dark mode (`page.setViewportSize`,
`page.emulateMedia({ colorScheme: "dark" })`) when the change is responsive or themed.
At 1280 px the sidebar links are hidden, so use the visible card or button. The first
run after a cold start can reload while Vite optimizes dependencies; run it again.

The dev server logs a React hydration-mismatch warning on the demo dashboard: name it
as known noise; any other console error is a finding.

If launch fails with "Executable doesn't exist", set
`PW_CHROMIUM=/opt/pw-browsers/chromium`. Do not run `playwright install`.

## 3. Run the vitest files that cover the area

CI runs the whole suite; run only the files for the area (prefixes in `test/`):

```sh
npx vitest run test/demo-mode.test.ts test/demo-mutation-guard.test.ts
```

- Demo and its guard: `demo-*`. Screens: `dashboard-*`, `recovery-*`, `dispute-*`,
  `intelligence-*`.
- Money: `billing-*`, `money-*`, `stripe-*`, `webhook-*`.
- Auth and tenants: `auth-*`, `account-*`, `multi-*`. Admin and MCP: `admin-*`, `mcp-*`.
- Audit: `audit-*`. Settings: `settings-*`.
- A migration: `npm run check:migrations`. A new route or page weight:
  `npm run check:page-weight`.

Before the commit run `npm run typecheck`, `npm run lint` and `npm run format:check`
(`npx oxfmt <file>` fixes this file).

## Rules

A failed step is a finding about the change: fix the code and rerun the same script;
never add a sleep, retry or looser selector. Stop the server by PID, never `pkill` by
name.

## The report

Put this in the reply and the pull request body:

- First line: verified, partly verified (and what was not), or failed.
- Each step's ok or FAIL line verbatim, the console errors line, and the end-state
  screenshot attached.
- The summary line of each vitest run and check you ran.
- Not verified: what local cannot show (above). The live check after a merge is the
  `deploy` job in `.github/workflows/ci.yml` (`devkit-verify-deploy` against
  https://foxhoundapp.com, rollback on a refusal).
