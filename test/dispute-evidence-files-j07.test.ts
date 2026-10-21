import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Outlet, createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import { accounts, disputeApprovals, disputeEvidence, disputes } from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { applyCachePolicy } from "~/lib/http/cache-policy";
import {
  DISPUTE_EVIDENCE_ALLOWED_TYPES,
  DISPUTE_EVIDENCE_MAX_FILES,
  DISPUTE_EVIDENCE_MAX_SIZE_BYTES,
} from "~/lib/constants";
import type { DisputeSubmissionContext } from "~/lib/disputes/submission";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// J07 (job_7a7c09269012): merchant evidence files on R2, as Recova's
// components/disputes/DisputeFileUploads.tsx (1286eb21), app/api/disputes/
// upload-evidence/route.ts (7acca2a9), delete-evidence/route.ts (06a2cd1a),
// evidence-url/route.ts (57ccef71), submit/route.ts (6c21ef74), lib/r2.ts
// (3997617f), hooks/useDisputeActions.ts (b650cd6d) and lib/constants.ts's
// DISPUTE_EVIDENCE_* limits, read whole. The bucket binding is Dustin's
// (capsid/conventions.md 1.4), so every path is also tested with it absent.
// Every test here was seen failing: most against the bare stubs (PR body), and
// the rest against a planted break of the code they guard, recorded there too.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  submitted: [] as unknown[],
}));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/disputes/submission", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/disputes/submission")>();
  return {
    ...real,
    submitDisputeEvidence: async (_env: Env, ctx: DisputeSubmissionContext) => {
      harness.submitted.push(ctx);
      return { ok: true };
    },
  };
});

const detail = await import("~/routes/app/disputes/detail");
const fileRoute = await import("~/routes/app/disputes/file");
const { approveAndSubmitDispute, getDisputeDetail, getDisputesWithEvidence } = await import(
  "~/lib/disputes/queries.server"
);
const { submitDisputeEvidenceWithClient } = await import("~/lib/disputes/submission");
const { deleteEvidenceFile, readEvidenceFilesForSubmission, uploadEvidenceFile } = await import(
  "~/lib/disputes/evidence-files.server"
);
const Page = detail.default as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>;

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 86_400_000;
const A = "acct_alpha";
const B = "acct_beta";

// ---- A fake R2 bucket: the slice of R2Bucket the code uses ----

