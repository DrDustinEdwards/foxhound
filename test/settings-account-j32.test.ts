import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J32 (job_54cb0e7420dc), row S27, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/account is Recova's signed-in page, read whole at HEAD:
//   settings/account/page.tsx               blob b42f9159  1,661 bytes
//   settings/account/AccountProfileForm.tsx blob 85bd1a33    863 bytes
//   settings/components/AccountNameSection.tsx    blob bb58b169    875 bytes
//   settings/components/AccountProfileSection.tsx blob 13a68d29  3,318 bytes
//   settings/components/AppearanceSection.tsx     blob a687d482    503 bytes
//   settings/components/AccountSection.tsx        blob a154ac8f  3,839 bytes
// with SaveBar.tsx (blob f1d6eb23), ThemeToggle.tsx (blob 8f32b6c7) and
// settings/update/route.ts (blob 878c0637), built from Capsomer 0.9.0's
// components, teal throughout. Recova is the spec for every field, label,
// help line and their order. The approved differences stay: Cancel account
// keeps billing records (APPROVED-DIFFERENCES 2026-09-19), Delete account keeps
// the fee evidence (Q14, S40), and Sign out is a button that posts (2026-09-19).
//
// Every assertion here was seen failing against the page before the rebuild.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/account");
const { MRR_ERROR } = await import("~/lib/settings/apply.server");

