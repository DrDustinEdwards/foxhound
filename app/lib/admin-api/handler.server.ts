import {
  errorMessage,
  logEvent,
  OWASP_EVENTS,
  requestFields,
} from "@dustinedwards/site-runtime/log";
import { notFoundReport } from "@dustinedwards/site-runtime/not-found";
import { eq } from "drizzle-orm";
import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { getDb, type Db } from "~/db";
import { accounts, adminApiCalls } from "~/db/schema";
import { listAdminAuditLog } from "~/lib/admin/audit-log.server";
import { countStaleMarkers, engageBrake, getBrakeStatus } from "~/lib/admin/brake.server";
import { listCronRows } from "~/lib/admin/crons.server";
import { setProcessingPaused } from "~/lib/admin/merchant-controls.server";
import { getD1SizeBytes, getMigrationStatus } from "~/lib/admin/operations.server";
import { getPlatformOverview } from "~/lib/admin/overview.server";
import {
  describeStaged,
  listStagedChanges,
  stageChange,
  type StagedRow,
} from "~/lib/admin/staged.server";
import { getWebhookHealthSummary } from "~/lib/admin/webhooks.server";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE, verifyMcpToken } from "~/lib/auth/mcp-tokens";
import { isAdminEmail } from "@dustinedwards/site-runtime/access";
import { bearerToken } from "@dustinedwards/site-runtime/agent-keys";
import { RATE_LIMIT_MCP, RATE_LIMIT_MCP_ANON } from "~/lib/http/rate-limit-buckets";
import { isIpWithinRateLimit, isWithinRateLimit } from "~/lib/http/rate-limit";
import { readJson } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

import {
  ADMIN_API_PREFIX,
  ApiError,
  page,
  slice,
  type ApiRoute,
  type Caller,
  type Json,
} from "./route.server";
import { EMAIL_ROUTES } from "./email-routes.server";
import { MERCHANT_ROUTES } from "./merchant-routes.server";

// THE FOXHOUND ADMIN API at /api/admin/v1.
//
// The Foxhound Admin MCP, which runs as its own Worker holding no Stripe key,
// no money binding and no database, and reaches this API over a service
// binding. It is served only on the AdminApi entrypoint (workers/admin-api.ts),
// which that binding names; the public fetch handler never routes it.

const ACTING_ADMIN_HEADER = "Foxhound-Acting-Admin";

const UNAUTHORIZED = () => jsonResponse({ ok: false, error: "Unauthorized" }, 401);

async function authenticate(request: Request, env: Env, db: Db): Promise<Caller | Response> {
  const refuse = async (response: Response, reason: string) => {
    logEvent(
      OWASP_EVENTS.authorizationFailure,
      { ...requestFields(request), door: "admin-api", reason },
      { level: "warn" },
    );
    const allowed = await isIpWithinRateLimit(env, request, "admin-api-anon", RATE_LIMIT_MCP_ANON);
    return allowed ? response : jsonResponse({ ok: false, error: "Too many requests" }, 429);
  };

  const token = bearerToken(request.headers.get("authorization")) ?? "";
  if (!token.startsWith(MCP_TOKEN_PREFIX)) return refuse(UNAUTHORIZED(), "no admin key");
  const verified = await verifyMcpToken(db, token);
  if (!verified || verified.scope !== MCP_TOKEN_SCOPE.ADMIN)
    return refuse(UNAUTHORIZED(), "not an admin key");

  const actor = (request.headers.get(ACTING_ADMIN_HEADER) ?? "").trim().toLowerCase();
  if (!isAdminEmail(env, actor)) {
    return refuse(
      jsonResponse(
        {
          ok: false,
          error: `The acting admin is missing or not a Foxhound admin. Send the signed-in admin's email in ${ACTING_ADMIN_HEADER}.`,
        },
        403,
      ),
      "acting admin not on ADMIN_EMAIL",
    );
  }

  const within = await isWithinRateLimit(
    env,
    "admin-api",
    verified.keyId,
    RATE_LIMIT_MCP.max,
    RATE_LIMIT_MCP.windowMs,
  );
  if (!within) return jsonResponse({ ok: false, error: "Too many requests" }, 429);
  return { keyId: verified.keyId, actorEmail: actor };
}

function stagedForAgent(row: StagedRow) {
  return { ...row, summary: describeStaged(row) };
}

