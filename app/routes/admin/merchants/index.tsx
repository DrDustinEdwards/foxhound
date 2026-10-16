import { useCallback, useEffect, useRef } from "react";
import { data, Form, Link, useFetcher, useFetchers, useNavigation, useRevalidator } from "react-router";
import { ExternalLink } from "lucide-react";
import { ConfirmPage } from "capsomer/react/confirm-dialog";
import { Empty } from "capsomer/react/empty";
import { MessageProvider, useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import { Glyph, Status } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/confirm-dialog.css";
import "capsomer/field.css";
import "capsomer/message.css";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { adminContext } from "~/lib/admin/context";
import {
  CANCEL_CONFIRM_WORD,
  CONNECTION_WORDS,
  isCancelConfirmValid,
  merchantCancelHref,
  merchantStatus,
  MERCHANTS_ACTION,
  MERCHANTS_PATH,
  moneyWords,
  toggleWords,
  type ToggleIntent,
  type ToggleResult,
} from "~/lib/admin/merchants";
import {
  cancelMerchant,
  getMerchantActionTarget,
  getMerchantFigures,
  listAdminMerchants,
  setBillingExempt,
  setProcessingPaused,
  type AdminMerchantRow,
} from "~/lib/admin/merchants.server";
import { plural } from "~/lib/admin/overview";
import { merchantHref, pagePending, type AdminHandle } from "~/lib/admin/page";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { recoveryRateBand, recoveryRateTone } from "~/lib/dashboard/recovery-rate";

import type { Route } from "./+types/index";

export const handle: AdminHandle = { page: "Merchants" };

export function meta() {
  return [{ title: "Merchants - Foxhound admin" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [merchants, figures] = await Promise.all([listAdminMerchants(db), getMerchantFigures(db, Date.now())]);
  // ?cancel=<id> opens the confirm page for a merchant that can still be
  // cancelled. An unknown or already cancelled one opens nothing, so a stale
  // link lands on the table rather than on a confirmation of nothing.
  const asked = new URL(request.url).searchParams.get("cancel");
  const live = merchants.find((m) => m.id === asked && !m.cancelledAt);
  return { merchants, figures, confirmCancel: live ? { id: live.id, name: live.name } : null };
}

interface Refused {
  ok: false;
  intent: string;
  error: string;
}
interface Cancelled {
  ok: true;
  intent: "cancel";
  accountId: string;
  name: string | null;
  warning?: string;
}
type ActionData = ToggleResult | Cancelled | Refused;

const refuse = (intent: string, error: string) => data<ActionData>({ ok: false, intent, error }, { status: 400 });

// Every action goes through Foxhound's own writers (merchants.server.ts), as
// the merchant page's do, and writes an admin_audit_log row. Access and the
// admin shell's middleware guard this route; there is no role check here.
export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(adminContext);
  const db = getDb(env);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const accountId = String(form.get("accountId") ?? "");

  if (intent !== "billing-exempt" && intent !== "processing-paused" && intent !== "cancel") {
    return refuse(intent, "Unknown action. Nothing was changed.");
  }
  const target = await getMerchantActionTarget(db, accountId);
  if (!target) return refuse(intent, "That merchant was not found. Nothing was changed.");

  if (intent === "cancel") {
    if (target.cancelledAt) return refuse(intent, `${target.name ?? target.id} is already cancelled.`);
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
          ? `${plural(failed, "Stripe connection", "Stripe connections")} could not be revoked at Stripe and need a revoke by hand or a retry. The merchant is cancelled here either way.`
          : undefined,
    });
  }

  const raw = String(form.get("value") ?? "");
  if (raw !== "true" && raw !== "false") return refuse(intent, "Unknown value. Nothing was changed.");
  const value = raw === "true";

  // Intent before state (review LOW-4, as the crons page and the brake do): a
  // failed audit insert leaves the flag as it was, never changed with no record.
  if (intent === "billing-exempt") {
    await logAdminAction(db, {
      actorEmail: auth.email,
      action: value ? "merchant.billing_exempt.enable" : "merchant.billing_exempt.disable",
      metadata: { accountId },
    });
    await setBillingExempt(db, accountId, value);
    return data<ActionData>({ ok: true, intent, accountId, name: target.name, value, wasBrakePause: false });
  }

  const wasBrakePause = !value && target.processingPaused && target.pauseReason === PAUSE_REASON_BRAKE;
  await logAdminAction(db, {
    actorEmail: auth.email,
    action: value ? "merchant.processing.pause" : "merchant.processing.resume",
    metadata: { accountId },
  });
  await setProcessingPaused(db, accountId, value);
  return data<ActionData>({ ok: true, intent, accountId, name: target.name, value, wasBrakePause });
}