interface Stored {
  bytes: Uint8Array;
  contentType: string | undefined;
}
function fakeBucket(opts: { failPut?: boolean; onPut?: () => void } = {}) {
  const objects = new Map<string, Stored>();
  const bucket = {
    objects,
    async put(key: string, value: ArrayBuffer | Uint8Array, o?: { httpMetadata?: { contentType?: string } }) {
      if (opts.failPut) throw new Error("r2 down");
      // Lets a test act between the checks before the write and the write.
      opts.onPut?.();
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, { bytes, contentType: o?.httpMetadata?.contentType });
      return { key };
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        key,
        size: o.bytes.byteLength,
        httpMetadata: { contentType: o.contentType },
        body: new Response(o.bytes as unknown as BodyInit).body,
        arrayBuffer: async () => o.bytes.slice().buffer,
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return bucket;
}
type FakeBucket = ReturnType<typeof fakeBucket>;

function envWith(bucket: FakeBucket | undefined): Env {
  return (bucket ? { EVIDENCE: bucket } : {}) as unknown as Env;
}

function contextFor(accountId: string, env: Env, isDemo = false): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) {
        return { env, ctx: { waitUntil() {} } as unknown as ExecutionContext, nonce: "n" };
      }
      if (key === authContext) {
        return {
          userId: "u",
          userName: "u",
          email: "owner@alpha.test",
          membership: { memberId: "m", accountId, accountName: "Alpha", role: "owner" },
          memberships: [],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

// ---- Files ----

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const PDF = [...new TextEncoder().encode("%PDF-1.4\n")];

function fileOf(head: number[], name: string, type: string, size = 64): File {
  const bytes = new Uint8Array(Math.max(size, head.length));
  bytes.set(head, 0);
  return new File([bytes], name, { type });
}

// ---- Database ----

let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];
let db: Db;

function seedDispute(over: Partial<typeof disputes.$inferInsert> = {}): string {
  const id = over.id ?? "dsp_1";
  runStatement(
    sqlite,
    db.insert(disputes).values({
      id,
      accountId: A,
      stripeDisputeId: `dp_${id}`,
      stripeChargeId: `ch_${id}`,
      stripeCustomerId: "cus_1",
      customerEmail: "jordan@example.com",
      customerName: "Jordan Lee",
      amountCents: 12_000,
      currency: "usd",
      reason: "product_not_received",
      status: "needs_response",
      evidenceDeadline: new Date(NOW + 9 * DAY),
      createdAt: new Date(NOW - 2 * DAY),
      state: "pending_review",
      ...over,
    }),
  );
  return id;
}

function seedEvidence(id: string, fieldName: string, fieldValue: string, over: Partial<typeof disputeEvidence.$inferInsert> = {}) {
  runStatement(
    sqlite,
    db.insert(disputeEvidence).values({
      id,
      disputeId: "dsp_1",
      accountId: A,
      fieldName,
      fieldValue,
      createdAt: new Date(NOW - DAY),
      ...over,
    }),
  );
}

function seedApproval(): void {
  runStatement(
    sqlite,
    db.insert(disputeApprovals).values({
      id: "ap_1",
      disputeId: "dsp_1",
      accountId: A,
      approvedByUserId: "u",
      approvedByEmail: "owner@alpha.test",
      evidenceVersionHash: "h",
      approvedAt: new Date(NOW - 1000),
    }),
  );
}

const fileRows = () =>
  sqlite
    .prepare("select id, account_id, dispute_id, field_value from dispute_evidence where field_name = 'file_upload' order by created_at, id")
    .all() as { id: string; account_id: string; dispute_id: string; field_value: string }[];

// ---- Calling the routes ----

async function post(
  form: FormData,
  opts: { accountId?: string; bucket?: FakeBucket; id?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = opts.id ?? "dsp_1";
  try {
    const result = await detail.action({
      context: contextFor(opts.accountId ?? A, envWith(opts.bucket)),
      request: new Request(`https://foxhoundapp.test/disputes/${id}`, { method: "POST", body: form, headers: opts.headers }),
      params: { id },
    } as never);
    const r = result as { init?: { status?: number }; data?: unknown };
    return { status: r.init?.status ?? 200, body: (r.data ?? result) as Record<string, unknown> };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, body: {} };
    throw thrown;
  }
}

function uploadForm(file: File | null): FormData {
  const form = new FormData();
  form.set("intent", "upload_file");
  if (file) form.set("file", file);
  return form;
}

function deleteForm(evidenceId: string): FormData {
  const form = new FormData();
  form.set("intent", "delete_file");
  form.set("evidence_id", evidenceId);
  return form;
}

async function view(
  fileId: string,
  opts: { accountId?: string; bucket?: FakeBucket; id?: string } = {},
): Promise<Response> {
  const id = opts.id ?? "dsp_1";
  try {
    return (await fileRoute.loader({
      context: contextFor(opts.accountId ?? A, envWith(opts.bucket)),
      request: new Request(`https://foxhoundapp.test/disputes/${id}/files/${fileId}`),
      params: { id, fileId },
    } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function render(opts: { bucket?: FakeBucket; isDemo?: boolean } = {}): Promise<string> {
  const loaderData = await detail.loader({
    context: contextFor(A, envWith(opts.bucket), opts.isDemo),
    request: new Request("https://foxhoundapp.test/disputes/dsp_1"),
    params: { id: "dsp_1" },
  } as never);
  const Stub = createRoutesStub([
    {
      id: "app-shell",
      path: "/",
      Component: () => createElement(Outlet),
      children: [{ path: "disputes/:id", Component: () => createElement(Page, { loaderData }) }],
    },
  ] as never);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/disputes/dsp_1"],
      hydrationData: { loaderData: { "app-shell": { isDemo: Boolean(opts.isDemo) } } },
    } as never),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.submitted = [];
  runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
  runStatement(sqlite, db.insert(accounts).values({ id: B, name: "Beta" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- Recova's limits ----

describe("J07: Recova's limits from lib/constants.ts", () => {
  it("allows five files of 5 MB each, JPG, PNG or PDF", () => {
    expect(DISPUTE_EVIDENCE_MAX_FILES).toBe(5);
    expect(DISPUTE_EVIDENCE_MAX_SIZE_BYTES).toBe(5 * 1024 * 1024);
    expect([...DISPUTE_EVIDENCE_ALLOWED_TYPES]).toEqual(["image/jpeg", "image/png", "application/pdf"]);
  });
});

// ---- Upload ----

describe("J07: upload (Recova's upload-evidence route)", () => {
  it("stores the file in the bucket under the account and dispute, and records it", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const res = await post(uploadForm(fileOf(PNG, "Receipt.PNG", "image/png")), { bucket });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: "upload_file", fileOutcome: "uploaded" });
    const rows = fileRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: A, dispute_id: "dsp_1" });
    expect(rows[0]!.field_value).toMatch(/^acct_alpha\/dsp_1\/[0-9a-f-]{36}\.png$/);
    expect([...bucket.objects.keys()]).toEqual([rows[0]!.field_value]);
    expect(bucket.objects.get(rows[0]!.field_value)!.contentType).toBe("image/png");
  });

  it("refuses an upload to another account's dispute, storing nothing", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const res = await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket, accountId: B });
    expect(res.status).toBe(404);
    expect(fileRows()).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("the insert itself refuses another account's dispute, and leaves no object behind", async () => {
    // Below the route's account-scoped read: the guard joined to the write.
    seedDispute();
    const bucket = fakeBucket();
    const outcome = await uploadEvidenceFile(db, bucket as unknown as R2Bucket, {
      accountId: B,
      disputeId: "dsp_1",
      file: fileOf(PNG, "r.png", "image/png"),
      now: new Date(NOW),
    });
    expect(outcome).toBe("not_saved");
    expect(fileRows()).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses a file over 5 MB with file_too_large, storing nothing", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const big = fileOf(PNG, "big.png", "image/png", DISPUTE_EVIDENCE_MAX_SIZE_BYTES + 1);
    const res = await post(uploadForm(big), { bucket });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ fileOutcome: "file_too_large", error: "Files must be 5 MB or smaller." });
    expect(fileRows()).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("takes a file of exactly 5 MB", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const res = await post(uploadForm(fileOf(PDF, "edge.pdf", "application/pdf", DISPUTE_EVIDENCE_MAX_SIZE_BYTES)), { bucket });
    expect(res.body).toMatchObject({ fileOutcome: "uploaded" });
  });

  it("refuses a request body far over the limit before reading it, with 413", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const res = await post(uploadForm(fileOf(PNG, "r.png", "image/png")), {
      bucket,
      headers: { "content-length": String(50 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ fileOutcome: "file_too_large" });
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses a type outside JPG, PNG and PDF with file_type_not_allowed, storing nothing", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const res = await post(uploadForm(new File(["<html><script>1</script></html>"], "x.html", { type: "text/html" })), { bucket });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ fileOutcome: "file_type_not_allowed", error: "Only JPG, PNG, or PDF files are allowed." });
    expect(fileRows()).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses a file whose bytes are not the type it claims", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const res = await post(uploadForm(new File(["<html>not a png</html>"], "fake.png", { type: "image/png" })), { bucket });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ fileOutcome: "file_type_not_allowed" });
    expect(bucket.objects.size).toBe(0);
  });

  it("accepts each allowed type", async () => {
    seedDispute();
    const bucket = fakeBucket();
    for (const f of [fileOf(JPG, "a.jpg", "image/jpeg"), fileOf(PNG, "b.png", "image/png"), fileOf(PDF, "c.pdf", "application/pdf")]) {
      const res = await post(uploadForm(f), { bucket });
      expect(res.body, f.name).toMatchObject({ fileOutcome: "uploaded" });
    }
    expect(fileRows()).toHaveLength(3);
  });

  it("refuses a sixth file with Recova's line", async () => {
    seedDispute();
    const bucket = fakeBucket();
    for (let i = 0; i < DISPUTE_EVIDENCE_MAX_FILES; i++) {
      expect((await post(uploadForm(fileOf(PNG, `f${i}.png`, "image/png")), { bucket })).body).toMatchObject({ fileOutcome: "uploaded" });
    }
    const res = await post(uploadForm(fileOf(PNG, "f6.png", "image/png")), { bucket });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ fileOutcome: "max_files_exceeded", error: "Maximum 5 files per dispute." });
    expect(fileRows()).toHaveLength(5);
    expect(bucket.objects.size).toBe(5);
  });

  it("refuses an upload with no file", async () => {
    seedDispute();
    const res = await post(uploadForm(null), { bucket: fakeBucket() });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ fileOutcome: "file_required" });
  });

  it("refuses an upload once the evidence is approved, since the approval attests it", async () => {
    seedDispute();
    seedApproval();
    const bucket = fakeBucket();
    const res = await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ fileOutcome: "evidence_locked" });
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses an upload on a submitted dispute", async () => {
    seedDispute({ state: "submitted", submittedAt: new Date(NOW - DAY) });
    const res = await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket: fakeBucket() });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ fileOutcome: "evidence_locked" });
  });

  it("answers 500 upload_failed and records nothing when the bucket refuses the write", async () => {
    seedDispute();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket: fakeBucket({ failPut: true }) });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ fileOutcome: "upload_failed" });
    expect(fileRows()).toHaveLength(0);
  });
});

