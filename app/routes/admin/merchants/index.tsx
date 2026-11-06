import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/confirm-dialog.css";
import "capsomer/field.css";
import "capsomer/message.css";
import "capsomer/tabs.css";
import { data } from "react-router";
import { ConfirmPage } from "capsomer/react/confirm-dialog";
import { MessageProvider } from "capsomer/react/message";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { PAUSE_REASON_BRAKE, PAUSE_REASON_MANUAL } from "~/lib/admin/brake";
import { adminContext } from "~/lib/admin/context";
import { loadMerchantsPage } from "~/lib/admin/merchants-page.server";
import {
  CANCEL_CONFIRM_WORD,
  isCancelConfirmValid,
  merchantCancelAction,
  merchantViewPath,
  type ToggleResult,
} from "~/lib/admin/merchants";
import {
  getMerchantActionTarget,
  setBillingExempt,
  setProcessingPausedIfChanged,
} from "~/lib/admin/merchants.server";
import { cancelMerchant } from "~/lib/admin/merchant-cancel.server";
import { plural } from "~/lib/admin/overview";
import type { AdminHandle } from "~/lib/admin/page";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { Route } from "./+types/index";
import { MerchantsList } from "../../../components/admin-merchants-parts";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "~/lib/http/body";

export const handle: AdminHandle = { page: "Merchants" };

export function meta() {
  return [{ title: "Merchants - Foxhound admin" }, NOINDEX];
}

// This module serves three addresses (routes.ts): every merchant here, and
// Recova's Paused and Billing exempt lists, whose route modules pass
// their own list to the same loader and re-export this action and page.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return loadMerchantsPage(env, request, "all");
}

interface Refused {
  ok: false;
  intent: string;
  error: string;
}
interface Canceled {
  ok: true;
  intent: "cancel";
  accountId: string;
  name: string | null;
  warning?: string;
}
export type ActionData = ToggleResult | Canceled | Refused;

const refuse = (intent: string, error: string, status = 400) =>
  data<ActionData>({ ok: false, intent, error }, { status });

