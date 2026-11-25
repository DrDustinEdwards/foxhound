import { errorMessage } from "@dustinedwards/site-runtime/log";
import type { Db } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import {
  ADMIN_EMAIL_AUDIT_ACTION,
  ADMIN_EMAIL_STAND_IN_PATH,
  ADMIN_EMAIL_TYPES,
  findAdminEmailType,
  unknownTypeMessage,
  type AdminEmailType,
} from "~/lib/admin/email-catalog";
import {
  prepareAdminEmail,
  previewAdminEmail,
  sendAdminEmail,
  type AdminSendResult,
} from "~/lib/admin/email-send.server";
import {
  loadMerchantEmailSettings,
  resolveTestRecipient,
  testRecipientAllowList,
  type MerchantEmailSettings,
} from "~/lib/admin/email-targets.server";

import { ADMIN_API_PREFIX, ApiError, type ApiRoute, type Caller, type Json } from "./route.server";

/**
 * The merchant whose settings a test mail renders with. Customer mail and the
 * weekly digest need one; other merchant and platform mail use it when given.
 */
async function emailMerchant(
  db: Db,
  body: Json,
  types: AdminEmailType[],
): Promise<MerchantEmailSettings | null> {
  const accountId = typeof body.account_id === "string" && body.account_id ? body.account_id : null;
  if (!accountId) {
    if (types.some((t) => t.audience === "customer" || t.type === "weekly_digest")) {
      throw new ApiError(
        400,
        `Customer mail renders with a merchant's sender name and Reply-To, and the weekly digest's unsubscribe is signed for a merchant: send account_id. Find one with GET ${ADMIN_API_PREFIX}/merchants?query=.`,
      );
    }
    return null;
  }
  const merchant = await loadMerchantEmailSettings(db, accountId);
  if (!merchant)
    throw new ApiError(
      400,
      `No merchant ${accountId}. Find one with GET ${ADMIN_API_PREFIX}/merchants?query=.`,
    );
  return merchant;
}

function emailRecipient(
  env: Env,
  caller: Caller,
  body: Json,
): { to: string; kind: "self" | "allow_list" } {
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

export const EMAIL_ROUTES: ApiRoute[] = [
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
    // Render one email exactly as it would be sent. Sends and writes nothing.
    method: "POST",
    pattern: "/emails/preview",
    handler: async ({ db, env, caller, body, now }) => {
      const recipient = emailRecipient(env, caller, body);
      const type = findAdminEmailType(body.type);
      if (!type) throw new ApiError(400, unknownTypeMessage(body.type));
      const merchant = await emailMerchant(db, body, [type]);
      let preview;
      try {
        preview = previewAdminEmail(
          env,
          type,
          await prepareAdminEmail(env, { type, to: recipient.to, merchant, now }),
        );
      } catch (err) {
        // The real send would refuse for the same reason (a CAN-SPAM guard, a
        // missing signing key), so the refusal is the answer.
        throw new ApiError(409, `This email cannot be built: ${errorMessage(err)}.`);
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
      const requested =
        body.types === "all"
          ? ADMIN_EMAIL_TYPES.map((t) => t.type)
          : Array.isArray(body.types)
            ? body.types
            : [body.type];
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
          metadata: {
            type: type.type,
            accountId: merchant?.accountId ?? null,
            recipient: recipient.kind,
            via: "admin-api",
            keyId: caller.keyId,
          },
        });
        let prepared;
        try {
          prepared = await prepareAdminEmail(env, { type, to: recipient.to, merchant, now });
        } catch (err) {
          results.push({
            type: type.type,
            status: "failed",
            provider_message_id: null,
            error: errorMessage(err),
          });
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
