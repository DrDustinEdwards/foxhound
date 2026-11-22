import {
  CONFIRM_TTL_SECONDS,
  mintConfirm,
  redeemConfirm,
} from "@dustinedwards/site-runtime/confirm-token";

import { linkKeys } from "~/lib/http/signed-token";

import type { McpToolContext } from "./registry";

// Confirmation step for a destructive tool call. A call that would overwrite settings or delete an alert does nothing the
// first time: it answers what it would change and a `confirm` code, and the agent shows that to the merchant and calls
// again with the same arguments and the code. The code is tied to that exact action (account, key, tool, arguments),
// signed with the link keys by site-runtime ./confirm-token, good for ten minutes, so a code cannot approve another change
// and any changed argument needs a new one. Stateless: nothing is stored. It is not proof the merchant read it.

export const CONFIRM_ARGUMENT = "confirm";

export const CONFIRM_PROPERTY = {
  type: "string",
  description:
    "Leave out at first. The call then changes nothing and answers what it would change and a confirm code. Show that to the merchant; only if they say yes, call again with the same arguments and this code.",
} as const;

export const CONFIRM_RESULT_FIELDS = ["confirmation_required", "would", "confirm", "expires_at"];

function bound(ctx: McpToolContext, tool: string, args: Record<string, unknown>) {
  const { [CONFIRM_ARGUMENT]: _code, ...rest } = args;
  return { k: "mcp-confirm", a: ctx.accountId, key: ctx.trace.apiKeyId, tool, args: rest };
}

/** Null when `args` carries a good code for exactly this call, so the write may run; otherwise the answer to send instead,
 *  with a fresh code. A present but wrong or expired code says so. */
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