// ---- Delete ----

describe("J07: delete (Recova's delete-evidence route)", () => {
  async function uploaded(bucket: FakeBucket): Promise<{ id: string; key: string }> {
    await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket });
    const row = fileRows()[0]!;
    return { id: row.id, key: row.field_value };
  }

  it("removes the object and its row", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const { id } = await uploaded(bucket);
    const res = await post(deleteForm(id), { bucket });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: "delete_file", fileOutcome: "deleted" });
    expect(fileRows()).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses to delete another account's file, leaving it whole", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const { id, key } = await uploaded(bucket);
    // Account B's own dispute, so the page read succeeds and the file id is the only foreign thing.
    seedDispute({ id: "dsp_b", accountId: B, stripeDisputeId: "dp_b", stripeChargeId: "ch_b" });
    const res = await post(deleteForm(id), { bucket, accountId: B, id: "dsp_b" });
    expect(res.status).toBe(404);
    expect(fileRows()).toHaveLength(1);
    expect(bucket.objects.has(key)).toBe(true);
  });

  it("refuses to delete a non-file evidence row through the file path", async () => {
    seedDispute();
    seedEvidence("ev_text", "product_description", "Growth plan");
    const res = await post(deleteForm("ev_text"), { bucket: fakeBucket() });
    expect(res.status).toBe(404);
    expect(sqlite.prepare("select count(*) as n from dispute_evidence where id = 'ev_text'").get()).toEqual({ n: 1 });
  });

  it("refuses a delete once the evidence is approved", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const { id } = await uploaded(bucket);
    seedApproval();
    const res = await post(deleteForm(id), { bucket });
    expect(res.status).toBe(409);
    expect(fileRows()).toHaveLength(1);
    expect(bucket.objects.size).toBe(1);
  });
});

