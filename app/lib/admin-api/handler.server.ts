import { desc, eq, gte } from "drizzle-orm";

import { getDb, type Db } from "~/db";
import { accounts, adminApiCalls, page404Daily } from "~/db/schema";
import { listAuditLog } from "~/lib/admin/audit-log.server";
import { logAdminAction } from "~/lib/admin/audit.server";
import {
  ADMIN_EMAIL_AUDIT_ACTION,
  ADMIN_EMAIL_STAND_IN_PATH,
  ADMIN_EMAIL_TYPES,
  findAdminEmailType,
  loadMerchantEmailSettings,
  prepareAdminEmail,
  previewAdminEmail,
  resolveTestRecipient,
  sendAdminEmail,
  testRecipientAllowList,
  unknownTypeMessage,
  type AdminEmailType,
  type AdminSendResult,
  type MerchantEmailSettings,
} from "~/lib/admin/email-send.server";
import { countStaleMarkers, engageBrake, getBrakeStatus } from "~/lib/admin/brake.server";
import { listCronRows } from "~/lib/admin/crons.server";
import { getMerchantDetail, listMerchants, setProcessingPaused } from "~/lib/admin/merchants.server";
import { getD1SizeBytes, getMigrationStatus } from "~/lib/admin/operations.server";
import { getPlatformOverview } from "~/lib/admin/overview.server";
import { describeStaged, listStagedChanges, stageChange, type StagedRow } from "~/lib/admin/staged.server";
import { getWebhookHealthSummary } from "~/lib/admin/webhooks.server";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE, verifyMcpToken } from "~/lib/auth/mcp-tokens";
import { isAdminEmail } from "~/lib/auth/roles";
import { RATE_LIMIT_MCP, RATE_LIMIT_MCP_ANON } from "~/lib/constants";
import { listDisputes } from "~/lib/disputes/queries.server";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { getIntelligenceOverview } from "~/lib/intelligence/views.server";
import { redactToolResult } from "~/lib/mcp/redact";
import { getGlobalPaymentStatusCounts } from "~/lib/recovery/queries.server";

// THE FOXHOUND ADMIN API at /api/admin/v1 (MCP ruling 2026-10-10, rule 9
// amendment; job_21de68b30fc2 PR 1).
//
// WHO CALLS IT. The Foxhound Admin MCP, which runs as its own Worker holding no
// Stripe key, no money binding and no database, and reaches this API over a
// service binding. It is the only thing in that Worker that can touch Foxhound.
//
// TWO CREDENTIALS ON EVERY CALL. An `mcp_admin` key (the MCP Worker's, issued
// with scripts/issue-admin-api-key.mjs) and the acting admin's email in the
// Foxhound-Acting-Admin header, which is re-checked against ADMIN_EMAIL on every
// call. The key says the caller is the admin MCP; the email says which person it
// is acting for, and a person dropped from ADMIN_EMAIL loses the API on their
// next call, whatever the MCP still believes. The key failures share one 401
// body so a guess cannot tell a revoked key from an unknown one.
//
// WHAT IT OFFERS. Reads, a pause (one merchant, or every merchant through the
// brake), staging, and the owner's test mail (/emails: preview any email, or
// send it to the caller's own inbox; ../admin/email-send.server.ts, approved by
// Dustin 2026-10-15). Test mail moves no money and writes no recovery state. Pausing stops money moving, so it is a direct write;
// everything that starts or changes money is staged (../admin/staged.server.ts)
// and applied only when an admin confirms it in /admin/staged. Refunds,
// adjustments, cancel and Stripe disconnect are not routes, and no import here
// can reach them.
//
// EVERY CALL THAT PASSES BOTH CREDENTIALS IS LOGGED in admin_api_calls, which
// the schema keeps append-only, and every write or staging also leaves an
// admin_audit_log row naming the acting admin.

export const ADMIN_API_PREFIX = "/api/admin/v1";
export const ACTING_ADMIN_HEADER = "Foxhound-Acting-Admin";
const PAGE_SIZE = 25;

type Json = Record<string, unknown>;

