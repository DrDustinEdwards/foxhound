import {
  CONFIRM_TTL_SECONDS,
  mintConfirm,
  redeemConfirm,
} from "@dustinedwards/site-runtime/confirm-token";

import { linkKeys } from "~/lib/http/signed-token";

import type { McpToolContext } from "./registry";

// THE CONFIRMATION STEP FOR A DESTRUCTIVE TOOL CALL (area 11, T11).
//
// A call that would overwrite settings or delete an alert does nothing the
// first time. It answers what it would change and a `confirm` code, and the
// tool's description tells the agent to show that to the merchant and call
// again, with the same arguments and the code, only after they say yes.
//
// THE CODE IS TIED TO THAT EXACT ACTION: the account, the key, the tool and its
// arguments, signed with the link keys by site-runtime ./confirm-token and
// good for its ten minutes. A code for one change cannot
// approve another, another key's code is refused, and changing any argument
// needs a new code. Stateless: nothing is stored, so there is no table to
// clean and nothing a lost request leaves behind.
//
// WHAT IT IS NOT: proof the merchant read it. The agent carries the question;
// a client that asks its person before a destructiveHint tool (Claude does)
// asks twice. An approval link in the Foxhound app would tie it to the owner
// themselves; that is a change merchants see, so it waits for its own ruling.

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

/** The claims a code is bound to: the account, the key, the tool and its arguments (`confirm` aside). */
function bound(ctx: McpToolContext, tool: string, args: Record<string, unknown>) {
  const { [CONFIRM_ARGUMENT]: _code, ...rest } = args;
  return { k: "mcp-confirm", a: ctx.accountId, key: ctx.trace.apiKeyId, tool, args: rest };
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
  const claims = bound(ctx, tool, args);
  const now = ctx.now.getTime();
  const presented = args[CONFIRM_ARGUMENT];
  const offered = typeof presented === "string" && presented.length > 0;
  if (offered && (await redeemConfirm({ keys, token: presented, expect: claims, now })).ok)
    return null;
  const { token, expiresAt } = await mintConfirm({
    keys,
    claims,
    ttlSeconds: CONFIRM_TTL_SECONDS,
    now,
  });
  return {
    confirmation_required: true,
    would,
    confirm: token,
    expires_at: expiresAt,
    ...(offered
      ? {
          note: "That confirm code does not match this exact call, or it has expired. Nothing was changed.",
        }
      : {}),
  };
}