// ---- View ----

describe("J07: view (Recova's evidence-url route, served by the Worker)", () => {
  it("serves an image in a sandboxed document", async () => {
    seedDispute();
    const bucket = fakeBucket();
    await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket });
    const res = await view(fileRows()[0]!.id, { bucket });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox; default-src 'none'/);
  });

  it("serves the account's own file privately, typed, never cached, locked down", async () => {
    seedDispute();
    const bucket = fakeBucket();
    await post(uploadForm(fileOf(PDF, "c.pdf", "application/pdf")), { bucket });
    const row = fileRows()[0]!;
    const res = await view(row.id, { bucket });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    // The one cache policy, applied on the way out, makes it private.
    const sent = applyCachePolicy(new Request(`https://foxhoundapp.test/disputes/dsp_1/files/${row.id}`), res);
    expect(sent.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // A PDF needs the browser's viewer, so no sandbox, but nothing else may load.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="${row.field_value.split("/").pop()}"`);
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 5)).toEqual(new Uint8Array(PDF.slice(0, 5)));
  });

  it("refuses another account's file with 404", async () => {
    seedDispute();
    const bucket = fakeBucket();
    await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket });
    const row = fileRows()[0]!;
    const res = await view(row.id, { bucket, accountId: B });
    expect(res.status).toBe(404);
  });

  it("refuses a file id under a different dispute of the same account", async () => {
    seedDispute();
    seedDispute({ id: "dsp_2", stripeDisputeId: "dp_2", stripeChargeId: "ch_2" });
    const bucket = fakeBucket();
    await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket });
    const res = await view(fileRows()[0]!.id, { bucket, id: "dsp_2" });
    expect(res.status).toBe(404);
  });
});

// ---- No binding yet ----