interface Caller {
  keyId: string;
  actorEmail: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

const UNAUTHORIZED = () => json(401, { ok: false, error: "Unauthorized" });

async function authenticate(request: Request, env: Env, db: Db): Promise<Caller | Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const refuse = async (response: Response, reason: string) => {
    console.debug("admin api refused:", reason);
    const allowed = await isWithinRateLimit(
      env,
      "admin-api-anon",
      ip,
      RATE_LIMIT_MCP_ANON.max,
      RATE_LIMIT_MCP_ANON.windowMs,
    );
    return allowed ? response : json(429, { ok: false, error: "Too many requests" });
  };

  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() : "";
  if (!token.startsWith(MCP_TOKEN_PREFIX)) return refuse(UNAUTHORIZED(), "no admin key");
  const verified = await verifyMcpToken(db, token);
  if (!verified || verified.scope !== MCP_TOKEN_SCOPE.ADMIN) return refuse(UNAUTHORIZED(), "not an admin key");

  const actor = (request.headers.get(ACTING_ADMIN_HEADER) ?? "").trim().toLowerCase();
  if (!isAdminEmail(env, actor)) {
    return refuse(
      json(403, {
        ok: false,
        error: `The acting admin is missing or not a Foxhound admin. Send the signed-in admin's email in ${ACTING_ADMIN_HEADER}.`,
      }),
      "acting admin not on ADMIN_EMAIL",
    );
  }

  const within = await isWithinRateLimit(env, "admin-api", verified.keyId, RATE_LIMIT_MCP.max, RATE_LIMIT_MCP.windowMs);
  if (!within) return json(429, { ok: false, error: "Too many requests" });
  return { keyId: verified.keyId, actorEmail: actor };
}

// ---------------------------------------------------------------------------
// Pagination: the same opaque cursor shape the merchant MCP uses.
// ---------------------------------------------------------------------------

function page(url: URL, route: string): number {
  const raw = url.searchParams.get("cursor");
  if (!raw) return 1;
  try {
    const { t, p } = JSON.parse(atob(raw)) as { t?: unknown; p?: unknown };
    if (t === route && typeof p === "number" && Number.isInteger(p) && p >= 1) return p;
  } catch {
    // Falls through to the refusal.
  }
  throw new ApiError(400, `That cursor was not issued by ${route}. Omit cursor to start from the first page.`);
}

function slice<T>(route: string, rows: T[], pageNumber: number) {
  const items = rows.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
  const hasMore = pageNumber * PAGE_SIZE < rows.length;
  return {
    items,
    total: rows.length,
    has_more: hasMore,
    next_cursor: hasMore ? btoa(JSON.stringify({ t: route, p: pageNumber + 1 })).replace(/=+$/, "") : null,
  };
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

interface RouteContext {
  db: Db;
  env: Env;
  caller: Caller;
  url: URL;
  params: string[];
  body: Json;
  now: Date;
}

type Handler = (ctx: RouteContext) => Promise<Json>;

interface ApiRoute {
  method: "GET" | "POST";
  /** Path under the prefix; `:id` matches one segment. */
  pattern: string;
  handler: Handler;
}

function stagedForAgent(row: StagedRow) {
  return { ...row, summary: describeStaged(row) };
}

/** One merchant, minus every credential its rows carry: the Stripe access
 *  token on each connection and the Slack webhook URL on the account. */
async function merchantForAgent(db: Db, accountId: string) {
  const detail = await getMerchantDetail(db, accountId);
  if (!detail) {
    throw new ApiError(404, `No merchant ${accountId}. Find one with GET ${ADMIN_API_PREFIX}/merchants?query=.`);
  }
  const { account } = detail;
  return {
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
      createdAt: account.createdAt,
      cancelledAt: account.cancelledAt,
      billingExempt: account.billingExempt,
      processingPaused: account.processingPaused,
      pauseReason: account.pauseReason,
      notificationEmail: account.notificationEmail,
      slackWebhookConfigured: Boolean(account.slackWebhookUrl),
    },
    connections: detail.connections.map((c) => ({
      id: c.id,
      name: c.name,
      stripeUserId: c.stripeUserId,
      isPrimary: c.isPrimary,
      connectedAt: c.connectedAt,
      disconnectedAt: c.disconnectedAt,
    })),
    subscriptions: detail.subscriptions,
    recoveryActivity: detail.recoveryActivity,
    disputeActivity: detail.disputeActivity,
    recentInvoices: detail.recentInvoices,
  };
}

/** The merchant whose settings a test mail renders with. Customer mail needs
 *  one; merchant and platform mail use it when given. */