// Every action goes through Foxhound's own writers (merchants.server.ts), as
// the merchant page's do, and writes an admin_audit_log row. Access and the
// admin shell's middleware guard this route; there is no role check here.
export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(adminContext);
  const db = getDb(env);

  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  const accountId = String(form.get("accountId") ?? "");

  if (intent !== "billing-exempt" && intent !== "processing-paused" && intent !== "cancel") {
    return refuse(intent, "Unknown action. Nothing was changed.");
  }
  const target = await getMerchantActionTarget(db, accountId);
  if (!target) return refuse(intent, "That merchant was not found. Nothing was changed.");

  if (intent === "cancel") {
    if (target.cancelledAt) return refuse(intent, `${target.name ?? target.id} is already canceled.`);
    // Checked before the write and before the audit row, so a mistyped word
    // never records an attempt that did not happen. Capsomer's confirm page
    // says "Not done. Nothing was changed." itself.
    if (!isCancelConfirmValid(String(form.get("confirm") ?? ""))) {
      return refuse(intent, `Type ${CANCEL_CONFIRM_WORD} to cancel this merchant.`);
    }
    const result = await cancelMerchant(env, accountId);
    await logAdminAction(db, {
      actorEmail: auth.email,
      action: "merchant.cancel",
      metadata: {
        accountId,
        connectionsDisconnected: result.connectionsDisconnected,
        deauthorizeErrors: result.deauthorizeErrors,
      },
    });
    const failed = result.deauthorizeErrors.length;
    return data<ActionData>({
      ok: true,
      intent,
      accountId,
      name: target.name,
      warning:
        failed > 0
          ? `${plural(failed, "Stripe connection", "Stripe connections")} could not be revoked at Stripe and need a revoke by hand or a retry. The merchant is canceled here either way.`
          : undefined,
    });
  }

  const raw = String(form.get("value") ?? "");
  if (raw !== "true" && raw !== "false") return refuse(intent, "Unknown value. Nothing was changed.");
  const value = raw === "true";

  // An Undo is the same post marked undo=1. It writes only where the flag
  // still holds what the change it undoes set, and an Undo of a pause resumes
  // only a manual pause, never the brake's (the J70 review, HIGH).
  const undo = form.get("undo") === "1";
  const who = target.name ?? target.id;

  // Intent before state (review LOW-4, as the crons page and the brake do): a
  // failed audit insert leaves the flag as it was, never changed with no record.
  // The row records the attempt; a guarded write that matched nothing changes
  // nothing and the answer says so.
  const wasBrakePause = !value && target.processingPaused && target.pauseReason === PAUSE_REASON_BRAKE;
  // Whether the write will change anything, as read just before it, so a
  // stale row's no-op says so in its audit row (PR 140 review). It is the
  // guarded write's own condition: the flag holds the other value, and an Undo
  // of a pause resumes only a manual pause.
  const current = intent === "billing-exempt" ? target.billingExempt : target.processingPaused;
  const willChange =
    current !== value && !(intent === "processing-paused" && undo && !value && target.pauseReason !== PAUSE_REASON_MANUAL);
  await logAdminAction(db, {
    actorEmail: auth.email,
    action:
      intent === "billing-exempt"
        ? value
          ? "merchant.billing_exempt.enable"
          : "merchant.billing_exempt.disable"
        : value
          ? "merchant.processing.pause"
          : "merchant.processing.resume",
    metadata: undo ? { accountId, undo: true, changed: willChange } : { accountId, changed: willChange },
  });
  const changed =
    intent === "billing-exempt"
      ? await setBillingExempt(env, accountId, value, new Date())
      : await setProcessingPausedIfChanged(db, accountId, value, { undoOfPause: undo });

  if (undo && !changed) {
    return refuse(
      intent,
      `Not undone: ${who} has changed since, so the Undo would not put back what was there. Nothing was changed.`,
      409,
    );
  }
  return data<ActionData>({
    ok: true,
    intent,
    accountId,
    name: target.name,
    value,
    changed,
    wasBrakePause: changed && wasBrakePause,
  });
}

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14)
// and his review of 2026-10-11: one page name (the shell's "Merchants"), plain
// sentence-case words, numbers said in words, relative times with the exact
// time on hover, real icons, a pending and an empty state. Recova's merchants
// page (app/admin/AdminClient.tsx, blob df4b3713) is the inventory: its five
// figures, then a row per account with the owner's email, status, Stripe,
// recovery rate, recovered, last webhook and join date, and its inline
// actions. Foxhound keeps its own active-recoveries column and its link to
// each merchant's page.
//
// Billing exempt and pause can be undone, so they happen at once and offer
// Undo in the page's message region. Recova's Disconnect is Foxhound's cancel
// (cancelMerchant), which revokes the Stripe grant and cannot be undone, so it
// opens Capsomer's confirm page and needs a typed word. Recova's Impersonate is
// "View as merchant": read-only, 30 minutes, audited, posting to /admin/view-as
// (app/lib/admin/impersonation.server.ts). Every action is a form or a link, so the page works without
// script; the result of a post made without script shows in a banner with its
// Undo as a form.
//
// Recova's Paused and Billing exempt lists are this page filtered, in
// Capsomer's links form of tabs at Recova's addresses: the same table, the
// same actions (Recova's Resume and Remove exemption are the row's own
// buttons), each form posting to the list it is on.
export default function AdminMerchants({ loaderData, actionData }: Route.ComponentProps) {
  const { view, merchants, counts, brakePaused, figures, confirmCancel } = loaderData;

  if (confirmCancel) {
    const who = confirmCancel.name ?? confirmCancel.id;
    const refused = actionData && !actionData.ok && actionData.intent === "cancel" ? actionData.error : null;
    return (
      <div className="grid grid-cols-1 gap-6">
        <ConfirmPage
          action={merchantCancelAction(confirmCancel.id, view)}
          hidden={{ intent: "cancel", accountId: confirmCancel.id }}
          title={`Cancel ${who}?`}
          lead="This cannot be undone."
          body={[
            "Every Stripe connection is disconnected, and its access is revoked at Stripe.",
            "Recovery and dispute processing stop for this merchant.",
            "Fees already earned and not yet billed are still billed.",
          ]}
          action_label="Cancel merchant"
          cancelHref={merchantViewPath(view)}
          cancelLabel="Go back"
          typeToConfirm={CANCEL_CONFIRM_WORD}
          error={refused}
          headingLevel="h2"
        />
      </div>
    );
  }

  return (
    <MessageProvider>
      <MerchantsList
        view={view}
        merchants={merchants}
        counts={counts}
        brakePaused={brakePaused}
        figures={figures}
        actionData={actionData}
      />
    </MessageProvider>
  );
}