describe("J07: with no EVIDENCE binding, every path says so truthfully", () => {
  it("upload answers 503 uploads_unavailable and records nothing", async () => {
    seedDispute();
    const res = await post(uploadForm(fileOf(PNG, "r.png", "image/png")));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ fileOutcome: "uploads_unavailable" });
    expect(fileRows()).toHaveLength(0);
  });

  it("delete and view answer 503 uploads_unavailable", async () => {
    seedDispute();
    seedEvidence("ev_f", "file_upload", "acct_alpha/dsp_1/x.png");
    const del = await post(deleteForm("ev_f"));
    expect(del.status).toBe(503);
    expect(del.body).toMatchObject({ fileOutcome: "uploads_unavailable" });
    expect(fileRows()).toHaveLength(1);
    const res = await view("ev_f");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "uploads_unavailable" });
  });

  it("the section says uploads are not available yet and offers no upload control", async () => {
    seedDispute();
    const html = await render();
    const t = text(html);
    expect(t).toContain("Evidence files");
    expect(t).toContain("File uploads are not available yet.");
    expect(html).not.toContain('type="file"');
    expect(t).not.toContain("Upload file");
  });

  it("submission still goes ahead, without files", async () => {
    seedDispute();
    seedEvidence("ev_t", "product_description", "Growth plan");
    seedEvidence("ev_f", "file_upload", "acct_alpha/dsp_1/x.png");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = (await getDisputeDetail(db, A, "dsp_1"))!;
    const result = await approveAndSubmitDispute(db, envWith(undefined), approveInput(), d.evidence);
    expect(result).toEqual({ status: "submitted" });
    expect(harness.submitted).toHaveLength(1);
    const ctx = harness.submitted[0] as DisputeSubmissionContext;
    expect(ctx.evidence).toEqual({ product_description: "Growth plan" });
    expect(ctx.files ?? []).toEqual([]);
  });
});

// ---- The page ----