async function emailMerchant(db: Db, body: Json, types: AdminEmailType[]): Promise<MerchantEmailSettings | null> {
  const accountId = typeof body.account_id === "string" && body.account_id ? body.account_id : null;
  if (!accountId) {
    if (types.some((t) => t.audience === "customer")) {
      throw new ApiError(
        400,
        `Customer mail renders with a merchant's sender name and Reply-To: send account_id. Find one with GET ${ADMIN_API_PREFIX}/merchants?query=.`,
      );
    }
    return null;
  }
  const merchant = await loadMerchantEmailSettings(db, accountId);
  if (!merchant) throw new ApiError(400, `No merchant ${accountId}. Find one with GET ${ADMIN_API_PREFIX}/merchants?query=.`);
  return merchant;
}

function emailRecipient(env: Env, caller: Caller, body: Json): { to: string; kind: "self" | "allow_list" } {
  const recipient = resolveTestRecipient(env, caller.actorEmail, body.to);
  if (!recipient.ok) throw new ApiError(400, recipient.error);
  return recipient;
}

function merchantForPreview(merchant: MerchantEmailSettings | null) {
  if (!merchant) return null;
  return {
    account_id: merchant.accountId,
    name: merchant.name,
    sender_name: merchant.senderName,
    reply_to: merchant.replyTo,
    brand_voice: merchant.brandVoice,
  };
}

const EMAIL_NOTE =
  `Sample customer data and template copy; no customer row is read and the model is not called, so brand voice is shown, not applied. ` +
  `Every button points at ${ADMIN_EMAIL_STAND_IN_PATH} instead of a tracked or card-update link, so a click records nothing. ` +
  `The unsubscribe link is real: following it suppresses that inbox.`;

