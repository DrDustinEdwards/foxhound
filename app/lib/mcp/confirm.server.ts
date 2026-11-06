import { readSignedToken, signToken } from "@dustinedwards/site-runtime/signed-token";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

import { linkKeys } from "~/lib/http/signed-token";

import type { McpToolContext } from "./registry";

// THE CONFIRMATION STEP FOR A DESTRUCTIVE TOOL CALL (area 11, T11).
//
// A call that would overwrite settings or delete an alert does nothing the
// first time. It answers what it would change and a `confirm` code, and the
// tool's description tells the agent to show that to the merchant and call
// again, with the same arguments and the code, only after they say yes.
//
// THE CODE IS TIED TO THAT EXACT ACTION: the account, the key, the tool and a
// hash of the arguments, signed with the link keys (site-runtime
// ./signed-token) and good for ten minutes. A code for one change cannot
// approve another, another key's code is refused, and changing any argument
// needs a new code. Stateless: nothing is stored, so there is no table to
// clean and nothing a lost request leaves behind.
//
// WHAT IT IS NOT: proof the merchant read it. The agent carries the question;
// a client that asks its person before a destructiveHint tool (Claude does)
// asks twice. An approval link in the Foxhound app would tie it to the owner
// themselves; that is a change merchants see, so it waits for its own ruling.

const CONFIRM_TTL_MS = 10 * 60 * 1000;

/** The argument a destructive tool reads its confirm code from. */
export const CONFIRM_ARGUMENT = "confirm";

/** The inputSchema property every confirming tool declares. */
export const CONFIRM_PROPERTY = {
  type: "string",
  description:
    "Leave out at first. The call then changes nothing and answers what it would change and a confirm code. Show that to the merchant; only if they say yes, call again with the same arguments and this code.",
} as const;

/** The outputSchema fields a confirming tool's first answer carries. */
export const CONFIRM_RESULT_FIELDS = ["confirmation_required", "would", "confirm", "expires_at"];

/** Key order fixed at every depth, so the same arguments always hash the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

async function actionHash(tool: string, args: Record<string, unknown>): Promise<string> {
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => key !== CONFIRM_ARGUMENT));
  return sha256Hex(`${tool}\n${JSON.stringify(canonical(rest))}`);
}

/**
 * Null when `args` carries a good code for exactly this call, so the write may
 * run; otherwise the answer to send instead, with a fresh code. A code that is
 * present but wrong or expired says so.
 */
export async function confirmationNeeded(
  ctx: McpToolContext,
  tool: string,
  args: Record<string, unknown>,
  would: string,
): Promise<Record<string, unknown> | null> {
  const keys = linkKeys(ctx.env);
  const hash = await actionHash(tool, args);
  const presented = args[CONFIRM_ARGUMENT];
  if (typeof presented === "string" && presented.length > 0) {
    const payload = await readSignedToken(keys, presented).catch(() => null);
    if (
      payload &&
      payload.k === "mcp-confirm" &&
      payload.a === ctx.accountId &&
      payload.key === ctx.trace.apiKeyId &&
      payload.h === hash &&
      typeof payload.e === "number" &&
      payload.e > ctx.now.getTime()
    ) {
      return null;
    }
  }
  const expires = ctx.now.getTime() + CONFIRM_TTL_MS;
  const confirm = await signToken(keys, { k: "mcp-confirm", a: ctx.accountId, key: ctx.trace.apiKeyId, h: hash, e: expires });
  return {
    confirmation_required: true,
    would,
    confirm,
    expires_at: new Date(expires).toISOString(),
    ...(typeof presented === "string" && presented.length > 0
      ? { note: "That confirm code does not match this exact call, or it has expired. Nothing was changed." }
      : {}),
  };
}