describe("J07: Recova's Evidence files section", () => {
  it("shows Recova's title, limits line, upload control and empty line, built from the constants", async () => {
    seedDispute();
    const html = await render({ bucket: fakeBucket() });
    const t = text(html);
    expect(t).toContain("Evidence files");
    expect(t).toContain("JPG, PNG, or PDF. 5 MB max. 5 files max per dispute.");
    expect(t).toContain("Upload file");
    expect(t).toContain("No files uploaded.");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,application\/pdf"/);
    expect(html).toMatch(/<form id="dispute-evidence-upload"[^>]*enctype="multipart\/form-data"/i);
  });

  it("lists each file by name and date with Remove file, linking to the account-scoped view", async () => {
    seedDispute();
    seedEvidence("ev_f", "file_upload", "acct_alpha/dsp_1/0f1e.png");
    const html = await render({ bucket: fakeBucket() });
    const t = text(html);
    expect(html).toContain('href="/disputes/dsp_1/files/ev_f"');
    expect(t).toContain("0f1e.png");
    expect(t).toContain("Oct 15, 2026");
    expect(t).toContain("Remove file");
  });

  it("drops the upload control at five files, as Recova does", async () => {
    seedDispute();
    for (let i = 0; i < 5; i++) seedEvidence(`ev_${i}`, "file_upload", `acct_alpha/dsp_1/${i}.png`);
    const html = await render({ bucket: fakeBucket() });
    expect(html).not.toContain('type="file"');
    expect(text(html)).toContain("Remove file");
  });

  it("shows the files read-only once approved", async () => {
    seedDispute();
    seedEvidence("ev_f", "file_upload", "acct_alpha/dsp_1/0f1e.png");
    seedApproval();
    const html = await render({ bucket: fakeBucket() });
    expect(text(html)).toContain("0f1e.png");
    expect(text(html)).not.toContain("Remove file");
    expect(html).not.toContain('type="file"');
  });

  it("shows no upload or remove control in the demo", async () => {
    seedDispute();
    seedEvidence("ev_f", "file_upload", "acct_alpha/dsp_1/0f1e.png");
    const html = await render({ bucket: fakeBucket(), isDemo: true });
    expect(html).not.toContain('type="file"');
    expect(text(html)).not.toContain("Remove file");
  });

  it("never lists a file as a staged evidence field", async () => {
    seedDispute();
    seedEvidence("ev_t", "product_description", "Growth plan");
    seedEvidence("ev_f", "file_upload", "acct_alpha/dsp_1/0f1e.png");
    const t = text(await render({ bucket: fakeBucket() }));
    expect(t).not.toContain("File upload");
    expect(t).not.toContain("acct_alpha/dsp_1/0f1e.png");
  });

  it("sits between Staged evidence and Additional evidence, as Recova's section 6", async () => {
    seedDispute();
    seedEvidence("ev_t", "product_description", "Growth plan");
    const t = text(await render({ bucket: fakeBucket() }));
    const order = ["Staged evidence", "Evidence files", "Additional evidence (optional)"].map((s) => t.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps the upload form outside the draft form (no nested forms)", () => {
    const source = readFileSync("app/components/dispute-detail-parts.tsx", "utf8");
    expect(source).toContain("EVIDENCE_UPLOAD_FORM_ID");
  });
});

// ---- The disputes list ----

describe("J07: a file alone does not make Recova's 'Evidence ready'", () => {
  it("counts only drafted evidence fields, never uploaded files", async () => {
    seedDispute();
    seedEvidence("ev_f", "file_upload", "acct_alpha/dsp_1/0f1e.png");
    expect([...(await getDisputesWithEvidence(db, A, ["dsp_1"]))]).toEqual([]);
  });
});

// ---- Submission ----

function approveInput() {
  return {
    disputeId: "dsp_1",
    accountId: A,
    stripeDisputeId: "dp_dsp_1",
    connectionAccessToken: "enc",
    approvedByUserId: "u",
    approvedByEmail: "owner@alpha.test",
    approvedAt: new Date(NOW),
  };
}

describe("J07: files go with the evidence submission (Recova's submit route)", () => {
  it("reads each file from the bucket, oldest first, for the submission", async () => {
    seedDispute();
    const bucket = fakeBucket();
    await post(uploadForm(fileOf(PNG, "r.png", "image/png")), { bucket });
    vi.setSystemTime(NOW + 1000);
    await post(uploadForm(fileOf(PDF, "c.pdf", "application/pdf")), { bucket });
    const d = (await getDisputeDetail(db, A, "dsp_1"))!;
    const result = await approveAndSubmitDispute(db, envWith(bucket), approveInput(), d.evidence);
    expect(result).toEqual({ status: "submitted" });
    const ctx = harness.submitted[0] as DisputeSubmissionContext;
    expect(ctx.files?.map((f) => f.contentType)).toEqual(["image/png", "application/pdf"]);
    expect(ctx.files?.[0]?.name).toBe(fileRows()[0]!.field_value.split("/").pop());
    expect(ctx.evidence).not.toHaveProperty("file_upload");
  });

  it("puts each file in Recova's slot order, and a file outranks a text field in its slot", async () => {
    const created: { purpose: string; file: { name: string; type: string } }[] = [];
    const updates: { id: string; params: { evidence: Record<string, string>; submit: boolean } }[] = [];
    const stripe = {
      files: {
        create: async (params: { purpose: string; file: { name: string; type: string } }) => {
          created.push(params);
          return { id: `file_${created.length}` };
        },
      },
      disputes: {
        update: async (id: string, params: { evidence: Record<string, string>; submit: boolean }) => {
          updates.push({ id, params });
          return {};
        },
      },
    } as unknown as Stripe;
    const files = ["a.png", "b.pdf", "c.png", "d.png", "e.jpg"].map((name) => ({
      name,
      contentType: name.endsWith(".pdf") ? "application/pdf" : "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    }));
    const result = await submitDisputeEvidenceWithClient(stripe, {
      stripeDisputeId: "dp_1",
      evidence: { product_description: "Widget", customer_communication: "3 emails sent" },
      files,
    });
    expect(result).toEqual({ ok: true });
    expect(created.map((c) => c.purpose)).toEqual(Array(5).fill("dispute_evidence"));
    expect(created.map((c) => c.file.name)).toEqual(["a.png", "b.pdf", "c.png", "d.png", "e.jpg"]);
    expect(updates[0]!.params).toEqual({
      evidence: {
        product_description: "Widget",
        receipt: "file_1",
        service_documentation: "file_2",
        shipping_documentation: "file_3",
        customer_communication: "file_4",
        uncategorized_file: "file_5",
      },
      submit: true,
    });
  });

  it("submits the rest when one file upload to Stripe fails, as Recova does", async () => {
    let n = 0;
    const updates: { evidence: Record<string, string> }[] = [];
    const stripe = {
      files: {
        create: async () => {
          n += 1;
          if (n === 1) throw new Error("stripe file rejected");
          return { id: `file_${n}` };
        },
      },
      disputes: { update: async (_id: string, params: { evidence: Record<string, string> }) => (updates.push(params), {}) },
    } as unknown as Stripe;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await submitDisputeEvidenceWithClient(stripe, {
      stripeDisputeId: "dp_1",
      evidence: { product_description: "Widget" },
      files: [
        { name: "a.png", contentType: "image/png", bytes: new Uint8Array([1]) },
        { name: "b.png", contentType: "image/png", bytes: new Uint8Array([2]) },
      ],
    });
    expect(result).toEqual({ ok: true });
    expect(updates[0]!.evidence).toEqual({ product_description: "Widget", service_documentation: "file_2" });
  });
});

// ---- The guards joined to the writes (RULES.md 3.9), past the route's reads ----

describe("J07 review: each write carries its own guard", () => {
  const upload = (bucket: FakeBucket) =>
    uploadEvidenceFile(db, bucket as unknown as R2Bucket, {
      accountId: A,
      disputeId: "dsp_1",
      file: fileOf(PNG, "r.png", "image/png"),
      now: new Date(NOW),
    });

  it("an upload writes nothing when an approval lands between its checks and its insert", async () => {
    seedDispute();
    const bucket = fakeBucket({ onPut: () => seedApproval() });
    expect(await upload(bucket)).toBe("not_saved");
    expect(fileRows()).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("an upload writes nothing when another takes the fifth place between its count and its insert", async () => {
    seedDispute();
    for (let i = 0; i < 4; i++) seedEvidence(`ev_${i}`, "file_upload", `acct_alpha/dsp_1/${i}.png`);
    const bucket = fakeBucket({ onPut: () => seedEvidence("ev_4", "file_upload", "acct_alpha/dsp_1/4.png") });
    expect(await upload(bucket)).toBe("not_saved");
    expect(fileRows()).toHaveLength(5);
    expect(bucket.objects.size).toBe(0);
  });

  it("a delete removes nothing once an approval exists", async () => {
    seedDispute();
    const bucket = fakeBucket();
    const key = "acct_alpha/dsp_1/kept.png";
    await bucket.put(key, new Uint8Array(PNG), { httpMetadata: { contentType: "image/png" } });
    seedEvidence("ev_kept", "file_upload", key);
    seedApproval();
    const outcome = await deleteEvidenceFile(db, bucket as unknown as R2Bucket, {
      accountId: A,
      disputeId: "dsp_1",
      evidenceId: "ev_kept",
    });
    expect(outcome).toBe("not_saved");
    expect(fileRows()).toHaveLength(1);
    expect(bucket.objects.has(key)).toBe(true);
  });
});

describe("J07 review: a file keeps its own Stripe slot when an earlier one is missing (Recova's slot i)", () => {
  it("reads the slots by the files' places in the list", async () => {
    const bucket = fakeBucket();
    await bucket.put("k/a.png", new Uint8Array(PNG), { httpMetadata: { contentType: "image/png" } });
    await bucket.put("k/c.pdf", new Uint8Array(PDF), { httpMetadata: { contentType: "application/pdf" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const files = await readEvidenceFilesForSubmission(bucket as unknown as R2Bucket, [
      { fieldName: "file_upload", fieldValue: "k/a.png" },
      { fieldName: "file_upload", fieldValue: "k/missing.png" },
      { fieldName: "file_upload", fieldValue: "k/c.pdf" },
    ]);
    expect(files.map((f) => [f.name, f.slot])).toEqual([
      ["a.png", 0],
      ["c.pdf", 2],
    ]);
  });

  it("submits a file in its own slot, leaving the missing one's slot empty", async () => {
    const updates: { evidence: Record<string, string> }[] = [];
    let n = 0;
    const stripe = {
      files: { create: async () => ({ id: `file_${++n}` }) },
      disputes: { update: async (_id: string, params: { evidence: Record<string, string> }) => (updates.push(params), {}) },
    } as unknown as Stripe;
    await submitDisputeEvidenceWithClient(stripe, {
      stripeDisputeId: "dp_1",
      evidence: {},
      files: [
        { name: "a.png", contentType: "image/png", bytes: new Uint8Array([1]), slot: 0 },
        { name: "c.pdf", contentType: "application/pdf", bytes: new Uint8Array([2]), slot: 2 },
      ],
    });
    expect(updates[0]!.evidence).toEqual({ receipt: "file_1", shipping_documentation: "file_2" });
  });
});