const HEADING_ID = "admin-merchants-heading";
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "inline-block min-h-6 leading-6 text-text underline underline-offset-2";

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
// opens Capsomer's confirm page and needs a typed word. Impersonate stays out
// (ruling 125). Every action is a form or a link, so the page works without
// script; the result of a post made without script shows in a banner with its
// Undo as a form.
export default function AdminMerchants({ loaderData, actionData }: Route.ComponentProps) {
  const { merchants, figures, confirmCancel } = loaderData;

  if (confirmCancel) {
    const who = confirmCancel.name ?? confirmCancel.id;
    const refused = actionData && !actionData.ok && actionData.intent === "cancel" ? actionData.error : null;
    return (
      <div className="grid grid-cols-1 gap-6">
        <ConfirmPage
          action={`${MERCHANTS_ACTION}&cancel=${encodeURIComponent(confirmCancel.id)}`}
          hidden={{ intent: "cancel", accountId: confirmCancel.id }}
          title={`Cancel ${who}?`}
          lead="This cannot be undone."
          body={[
            "Every Stripe connection is disconnected, and its access is revoked at Stripe.",
            "Recovery and dispute processing stop for this merchant.",
            "Fees already earned and not yet billed are still billed.",
          ]}
          action_label="Cancel merchant"
          cancelHref={MERCHANTS_PATH}
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
      <MerchantsList merchants={merchants} figures={figures} actionData={actionData} />
    </MessageProvider>
  );
}

type Figures = Route.ComponentProps["loaderData"]["figures"];

function MerchantsList({
  merchants,
  figures,
  actionData,
}: {
  merchants: AdminMerchantRow[];
  figures: Figures;
  actionData: ActionData | undefined;
}) {
  const navigation = useNavigation();
  const revalidating = useRevalidator().state;
  // A row's change reads the rows again; the table is busy until it has.
  const rowsReading = useFetchers().some((f) => f.state === "loading");
  const pending = pagePending(navigation, revalidating, MERCHANTS_PATH) || rowsReading;
  const undoPost = useUndoPost();
  const reading = pending ? <Spinner size="sm" label="Reading again" /> : undefined;
  const mrrAccounts = figures.mrrByCurrency.reduce((n, m) => n + m.accountCount, 0);

  return (
    <div className="grid grid-cols-1 gap-6">
      {actionData ? <PostedResult result={actionData} /> : null}

      <div aria-busy={pending || undefined}>
        <Panel title="Platform" src={reading} description="Demo accounts are not counted.">
          <dl className="m-0 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Figure
              label="Estimated MRR"
              figure={moneyWords(
                figures.mrrByCurrency.map((m) => ({ cents: m.totalCents, currency: m.currency })),
                "No data",
              )}
              detail={mrrAccounts === 0 ? "No MRR snapshots yet" : `Across ${plural(mrrAccounts, "merchant", "merchants")}`}
            />
            <Figure
              label="Connected to Stripe"
              figure={String(figures.connectedCount)}
              detail={`${figures.connectedCount} of ${plural(figures.merchantCount, "merchant", "merchants")}`}
            />
            <Figure label="Total recovered" figure={moneyWords(figures.totalRecovered, "$0.00")} detail="All time" />
            <Figure
              label="Recovery fees this month"
              figure={moneyWords(figures.recoveryFeesThisMonth, "$0.00")}
              detail="Invoiced since the 1st (UTC)"
            />
            <Figure
              label="Payments in queue"
              figure={String(figures.paymentsInQueue)}
              detail="Failed payments in a recovery sequence"
            />
          </dl>
        </Panel>
      </div>

      <div aria-busy={pending || undefined}>
        <Panel
          title="Merchants"
          headingId={HEADING_ID}
          src={reading}
          description={
            merchants.length === 0
              ? undefined
              : `${plural(merchants.length, "account", "accounts")}, newest first. Billing exempt and pause take effect at once and can be undone.`
          }
          flush
        >
          {merchants.length === 0 ? (
            <Empty kind="nothing-yet" title="No merchants yet.">
              A merchant appears here once they sign up for Foxhound.
            </Empty>
          ) : (
            <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={HEADING_ID} tabIndex={0}>
              <table className="cap-table">
                <caption className="cap-sr-only">Every merchant account, newest first, with its actions</caption>
                <thead>
                  <tr>
                    <th scope="col">Merchant</th>
                    <th scope="col">Status</th>
                    <th scope="col">Stripe</th>
                    <th scope="col">Recovery rate</th>
                    <th scope="col" data-num="">
                      Recovered
                    </th>
                    <th scope="col" data-num="" data-drop="1">
                      Active recoveries
                    </th>
                    <th scope="col">Last webhook</th>
                    <th scope="col" data-drop="1">
                      Joined
                    </th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {merchants.map((m) => (
                    <MerchantRow key={m.id} merchant={m} undoPost={undoPost} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Figure({ label, figure, detail }: { label: string; figure: string; detail: string }) {
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-label text-text-secondary">{label}</dt>
      <dd className="m-0 font-mono text-title text-text tabular-nums">{figure}</dd>
      <dd className="m-0 text-label text-text-tertiary">{detail}</dd>
    </div>
  );
}

type UndoPost = (intent: ToggleIntent, accountId: string, value: boolean) => Promise<void>;

/** Undo posts the other value through one shared fetcher and settles when the
 *  answer is back, so Capsomer's message can say it was undone, or why not. */
function useUndoPost(): UndoPost {
  const fetcher = useFetcher<ActionData>({ key: "admin-merchants-undo" });
  const waiting = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const { submit, state, data: answer } = fetcher;

  useEffect(() => {
    if (state !== "idle" || !waiting.current) return;
    const settle = waiting.current;
    waiting.current = null;
    if (answer?.ok) settle.resolve();
    else settle.reject(new Error(answer && !answer.ok ? answer.error : "The server did not answer. Try again."));
  }, [state, answer]);

  return useCallback(
    (intent, accountId, value) =>
      new Promise<void>((resolve, reject) => {
        // One Undo at a time: the message that asked keeps its Undo and says why.
        if (waiting.current) {
          reject(new Error("Another Undo is still running. Try again in a moment."));
          return;
        }
        waiting.current = { resolve, reject };
        void submit({ intent, accountId, value: String(value) }, { method: "post", action: MERCHANTS_ACTION });
      }),
    [submit],
  );
}

function MerchantRow({ merchant: m, undoPost }: { merchant: AdminMerchantRow; undoPost: UndoPost }) {
  const fetcher = useFetcher<ActionData>();
  const { say, fail } = useMessage();
  const busy = fetcher.state !== "idle";
  const who = m.name ?? m.id;
  const status = merchantStatus(m);
  const answer = fetcher.data;

  useEffect(() => {
    if (!answer) return;
    if (!answer.ok) {
      fail(answer.error);
      return;
    }
    if (answer.intent === "cancel") return;
    const words = toggleWords(answer);
    const { intent, accountId, value } = answer;
    say(
      words.said,
      words.undone ? { undo: () => undoPost(intent, accountId, !value), undone: words.undone } : {},
    );
  }, [answer, say, fail, undoPost]);

  return (
    <tr>
      <th scope="row" className="font-normal">
        <Link to={merchantHref(m.id)} className={LINK}>
          {who}
        </Link>
        <span className="block text-text-tertiary">{m.ownerEmail ?? "No owner on record"}</span>
      </th>
      <td>
        <Status tone={status.tone}>{status.word}</Status>
      </td>
      <td>
        <Status tone={m.connectionStatus === "connected" ? "ok" : "nodata"}>{CONNECTION_WORDS[m.connectionStatus]}</Status>
      </td>
      <td>
        {m.recoveryRatePct === null ? (
          <span className="text-text-tertiary">{recoveryRateBand(null)}</span>
        ) : (
          <Status tone={RATE_TONE[recoveryRateTone(m.recoveryRatePct)]} reason={recoveryRateBand(m.recoveryRatePct)} brief>
            {`${m.recoveryRatePct}%`}
          </Status>
        )}
      </td>
      <td data-num="" className={m.recovered.length === 0 ? "text-text-tertiary" : "font-mono text-text"}>
        {moneyWords(m.recovered, "None yet")}
      </td>
      <td data-num="" data-drop="1" className="font-mono text-text">
        {m.activeRecoveriesCount}
      </td>
      <td>
        <AdminTime at={m.lastWebhookAt} empty="None received" />
      </td>
      <td data-drop="1">
        <AdminTime at={m.createdAt} empty="Not recorded" />
      </td>
      <td>
        <div className="flex flex-wrap items-center gap-2">
          {m.stripeUserId ? (
            <a
              href={`https://dashboard.stripe.com/${encodeURIComponent(m.stripeUserId)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="cap-btn"
              data-size="sm"
              data-variant="quiet"
            >
              Stripe
              <ExternalLink data-icon="end" aria-hidden="true" />
              <span className="cap-sr-only"> dashboard for {who} (opens in a new tab)</span>
            </a>
          ) : null}
          <fetcher.Form method="post" action={MERCHANTS_ACTION}>
            <input type="hidden" name="intent" value="billing-exempt" />
            <input type="hidden" name="accountId" value={m.id} />
            <input type="hidden" name="value" value={String(!m.billingExempt)} />
            <button type="submit" className="cap-btn" data-size="sm" disabled={busy}>
              {m.billingExempt ? "End exemption" : "Set exempt"}
              <span className="cap-sr-only"> from billing, {who}</span>
            </button>
          </fetcher.Form>
          <fetcher.Form method="post" action={MERCHANTS_ACTION}>
            <input type="hidden" name="intent" value="processing-paused" />
            <input type="hidden" name="accountId" value={m.id} />
            <input type="hidden" name="value" value={String(!m.processingPaused)} />
            <button type="submit" className="cap-btn" data-size="sm" disabled={busy}>
              {m.processingPaused ? "Resume" : "Pause"}
              <span className="cap-sr-only"> processing for {who}</span>
            </button>
          </fetcher.Form>
          {m.cancelledAt ? null : (
            <Link to={merchantCancelHref(m.id)} className="cap-btn" data-size="sm" data-variant="danger">
              Cancel merchant<span className="cap-sr-only"> {who}</span>
            </Link>
          )}
        </div>
      </td>
    </tr>
  );
}

const RATE_TONE = { green: "ok", caution: "warn", red: "crit" } as const;

/** The answer to a post made without script (a fetcher's answer goes to the
 *  message region instead), or the cancel's answer, which the confirm page
 *  posts as a plain form. A Capsomer banner: it keeps the table below it. */
function PostedResult({ result }: { result: ActionData }) {
  if (!result.ok) {
    return (
      <div className="cap-banner" data-tone="crit" role="alert">
        <Glyph name="crit" />
        <p className="cap-banner-text">{result.error}</p>
      </div>
    );
  }
  if (result.intent === "cancel") {
    const who = result.name ?? result.accountId;
    const said = `Cancelled ${who}. Its Stripe connections are disconnected and its processing has stopped.`;
    return result.warning ? (
      <div className="cap-banner" data-tone="warn" role="status">
        <Glyph name="warn" />
        <div className="cap-banner-body">
          <p className="cap-banner-title">{said}</p>
          <p className="cap-banner-text">Warning: {result.warning}</p>
        </div>
      </div>
    ) : (
      <div className="cap-banner" data-tone="ok" role="status">
        <Glyph name="ok" />
        <p className="cap-banner-text">{said}</p>
      </div>
    );
  }
  const words = toggleWords(result);
  return (
    <div className="cap-banner" data-tone="ok" role="status">
      <Glyph name="ok" />
      <p className="cap-banner-text">{words.said}</p>
      {words.undone ? (
        <div className="cap-banner-actions">
          <Form method="post" action={MERCHANTS_ACTION}>
            <input type="hidden" name="intent" value={result.intent} />
            <input type="hidden" name="accountId" value={result.accountId} />
            <input type="hidden" name="value" value={String(!result.value)} />
            <button type="submit" className="cap-btn">
              Undo
            </button>
          </Form>
        </div>
      ) : null}
    </div>
  );
}
