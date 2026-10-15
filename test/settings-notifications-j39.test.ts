import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { SLACK_WEBHOOK_ERROR } from "~/lib/settings/slack-webhook";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J39 (job_4b5f4ca4e9ae), row S36, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/notifications is Recova's page
// (app/(app)/settings/notifications/page.tsx at blob 93126fd2,
// NotificationsForm.tsx at blob 316c15cf and
// settings/components/NotificationsSection.tsx at blob 494c6dfa, with the
// SaveBar at app/(app)/settings/SaveBar.tsx blob f1d6eb23 and the Toggle at
// components/Toggle.tsx blob 0ebdd395) built from Capsomer 0.9.0's components,
// teal throughout. Recova stays the spec for every field, toggle and label and
// their order; the page keeps the settings layout's 800px column.
//
// The webhook host rule (hooks.slack.com) stays pinned where it was; the
// NULL map and the six columns stay in settings-digest-email-removed and the
// MCP write tests. Every assertion here was seen failing before the rebuild.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/notifications");

const SOURCE = readFileSync(new URL("../app/routes/app/settings/notifications.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

const LOADED = {
  notificationEmail: "ops@acme.test",
  slackWebhookUrl: "",
  slackNotificationsEnabled: false,
  digestEnabled: true,
  recoveryNotificationsEnabled: true,
  sequenceCompleteNotificationsEnabled: false,
};

function render(opts: { loaderData?: Record<string, unknown>; actionData?: Record<string, unknown> } = {}): string {
  const loaderData = { ...LOADED, ...(opts.loaderData ?? {}) };
  const Stub = createRoutesStub([
    {
      path: "/settings/notifications",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/notifications"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The <input> element for a field name. */
function input(html: string, name: string): string {
  return html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/** What the senders do with a NULL notification_email, said on the page. */
const BLANK_SENDS_NOTHING = "Leave it blank and no notification emails are sent.";

const TOGGLES = [
  ["slackNotificationsEnabled", "Slack notifications", "Notify when a payment is recovered or an email is sent"],
  ["digestEnabled", "Weekly digest", "Monday summary of recovered revenue and active sequences"],
  ["recoveryNotificationsEnabled", "Payment recovered notification", "Email me when a payment is successfully recovered"],
  [
    "sequenceCompleteNotificationsEnabled",
    "Sequence complete notification",
    "Email me when a recovery sequence ends without recovering the payment",
  ],
] as const;

describe("J39 notifications: the page head", () => {
  it("is Capsomer's PageHead with Recova's title and line", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Notifications<\/h1>/);
    expect(html).toContain('<p class="cap-page-head-lead">Email, Slack, and digest delivery preferences.</p>');
  });

  it("opens with Recova's phone-only back link to the settings hub", () => {
    const html = render();
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain("md:hidden");
    expect(text(link)).toBe("Settings");
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("cap-page-head-title"));
  });

  it("sits in the settings layout's 800px column with no width or padding of its own", () => {
    const html = render();
    expect(html).not.toContain("max-w-2xl");
    expect(html).not.toMatch(/class="mx-auto/);
  });
});

describe("J39 notifications: the card", () => {
  it("is one Capsomer panel holding Recova's two fields and four toggles in order", () => {
    const html = render();
    expect(html).toMatch(/<section class="cap-panel">/);
    const card = html.slice(html.indexOf('<section class="cap-panel">'), html.indexOf("</section>"));
    const labels = [
      "Notification email",
      "Slack webhook URL",
      ...TOGGLES.map(([, label]) => label),
    ];
    let at = -1;
    for (const label of labels) {
      const next = card.indexOf(label);
      expect(next, label).toBeGreaterThan(at);
      at = next;
    }
  });

  it("labels the notification email as a Capsomer field with help that says what a blank box does", () => {
    const html = render();
    const tag = input(html, "notificationEmail");
    expect(attr(tag, "type")).toBe("email");
    expect(attr(tag, "class")).toBe("cap-input");
    expect(attr(tag, "value")).toBe("ops@acme.test");
    expect(html).toMatch(new RegExp(`<label class="cap-field-label" for="${attr(tag, "id")}">Notification email</label>`));
    const help = attr(tag, "aria-describedby") ?? "";
    expect(html).toMatch(
      new RegExp(
        `<p class="cap-field-help" id="${help}">Where all notifications are sent: recovery alerts, sequence updates, and weekly digest. ${BLANK_SENDS_NOTHING}</p>`,
      ),
    );
  });

  it("never promises a fallback to the account email, which no sender has", () => {
    // Recova's "Defaults to your account email if blank." was untrue there and
    // is untrue here: a blank box saves NULL and every sender skips it.
    expect(CODE).not.toMatch(/Defaults to your account email/i);
  });

  it("puts no address in the placeholder, so a cleared box shows no address that would get nothing", () => {
    const html = render({ loaderData: { notificationEmail: "" } });
    const tag = input(html, "notificationEmail");
    expect(attr(tag, "value")).toBe("");
    expect(attr(tag, "placeholder")).toBeUndefined();
    expect(html).not.toContain("owner@acme.test");
  });

  it("labels the Slack webhook as a Capsomer field with Recova's placeholder and help", () => {
    const html = render();
    const tag = input(html, "slackWebhookUrl");
    expect(attr(tag, "type")).toBe("text");
    expect(attr(tag, "class")).toBe("cap-input");
    expect(attr(tag, "placeholder")).toBe("https://hooks.slack.com/services/...");
    expect(html).toMatch(new RegExp(`<label class="cap-field-label" for="${attr(tag, "id")}">Slack webhook URL</label>`));
    expect(text(html)).toContain("Get notified in Slack when payments are recovered");
  });

  it("draws each of Recova's four toggles as a Capsomer switch named and described by its row", () => {
    const html = render();
    for (const [name, label, help] of TOGGLES) {
      const tag = input(html, name);
      expect(attr(tag, "type"), name).toBe("checkbox");
      expect(attr(tag, "role"), name).toBe("switch");
      const labelledBy = attr(tag, "aria-labelledby") ?? "";
      const describedBy = attr(tag, "aria-describedby") ?? "";
      expect(html).toContain(`id="${labelledBy}">${label}<`);
      expect(html).toContain(`id="${describedBy}">${help}<`);
      // The switch sits in Capsomer's wrapper, which draws the track.
      expect(html).toMatch(new RegExp(`<label class="cap-switch">\\s*<input[^>]*name="${name}"`));
    }
  });

  it("shows each toggle's saved state, so the NULL map the loader applies is what renders", () => {
    const html = render();
    expect(input(html, "slackNotificationsEnabled")).not.toContain("checked");
    expect(input(html, "digestEnabled")).toContain("checked");
    expect(input(html, "recoveryNotificationsEnabled")).toContain("checked");
    expect(input(html, "sequenceCompleteNotificationsEnabled")).not.toContain("checked");
  });
});

describe("J39 notifications: the save bar", () => {
  it("sits under the card, outside it, with Recova's Save changes as the primary button", () => {
    const html = render();
    const after = html.slice(html.indexOf("</section>"));
    expect(after).toMatch(/<button[^>]*type="submit"[^>]*>Save changes<\/button>/);
    const button = after.match(/<button[^>]*>Save changes<\/button>/)?.[0] ?? "";
    expect(button).toContain('class="cap-btn"');
    expect(button).toContain('data-variant="primary"');
    // Recova's SaveBar is right-aligned under the card.
    expect(after).toMatch(/class="[^"]*justify-end[^"]*"/);
  });

  it("says Saved beside the button after a save, as a Capsomer ok status in a live region", () => {
    const html = render({ actionData: { ok: true } });
    const bar = html.slice(html.indexOf("</section>"));
    expect(bar).toMatch(/role="status"[\s\S]*class="cap-status" data-tone="ok"[\s\S]*Saved/);
    expect(bar.indexOf("Saved")).toBeLessThan(bar.indexOf("Save changes"));
    expect(html).not.toContain("cap-alert");
  });

  it("says Recova's failure sentence beside the button when the save fails", () => {
    const html = render({ actionData: { ok: false, failed: true } });
    const bar = html.slice(html.indexOf("</section>"));
    expect(bar).toMatch(/class="cap-status" data-tone="crit"[\s\S]*Failed to save. Please try again./);
  });

  it("keeps the live region on the page before anything is said", () => {
    const html = render();
    const bar = html.slice(html.indexOf("</section>"));
    expect(bar).toContain('role="status"');
    expect(text(bar)).toBe("Save changes");
  });

  it("puts a refused webhook beside the webhook field, not in a banner over the card", () => {
    const html = render({ actionData: { ok: false, error: SLACK_WEBHOOK_ERROR, field: "slackWebhookUrl" } });
    const tag = input(html, "slackWebhookUrl");
    expect(attr(tag, "aria-invalid")).toBe("true");
    const errorId = (attr(tag, "aria-describedby") ?? "").split(" ")[0];
    expect(html).toContain(`id="${errorId}" role="alert">${SLACK_WEBHOOK_ERROR}</p>`);
    expect(html).not.toContain("cap-alert");
  });
});

describe("J39 notifications: the look comes from Capsomer and the tokens", () => {
  it("has no amber and no hand-sized text", () => {
    expect(CODE).not.toMatch(/amber/i);
    expect(CODE).not.toMatch(/text-\[/);
  });

  it("styles no Capsomer component with Foxhound classes of its own", () => {
    for (const m of CODE.matchAll(/className="(cap-[^"]*)"/g)) {
      for (const cls of m[1].split(/\s+/)) expect(cls).toMatch(/^cap-/);
    }
  });

  it("uses the shared settings back link, not a local copy", () => {
    expect(SOURCE).toContain('import { SettingsBackLink } from "~/components/settings-back-link";');
    expect(CODE).not.toMatch(/function SettingsBackLink/);
  });

  it("no longer uses the auth screens' Alert and Submit", () => {
    expect(CODE).not.toContain("~/components/auth-ui");
  });

  it("loads each Capsomer stylesheet it uses", () => {
    for (const css of ["page-head", "panel", "field", "switch", "button", "status"]) {
      expect(SOURCE).toContain(`import "capsomer/${css}.css";`);
    }
  });
});

// ---------------------------------------------------------------------------
// The help sentence is true only while every sender skips a NULL address. If a
// sender gains a fallback, this fails, and the page's sentence must change too.
// ---------------------------------------------------------------------------

describe("J39 notifications: the blank-box sentence matches the senders", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it("the payment recovered and sequence complete notices skip a NULL address", () => {
    for (const p of [
      "app/lib/recovery/merchant-notification.server.ts",
      "app/lib/recovery/sequence-complete-notification.server.ts",
    ]) {
      expect(read(p), p).toContain('if (!account.notificationEmail) return { skipped: "no_recipient" };');
    }
  });

  it("the weekly digest drops accounts with a NULL address", () => {
    expect(read("app/lib/cron/digest.ts")).toContain("a.notificationEmail !== null");
  });

  it("the page says so", () => {
    expect(SOURCE).toContain(BLANK_SENDS_NOTHING);
  });
});

// ---------------------------------------------------------------------------
// The loader and the action.
// ---------------------------------------------------------------------------

const ACCOUNT = "acct_1";
let sqlite: Database.Database;

function ctx() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
          memberships: [{ memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" }],
          activeAccountId: ACCOUNT,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

async function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return (await route.action({
    context: ctx(),
    request: new Request("https://x/settings/notifications", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
}

describe("J39 notifications: the loader and the action", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills a NULL notification email with the signed-in email, as Recova does, so the first Save stores it", async () => {
    // Recova's `notification_email ?? user.email`. The box is truthful because
    // Save writes what it shows.
    const loaded = (await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never)) as {
      notificationEmail: string;
    };
    expect(loaded.notificationEmail).toBe("owner@acme.test");
  });

  it("shows a stored notification email as it is", async () => {
    sqlite.prepare("UPDATE accounts SET notification_email = 'ops@acme.test' WHERE id = ?").run(ACCOUNT);
    const loaded = (await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never)) as {
      notificationEmail: string;
    };
    expect(loaded.notificationEmail).toBe("ops@acme.test");
  });

  it("names the webhook field on a refused webhook, so the page can put the error beside it", async () => {
    const res = await post({ notificationEmail: "ops@acme.test", slackWebhookUrl: "https://evil.test/x" });
    expect(res.init?.status).toBe(400);
    expect(res.data).toEqual({ ok: false, error: SLACK_WEBHOOK_ERROR, field: "slackWebhookUrl" });
  });

  it("answers a failed write with Recova's failure state rather than an error page", async () => {
    harness.db = new Proxy(
      {},
      {
        get() {
          throw new Error("D1 unavailable");
        },
      },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ notificationEmail: "ops@acme.test", digestEnabled: "on" });
    expect(res.init?.status).toBe(500);
    expect(res.data).toEqual({ ok: false, failed: true });
    // The whole error, stack included, so a D1 failure can be traced in tail.
    const err = logged.mock.calls[0]?.[1];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("D1 unavailable");
  });
});