const SOURCE = readFileSync(new URL("../app/routes/app/settings/account.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

interface RenderOpts {
  name?: string | null;
  industry?: string | null;
  customerType?: string | null;
  mrrCents?: number | null;
  cancelledAt?: Date | null;
  theme?: "dark" | "light";
  actionData?: Record<string, unknown>;
}

function render(opts: RenderOpts = {}): string {
  const loaderData = {
    account: {
      name: opts.name === undefined ? "Acme Inc" : opts.name,
      merchantIndustry: opts.industry ?? null,
      primaryCustomerType: opts.customerType ?? null,
      merchantMrrSelfReported: opts.mrrCents ?? null,
    },
    cancelledAt: opts.cancelledAt ?? null,
    userEmail: "owner@acme.test",
    ownedAccountNames: ["Acme Inc"],
    theme: opts.theme ?? "dark",
  };
  const Stub = createRoutesStub([
    {
      path: "/settings/account",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/account"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function tagByName(html: string, element: string, name: string): string {
  return html.match(new RegExp(`<${element}[^>]*\\sname="${name}"[^>]*>`))?.[0] ?? "";
}

function byId(html: string, id: string): string {
  const open = html.match(new RegExp(`<(\\w+)[^>]*\\sid="${id}"[^>]*>`));
  if (!open) return "";
  const start = (open.index ?? 0) + open[0].length;
  const close = html.indexOf(`</${open[1]}>`, start);
  return text(html.slice(start, close));
}

/** The text a control's aria-describedby points at, joined. */
function described(html: string, tag: string): string {
  return (attr(tag, "aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => byId(html, id))
    .join(" ")
    .trim();
}

function labelFor(html: string, tag: string): string {
  const id = attr(tag, "id") ?? "none";
  const m = html.match(new RegExp(`<label[^>]*\\sfor="${id}"[^>]*>([\\s\\S]*?)</label>`));
  return m ? text(m[1]) : "";
}

describe("J32 account: the page head", () => {
  it("is Capsomer's PageHead with Recova's title and line", () => {
    const html = render();
    expect(html).toMatch(/<h1 class="cap-page-head-title">My account<\/h1>/);
    expect(html).toMatch(/<p class="cap-page-head-lead">Profile, appearance, and account controls\.<\/p>/);
  });

  it("opens with Recova's phone-only back link to the settings hub", () => {
    const html = render();
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain("md:hidden");
    expect(text(link)).toBe("Settings");
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("cap-page-head-title"));
  });
});

describe("J32 account: Recova's order", () => {
  it("runs name, industry, customer type, MRR, save, appearance, then the account card with its danger zone", () => {
    const t = text(render());
    const order = [
      "Account name",
      "Industry",
      "Customer Type",
      "Monthly Recurring Revenue",
      "Save changes",
      "Choose how Foxhound looks.",
      "owner@acme.test",
      "Sign out",
      "Danger zone",
      "Delete account",
    ].map((s) => t.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("draws each of Recova's four cards as a Capsomer panel", () => {
    expect((render().match(/<section class="cap-panel">/g) ?? []).length).toBe(4);
  });
});

describe("J32 account: the profile form", () => {
  it("is ONE form with ONE save, as Recova's AccountProfileForm is", () => {
    const html = render();
    const forms = html.match(/<form[\s\S]*?<\/form>/g) ?? [];
    const profile = forms.find((f) => f.includes('name="name"')) ?? "";
    for (const name of ["name", "merchantIndustry", "primaryCustomerType", "merchantMrrSelfReported"]) {
      expect(profile, name).toContain(`name="${name}"`);
    }
    expect(profile).toMatch(/<input type="hidden" name="_action" value="profile"\/>/);
    const submits = profile.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(submits).toHaveLength(1);
    expect(text(submits[0])).toBe("Save changes");
    expect(submits[0]).toContain('data-variant="primary"');
  });

  it("has Recova's account name field: label, example, and help under it", () => {
    const html = render({ name: "Acme Inc" });
    const input = tagByName(html, "input", "name");
    expect(input).toContain('class="cap-input"');
    expect(attr(input, "type")).toBe("text");
    expect(attr(input, "placeholder")).toBe("e.g. Acme Inc");
    expect(attr(input, "value")).toBe("Acme Inc");
    expect(labelFor(html, input)).toBe("Account name");
    expect(described(html, input)).toBe("Your business or product name");
    expect(html.indexOf(input)).toBeLessThan(html.indexOf("Your business or product name"));
  });

  it("offers Recova's ten industries as a Capsomer select, in Recova's order", () => {
    const html = render({ industry: "Healthcare" });
    const select = html.match(/<select[^>]*name="merchantIndustry"[\s\S]*?<\/select>/)?.[0] ?? "";
    expect(select).toContain('class="cap-select"');
    expect(labelFor(html, select)).toBe("Industry");
    const options = [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [
      m[1].replace(/&amp;/g, "&"),
      m[2].replace(/&amp;/g, "&"),
    ]);
    expect(options).toEqual([
      ["", "Select an industry"],
      ["SaaS", "SaaS"],
      ["E-commerce", "E-commerce"],
      ["Marketing & Agencies", "Marketing & Agencies"],
      ["Healthcare", "Healthcare"],
      ["Education", "Education"],
      ["Professional Services", "Professional Services"],
      ["Finance", "Finance"],
      ["Real Estate", "Real Estate"],
      ["Media & Publishing", "Media & Publishing"],
      ["Other", "Other"],
    ]);
    expect(select).toMatch(/<option value="Healthcare" selected="">/);
  });

  it("keeps an industry stored outside Recova's list, so a save does not erase it", () => {
    // The merchant's agent tool takes free text through the same apply layer.
    const html = render({ industry: "Veterinary" });
    const select = html.match(/<select[^>]*name="merchantIndustry"[\s\S]*?<\/select>/)?.[0] ?? "";
    expect(select).toMatch(/<option value="Veterinary" selected="">Veterinary<\/option>/);
    expect(render({ industry: "SaaS" })).not.toContain("Veterinary");
  });

  it("asks Customer Type as Recova's two radios in a named group", () => {
    const html = render({ customerType: "B2C" });
    expect(html).toMatch(/<fieldset class="cap-field"><legend class="cap-field-label">Customer Type<\/legend>/);
    const radios = [...html.matchAll(/<input[^>]*name="primaryCustomerType"[^>]*>/g)].map((m) => m[0]);
    expect(radios.map((r) => attr(r, "value"))).toEqual(["B2B", "B2C"]);
    for (const r of radios) expect(attr(r, "type")).toBe("radio");
    expect(radios[0]).not.toMatch(/\schecked=""/);
    expect(radios[1]).toMatch(/\schecked=""/);
    expect((html.match(/<label class="cap-check">/g) ?? []).length).toBe(2);
  });

  it("has Recova's MRR field: a number with a dollar sign inside, and the help under it", () => {
    const html = render({ mrrCents: 500_000 });
    const input = tagByName(html, "input", "merchantMrrSelfReported");
    expect(attr(input, "type")).toBe("number");
    expect(attr(input, "min")).toBe("0");
    expect(attr(input, "placeholder")).toBe("0");
    // Recova shows String(cents / 100): 5000, not 5000.00.
    expect(attr(input, "value")).toBe("5000");
    expect(labelFor(html, input)).toBe("Monthly Recurring Revenue");
    expect(html).toMatch(/<div class="cap-input-group"[\s\S]*?<span class="cap-input-group-text">\$<\/span>/);
    expect(described(html, input)).toBe("Used to personalize recovery emails.");
    expect(attr(render({ mrrCents: 4_999 }).match(/<input[^>]*name="merchantMrrSelfReported"[^>]*>/)?.[0] ?? "", "value")).toBe("49.99");
    expect(attr(tagByName(render({ mrrCents: null }), "input", "merchantMrrSelfReported"), "value")).toBe("");
  });

  it("drops the old copy that promised risk scoring the engine does not do", () => {
    expect(text(render())).not.toMatch(/risk scoring/i);
  });
});

describe("J32 account: Recova's save bar", () => {
  it("says nothing before a save", () => {
    // "Saved to your account" is the appearance line, so the bar is checked by
    // its status element, not by the word.
    const html = render();
    expect(html).not.toContain('class="cap-status"');
    expect(text(html)).not.toContain("Failed to save");
  });

  it("says Saved beside the button after a save", () => {
    const html = render({ actionData: { action: "profile", ok: true } });
    expect(html).toMatch(/<span class="cap-status" data-tone="ok">[\s\S]*?Saved<\/span>/);
  });

  it("says Recova's failure line when the write fails", () => {
    const html = render({ actionData: { action: "profile", ok: false } });
    expect(html).toMatch(/<span class="cap-status" data-tone="crit">[\s\S]*?Failed to save\. Please try again\.<\/span>/);
  });

  it("puts a refusal beside the field it is about", () => {
    const html = render({
      actionData: { action: "profile", ok: false, error: MRR_ERROR, field: "merchantMrrSelfReported" },
    });
    const input = tagByName(html, "input", "merchantMrrSelfReported");
    expect(attr(input, "aria-invalid")).toBe("true");
    expect(described(html, input)).toContain(MRR_ERROR);
    expect(text(html)).not.toContain("Failed to save");
  });
});

describe("J32 account: appearance", () => {
  it("says Recova's line in Foxhound's name, and it is true: the choice is stored on the account", () => {
    const t = text(render());
    expect(t).toContain("Choose how Foxhound looks. Saved to your account and synced across devices.");
    expect(t).not.toContain("Recova");
  });

  it("offers Recova's two themes, dark first, as a Capsomer segmented control named Theme", () => {
    const html = render({ theme: "light" });
    expect(html).toMatch(/<fieldset class="cap-seg"><legend class="cap-sr-only">Theme<\/legend>/);
    const seg = html.match(/<fieldset class="cap-seg">[\s\S]*?<\/fieldset>/)?.[0] ?? "";
    const radios = [...seg.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios.map((r) => attr(r, "value"))).toEqual(["dark", "light"]);
    expect(text(seg)).toBe("Theme Dark Light");
    expect(radios[1]).toMatch(/\schecked=""/);
    expect(radios[0]).not.toMatch(/\schecked=""/);
  });

  it("saves through the account's theme route and says Recova's line when that fails", () => {
    expect(CODE).toContain('fetch("/api/theme"');
    expect(CODE).toContain("Failed to save theme. Please try again.");
  });
});

describe("J32 account: the account card", () => {
  it("shows the signed-in address with Sign out, a button posting to /logout", () => {
    const html = render();
    const form = html.match(/<form[^>]*action="\/logout"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(attr(form.match(/<form[^>]*>/)?.[0] ?? "", "method")).toBe("post");
    expect(text(form)).toBe("Sign out");
    expect(form).toContain('class="cap-btn"');
  });

  it("holds the danger zone in the same card, below a rule, with its controls at the right", () => {
    const html = render();
    const card = html.slice(html.lastIndexOf('<section class="cap-panel">'));
    expect(text(card)).toMatch(/^owner@acme\.test Sign out Danger zone/);
  });

  it("asks before cancelling, as Recova asks before deleting: no confirmation is open at first", () => {
    const html = render();
    expect(text(html)).not.toContain("Are you sure?");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Cancel account<\/button>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Delete account<\/button>/);
  });

  it("keeps the approved Cancel account words about fees", () => {
    expect(SOURCE).toContain("Fees on recoveries Foxhound has already attributed remain owed and are still invoiced.");
    const cancelled = text(render({ cancelledAt: new Date(0) }));
    expect(cancelled).toContain("This account is cancelled.");
    expect(cancelled).not.toContain("Cancel account");
  });
});

describe("J32 account: the look comes from Capsomer and the tokens", () => {
  it("has no amber and no hand-sized text", () => {
    expect(CODE).not.toMatch(/amber/i);
    expect(CODE).not.toMatch(/text-\[/);
  });

  it("styles no Capsomer component with Foxhound classes of its own", () => {
    for (const m of CODE.matchAll(/className="(cap-[^"]*)"/g)) {
      for (const cls of m[1].split(/\s+/)) expect(cls).toMatch(/^cap-/);
    }
  });

  it("uses no Foxhound part where Capsomer has one", () => {
    expect(CODE).not.toContain("~/components/auth-ui");
    expect(CODE).not.toContain("~/components/settings-card");
  });

  it("loads each Capsomer stylesheet it uses", () => {
    for (const css of ["page-head", "panel", "field", "select", "segmented", "button", "status", "banner"]) {
      expect(SOURCE).toContain(`import "capsomer/${css}.css";`);
    }
  });
});

// ---------------------------------------------------------------------------
// The action: Recova's one profile save, through Foxhound's engine.
// ---------------------------------------------------------------------------

function ctx() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          email: "owner@acme.test",
          membership: { memberId: "m1", accountId: "acct_1", accountName: "Acme Inc", role: "owner" },
          memberships: [{ memberId: "m1", accountId: "acct_1", accountName: "Acme Inc", role: "owner" }],
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

type Result = { data: Record<string, unknown>; init?: { status?: number } };

async function post(fields: Record<string, string>): Promise<Result> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return (await route.action({
    context: ctx(),
    request: new Request("https://foxhoundapp.test/settings/account", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as Result;
}

describe("J32 account: one save writes the name and the three context fields", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite
      .prepare(
        "INSERT INTO accounts (id, name, merchant_industry, primary_customer_type, merchant_mrr_self_reported, created_at, billing_exempt) VALUES (?, ?, ?, ?, ?, 0, 0)",
      )
      .run("acct_1", "Old Name", "Finance", "B2C", 100);
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, 0, 0)")
      .run("acct_other", "Other Co");
  });

  const row = (id = "acct_1") =>
    sqlite
      .prepare(
        "SELECT name, merchant_industry AS industry, primary_customer_type AS type, merchant_mrr_self_reported AS mrr FROM accounts WHERE id = ?",
      )
      .get(id) as { name: string; industry: string | null; type: string | null; mrr: number | null };

  it("writes all four from one post, MRR in cents, and touches no other account", async () => {
    const res = await post({
      _action: "profile",
      name: "Acme Inc",
      merchantIndustry: "SaaS",
      primaryCustomerType: "B2B",
      merchantMrrSelfReported: "5000",
    });
    expect(res.data).toEqual({ action: "profile", ok: true });
    expect(row()).toEqual({ name: "Acme Inc", industry: "SaaS", type: "B2B", mrr: 500_000 });
    expect(row("acct_other").name).toBe("Other Co");
  });

  it("clears the select and the MRR to NULL when they are blank, as Recova's `|| null` does", async () => {
    await post({ _action: "profile", name: "Acme Inc", merchantIndustry: "", merchantMrrSelfReported: "" });
    expect(row().industry).toBeNull();
    expect(row().mrr).toBeNull();
  });

  it("leaves Customer Type alone when no radio is chosen, as Recova's formData.has does", async () => {
    await post({ _action: "profile", name: "Acme Inc", merchantIndustry: "SaaS", merchantMrrSelfReported: "" });
    expect(row().type).toBe("B2C");
  });

  it("refuses a bad MRR beside the field and writes nothing at all", async () => {
    const res = await post({
      _action: "profile",
      name: "New Name",
      merchantIndustry: "SaaS",
      primaryCustomerType: "B2B",
      merchantMrrSelfReported: "-5",
    });
    expect(res.init?.status).toBe(400);
    expect(res.data).toEqual({ action: "profile", ok: false, error: MRR_ERROR, field: "merchantMrrSelfReported" });
    expect(row()).toEqual({ name: "Old Name", industry: "Finance", type: "B2C", mrr: 100 });
  });

  it("refuses an empty name beside the field and writes nothing at all", async () => {
    const res = await post({ _action: "profile", name: "  ", merchantIndustry: "SaaS", merchantMrrSelfReported: "1" });
    expect(res.init?.status).toBe(400);
    expect(res.data).toMatchObject({ action: "profile", ok: false, field: "name" });
    expect(row()).toEqual({ name: "Old Name", industry: "Finance", type: "B2C", mrr: 100 });
  });
});

describe("J32 account: a failed save", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Recova's failure state rather than throwing, and logs the thrown error whole", async () => {
    const thrown = new Error("D1 unavailable");
    harness.db = new Proxy(
      {},
      {
        get() {
          throw thrown;
        },
      },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({
      _action: "profile",
      name: "Acme Inc",
      merchantIndustry: "SaaS",
      merchantMrrSelfReported: "10",
    });
    expect(res.data).toEqual({ action: "profile", ok: false });
    expect(res.init?.status).toBe(500);
    // The error object itself, so its stack reaches the log, not only its message.
    expect(logged).toHaveBeenCalledWith("account settings write failed:", thrown);
  });

  it("and that result renders Recova's failure line", () => {
    // The exact object the action returns above, rendered by the page.
    expect(text(render({ actionData: { action: "profile", ok: false } }))).toContain(
      "Failed to save. Please try again.",
    );
  });
});