const ROUTES: ApiRoute[] = [
  {
    // Who the API takes the caller to be. The admin MCP asks this at sign-in, so
    // whether a person is an admin is answered here, from ADMIN_EMAIL, alone.
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
  ...MERCHANT_ROUTES,
  {
    method: "GET",
    pattern: "/health",
    handler: async ({ db, env, now }) => {
      const [webhooks, crons, migrations, d1SizeBytes, notFound] = await Promise.all([
        getWebhookHealthSummary(db),
        listCronRows(db),
        getMigrationStatus(env),
        getD1SizeBytes(env),
        notFoundReport(env.DB, { days: 7, limit: 20, now }),
      ]);
      return { webhooks, crons, migrations, d1_size_bytes: d1SizeBytes, top_404s_7d: notFound };
    },
  },
  {
    method: "GET",
    pattern: "/audit-log",
    handler: async ({ db, url }) => {
      const rows = await listAdminAuditLog(db, 500);
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
      if (!accountId)
        throw new ApiError(
          400,
          "Send account_id to pause one merchant, or all: true to pause every merchant.",
        );
      const exists = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (exists.length === 0) {
        throw new ApiError(
          400,
          `No merchant ${accountId}. Find one with GET ${ADMIN_API_PREFIX}/merchants?query=.`,
        );
      }
      // The audit row commits with the pause, as the /admin screens do.
      await setProcessingPaused(db, accountId, true, {
        actorEmail: caller.actorEmail,
        action: "merchant.processing.pause",
        metadata: { accountId, via: "admin-api", keyId: caller.keyId },
      });
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
  ...EMAIL_ROUTES,
];

const ADMIN_API_ROUTES = ROUTES.map((r) => `${r.method} ${r.pattern}`);

function match(method: string, path: string): { route: ApiRoute; params: string[] } | null {
  let segments: string[];
  try {
    segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null; // a malformed escape names no route
  }
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const parts = route.pattern.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params: string[] = [];
    if (
      parts.every((part, i) =>
        part === ":id" ? (params.push(segments[i]), true) : part === segments[i],
      )
    ) {
      return { route, params };
    }
  }
  return null;
}

async function logCall(
  db: Db,
  caller: Caller,
  request: Request,
  path: string,
  input: Json,
  status: number,
  error: string | null,
) {
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
    console.error("admin api call log write failed:", caller.keyId, path, errorMessage(err));
  }
}

export async function handleAdminApiRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== ADMIN_API_PREFIX && !url.pathname.startsWith(`${ADMIN_API_PREFIX}/`))
    return null;

  const db = getDb(env);
  const caller = await authenticate(request, env, db);
  if (caller instanceof Response) return caller;

  const path = url.pathname.slice(ADMIN_API_PREFIX.length) || "/";
  let body: Json = {};
  if (request.method === "POST") {
    try {
      const parsed: unknown = await readJson(request, BODY_MAX_BYTES);
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
    } catch {
      body = {};
    }
  }
  const input: Json = {
    query: Object.fromEntries(url.searchParams),
    ...(request.method === "POST" ? { body } : {}),
  };

  const found = match(request.method, path);
  let response: Response;
  let error: string | null = null;
  if (!found) {
    error = `No ${request.method} ${path}. This API offers: ${ADMIN_API_ROUTES.join(", ")}.`;
    response = jsonResponse({ ok: false, error }, 404);
  } else {
    try {
      const data = await found.route.handler({
        db,
        env,
        caller,
        url,
        params: found.params,
        body,
        now: new Date(),
      });
      response = jsonResponse({ ok: true, data });
    } catch (err) {
      if (err instanceof ApiError) {
        error = err.message;
        response = jsonResponse({ ok: false, error }, err.status);
      } else {
        // An unexpected failure's text stays on the server, as on the merchant
        // MCP: it can carry the values of the query it failed on.
        console.error("admin api failed:", path, errorMessage(err));
        error = "Foxhound could not finish this call because of an internal error. Try again.";
        response = jsonResponse({ ok: false, error }, 500);
      }
    }
  }
  // Reads that succeed are not logged (a polling key wrote 1,900 rows a day); every write and every refusal is.
  if (request.method !== "GET" || response.status >= 400) {
    await logCall(db, caller, request, path, input, response.status, error);
  }
  return response;
}