const ROUTES: ApiRoute[] = [
  {
    // Who the API takes the caller to be. The admin MCP asks this at sign-in,
    // so whether a person is an admin is answered here, from ADMIN_EMAIL, and
    // nowhere else.
    method: "GET",
    pattern: "/me",
    handler: async ({ caller }) => ({ actor: caller.actorEmail }),
  },
  {
    method: "GET",
    pattern: "/whats-next",
    handler: async ({ db }) => {
      const [brake, staleMarkers, crons, webhooks, pending] = await Promise.all([
        getBrakeStatus(db),
        countStaleMarkers(db),
        listCronRows(db),
        getWebhookHealthSummary(db),
        listStagedChanges(db, "pending", 50),
      ]);
      return {
        brake,
        stale_markers: staleMarkers,
        crons_needing_attention: crons.filter((c) => !c.enabled || c.lastRun?.status === "failed"),
        webhooks,
        pending_staged: pending.map(stagedForAgent),
      };
    },
  },
  {
    method: "GET",
    pattern: "/platform",
    handler: async ({ db }) => ({ platform: await getPlatformOverview(db) }),
  },
  {
    method: "GET",
    pattern: "/merchants",
    handler: async ({ db, url }) => {
      const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
      const all = await listMerchants(db);
      const matching = query
        ? all.filter((m) => m.id.toLowerCase().includes(query) || (m.name ?? "").toLowerCase().includes(query))
        : all;
      const { items, ...rest } = slice("/merchants", matching, page(url, "/merchants"));
      return { merchants: items, ...rest };
    },
  },
  {
    method: "GET",
    pattern: "/merchants/:id",
    handler: async ({ db, params }) => ({ merchant: await merchantForAgent(db, params[0]) }),
  },
  {
    method: "GET",
    pattern: "/merchants/:id/data",
    handler: async ({ db, params }) => {
      await merchantForAgent(db, params[0]);
      const [overview, paymentStatusCounts, disputes] = await Promise.all([
        getIntelligenceOverview(db, params[0]),
        getGlobalPaymentStatusCounts(db, params[0]),
        listDisputes(db, params[0]),
      ]);
      // The merchant's customers, so the same redaction the merchant MCP
      // applies: no names, masked emails, no IP or address.
      return redactToolResult({
        overview,
        payment_status_counts: paymentStatusCounts,
        disputes: disputes.slice(0, PAGE_SIZE).map((d) => ({
          id: d.id,
          amountCents: d.amountCents,
          currency: d.currency,
          reason: d.reason,
          state: d.state,
          outcome: d.outcome,
          evidenceDeadline: d.evidenceDeadline,
          customerEmail: d.customerEmail,
          createdAt: d.createdAt,
        })),
        disputes_total: disputes.length,
      }) as Json;
    },
  },
  {
    method: "GET",
    pattern: "/health",
    handler: async ({ db, env, now }) => {
      const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const [webhooks, crons, migrations, d1SizeBytes, notFound] = await Promise.all([
        getWebhookHealthSummary(db),
        listCronRows(db),
        getMigrationStatus(env),
        getD1SizeBytes(env),
        db
          .select({ day: page404Daily.day, path: page404Daily.path, hits: page404Daily.hitCount })
          .from(page404Daily)
          .where(gte(page404Daily.day, since))
          .orderBy(desc(page404Daily.hitCount))
          .limit(20),
      ]);
      return { webhooks, crons, migrations, d1_size_bytes: d1SizeBytes, top_404s_7d: notFound };
    },
  },
  {
    method: "GET",
    pattern: "/audit-log",
    handler: async ({ db, url }) => {
      const rows = await listAuditLog(db, 500);
      const { items, ...rest } = slice("/audit-log", rows, page(url, "/audit-log"));
      return { entries: items, ...rest };
    },
  },
  {
    method: "POST",
    pattern: "/pause",
    handler: async ({ db, caller, body }) => {
      if (body.all === true) {
        const result = await engageBrake(db, { actorEmail: caller.actorEmail });
        if (result.error) {
          throw new ApiError(
            500,
            `The brake paused ${result.affectedCount} of ${result.intendedCount} merchants before a write failed (${result.error}). Pausing again is safe and picks up the rest.`,
          );
        }
        return { paused: "all", affected: result.affectedCount };
      }
      const accountId = typeof body.account_id === "string" ? body.account_id : "";
      if (!accountId) throw new ApiError(400, "Send account_id to pause one merchant, or all: true to pause every merchant.");
      const exists = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (exists.length === 0) {
        throw new ApiError(400, `No merchant ${accountId}. Find one with GET ${ADMIN_API_PREFIX}/merchants?query=.`);
      }
      // Intent before state, as the /admin screens do.
      await logAdminAction(db, {
        actorEmail: caller.actorEmail,
        action: "merchant.processing.pause",
        metadata: { accountId, via: "admin-api", keyId: caller.keyId },
      });
      await setProcessingPaused(db, accountId, true);
      return { paused: accountId };
    },
  },
  {
    method: "GET",
    pattern: "/staged",
    handler: async ({ db, url }) => {
      const status = url.searchParams.get("status");
      const rows = await listStagedChanges(db, status);
      const { items, ...rest } = slice("/staged", rows, page(url, "/staged"));
      return { staged: items.map(stagedForAgent), ...rest };
    },
  },
  {
    method: "POST",
    pattern: "/staged",
    handler: async ({ db, caller, body, now }) => {
      const staged = await stageChange(db, {
        kind: body.kind,
        accountId: body.account_id,
        cronName: body.cron_name,
        exempt: body.exempt,
        note: body.note,
        requestedBy: caller.actorEmail,
        requestedVia: "admin-api",
        now,
      });
      if (!staged.ok) throw new ApiError(400, staged.error);
      return {
        staged: stagedForAgent(staged.value),
        next: "Nothing has changed yet. An admin confirms or rejects this in /admin/staged.",
      };
    },
  },
  {
    // The email types the owner can preview or send, and who may receive them.
    method: "GET",
    pattern: "/emails",
    handler: async ({ env, caller }) => ({
      types: ADMIN_EMAIL_TYPES,
      recipients: { default: caller.actorEmail, allow_list: testRecipientAllowList(env) },
      note: EMAIL_NOTE,
    }),
  },
  {
    // Render one email exactly as it would be sent. Sends nothing, writes nothing.
    method: "POST",
    pattern: "/emails/preview",
    handler: async ({ db, env, caller, body, now }) => {
      const recipient = emailRecipient(env, caller, body);
      const type = findAdminEmailType(body.type);
      if (!type) throw new ApiError(400, unknownTypeMessage(body.type));
      const merchant = await emailMerchant(db, body, [type]);
      let preview;
      try {
        preview = previewAdminEmail(env, type, await prepareAdminEmail(env, { type, to: recipient.to, merchant, now }));
      } catch (err) {
        // The real send would refuse for the same reason (a CAN-SPAM guard, a
        // missing signing key), so the refusal is the answer.
        throw new ApiError(409, `This email cannot be built: ${err instanceof Error ? err.message : String(err)}.`);
      }
      return { preview, merchant: merchantForPreview(merchant), note: EMAIL_NOTE };
    },
  },
  {
    // Send one, several or all ("all") types to the caller's own inbox or an
    // allow-listed one. Each send is audited before it is attempted.
    method: "POST",
    pattern: "/emails/send",
    handler: async ({ db, env, caller, body, now }) => {
      const recipient = emailRecipient(env, caller, body);
      const requested = body.types === "all" ? ADMIN_EMAIL_TYPES.map((t) => t.type) : Array.isArray(body.types) ? body.types : [body.type];
      const types: AdminEmailType[] = [];
      for (const id of requested) {
        const type = findAdminEmailType(id);
        if (!type) throw new ApiError(400, `${unknownTypeMessage(id)} Or send types: "all".`);
        if (!types.includes(type)) types.push(type);
      }
      const merchant = await emailMerchant(db, body, types);
      const results: AdminSendResult[] = [];
      for (const type of types) {
        // Intent before state, as the /admin screens do: the row exists before
        // the send is attempted, so no test mail leaves unrecorded.
        await logAdminAction(db, {
          actorEmail: caller.actorEmail,
          action: ADMIN_EMAIL_AUDIT_ACTION,
          targetEmail: recipient.to,
          metadata: { type: type.type, accountId: merchant?.accountId ?? null, recipient: recipient.kind, via: "admin-api", keyId: caller.keyId },
        });
        let prepared;
        try {
          prepared = await prepareAdminEmail(env, { type, to: recipient.to, merchant, now });
        } catch (err) {
          results.push({ type: type.type, status: "failed", provider_message_id: null, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        results.push(await sendAdminEmail(env, type, prepared));
      }
      return {
        to: recipient.to,
        account_id: merchant?.accountId ?? null,
        results,
        sent: results.filter((r) => r.status === "sent").length,
        note: EMAIL_NOTE,
      };
    },
  },
];

/** The method and path of every route, so a plant can assert the surface. */
export const ADMIN_API_ROUTES = ROUTES.map((r) => `${r.method} ${r.pattern}`);

function match(method: string, path: string): { route: ApiRoute; params: string[] } | null {
  const segments = path.split("/").filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const parts = route.pattern.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params: string[] = [];
    if (parts.every((part, i) => (part === ":id" ? (params.push(decodeURIComponent(segments[i])), true) : part === segments[i]))) {
      return { route, params };
    }
  }
  return null;
}

async function logCall(db: Db, caller: Caller, request: Request, path: string, input: Json, status: number, error: string | null) {
  try {
    await db.insert(adminApiCalls).values({
      actorEmail: caller.actorEmail,
      apiKeyId: caller.keyId,
      method: request.method,
      path,
      input,
      status,
      error,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("admin api call log write failed:", caller.keyId, path, err instanceof Error ? err.message : String(err));
  }
}

/** Null for any path outside the prefix, so the worker entry falls through. */
export async function handleAdminApiRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== ADMIN_API_PREFIX && !url.pathname.startsWith(`${ADMIN_API_PREFIX}/`)) return null;

  const db = getDb(env);
  const caller = await authenticate(request, env, db);
  if (caller instanceof Response) return caller;

  const path = url.pathname.slice(ADMIN_API_PREFIX.length) || "/";
  let body: Json = {};
  if (request.method === "POST") {
    try {
      const parsed: unknown = await request.json();
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
    } catch {
      body = {};
    }
  }
  const input: Json = { query: Object.fromEntries(url.searchParams), ...(request.method === "POST" ? { body } : {}) };

  const found = match(request.method, path);
  let response: Response;
  let error: string | null = null;
  if (!found) {
    error = `No ${request.method} ${path}. This API offers: ${ADMIN_API_ROUTES.join(", ")}.`;
    response = json(404, { ok: false, error });
  } else {
    try {
      const data = await found.route.handler({ db, env, caller, url, params: found.params, body, now: new Date() });
      response = json(200, { ok: true, data });
    } catch (err) {
      if (err instanceof ApiError) {
        error = err.message;
        response = json(err.status, { ok: false, error });
      } else {
        // An unexpected failure's text stays on the server, as on the merchant
        // MCP: it can carry the values of the query it failed on.
        console.error("admin api failed:", path, err instanceof Error ? err.message : String(err));
        error = "Foxhound could not finish this call because of an internal error. Try again.";
        response = json(500, { ok: false, error });
      }
    }
  }
  await logCall(db, caller, request, path, input, response.status, error);
  return response;
}
