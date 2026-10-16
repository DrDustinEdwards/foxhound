import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { data, Form, Link, useFetcher, useFetchers, useNavigation, useRevalidator } from "react-router";
import { ExternalLink } from "lucide-react";
import { ConfirmPage } from "capsomer/react/confirm-dialog";
import { Empty } from "capsomer/react/empty";
import { MessageProvider, useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import { Glyph, Status } from "capsomer/react/status";
import { TabLink, TabsNav } from "capsomer/react/tabs";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/confirm-dialog.css";
import "capsomer/field.css";
import "capsomer/message.css";
import "capsomer/tabs.css";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { PAUSE_REASON_BRAKE, PAUSE_REASON_MANUAL } from "~/lib/admin/brake";
import { adminContext } from "~/lib/admin/context";
import { loadMerchantsPage } from "~/lib/admin/merchants-page.server";
import {
  CANCEL_CONFIRM_WORD,
  CONNECTION_WORDS,
  isCancelConfirmValid,
  merchantCancelAction,
  merchantCancelHref,
  merchantStatus,
  MERCHANT_VIEWS,
  merchantsActionFor,
  MERCHANTS_PATH,
  merchantLabel,
  merchantViewPath,
  moneyWords,
  toggleMessage,
  type MerchantView,
  type ToggleIntent,
  type ToggleResult,
} from "~/lib/admin/merchants";
import {
  cancelMerchant,
  getMerchantActionTarget,
  setBillingExemptIfChanged,
  setProcessingPausedIfChanged,
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

// This module serves three addresses (routes.ts): every merchant here, and
// Recova's Paused and Billing exempt lists (J50), whose route modules pass
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
interface Cancelled {
  ok: true;
  intent: "cancel";
  accountId: string;
  name: string | null;
  warning?: string;
}
type ActionData = ToggleResult | Cancelled | Refused;

const refuse = (intent: string, error: string, status = 400) =>
  data<ActionData>({ ok: false, intent, error }, { status });

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
      ? await setBillingExemptIfChanged(db, accountId, value)
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

const HEADING_ID = "admin-merchants-heading";
// Capsomer's cap-table-open stretches the merchant link over the row and lifts
// only links, buttons and checkboxes above it. The times are tooltip triggers
// (hover and focus show the exact time), so my own wrapper lifts them too,
// until Capsomer lifts every focusable element (capsomer job_ea794ed5e851);
// then this wrapper goes.
const ABOVE_ROW_LINK = "relative z-[1]";

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
//
// Recova's Paused and Billing exempt lists (J50) are this page filtered, in
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

type Figures = NonNullable<Route.ComponentProps["loaderData"]["figures"]>;

/** What each list says above its table, and on an empty list. Recova's lists
 *  said the count ("2 merchants paused."); these say it as a sentence, with
 *  what the flag does in Foxhound's engine: billing_exempt and
 *  processing_paused both leave a merchant out of the billing run
 *  (app/db/billable.ts, accountBillingEligibleCondition), and only a pause
 *  stops processing. */
const VIEW_WORDS: Record<
  MerchantView,
  { caption: string; empty: string; emptyBody: string; describe: (n: number) => string }
> = {
  all: {
    caption: "Every merchant account, newest first, with its actions",
    empty: "No merchants yet.",
    emptyBody: "A merchant appears here once they sign up for Foxhound.",
    describe: (n) =>
      `${plural(n, "account", "accounts")}, newest first. Billing exempt and pause take effect at once and can be undone.`,
  },
  paused: {
    caption: "Every paused merchant, newest first, with its actions",
    empty: "No merchants are paused.",
    emptyBody: "A merchant paused here, or by the emergency brake, appears on this list.",
    describe: (n) =>
      `${plural(n, "merchant is", "merchants are")} paused, newest first. A paused merchant is neither processed nor billed until it is resumed. Resume takes effect at once and can be undone.`,
  },
  "billing-exempt": {
    caption: "Every billing exempt merchant, newest first, with its actions",
    empty: "No merchants are billing exempt.",
    emptyBody: "A merchant set exempt here appears on this list.",
    describe: (n) =>
      `${plural(n, "merchant is", "merchants are")} billing exempt, newest first. A billing exempt merchant is processed as usual and never billed. Ending an exemption takes effect at once and can be undone.`,
  },
};

function MerchantsList({
  view,
  merchants,
  counts,
  brakePaused,
  figures,
  actionData,
}: {
  view: MerchantView;
  merchants: AdminMerchantRow[];
  counts: Record<MerchantView, number>;
  brakePaused: number;
  figures: Figures | null;
  actionData: ActionData | undefined;
}) {
  const navigation = useNavigation();
  const revalidating = useRevalidator().state;
  // A row's change reads the rows again; the table is busy until it has.
  const rowsReading = useFetchers().some((f) => f.state === "loading");
  const pending = pagePending(navigation, revalidating, merchantViewPath(view)) || rowsReading;
  const action = merchantsActionFor(view);
  const undoPost = useUndoPost(action);
  const reading = pending ? <Spinner size="sm" label="Reading again" /> : undefined;
  const words = VIEW_WORDS[view];

  return (
    <div className="grid grid-cols-1 gap-6">
      {actionData ? <PostedResult result={actionData} action={action} /> : null}

      {figures ? <PlatformFigures figures={figures} pending={pending} reading={reading} /> : null}

      <TabsNav aria-label="Filter merchants" variant="line" renderLink={({ href, ...props }) => <Link to={href} {...props} />}>
        {MERCHANT_VIEWS.map((v) => (
          <TabLink key={v.view} href={v.path} current={v.view === view} count={counts[v.view]}>
            {v.label}
          </TabLink>
        ))}
      </TabsNav>

      <div aria-busy={pending || undefined}>
        <Panel
          title="Merchants"
          headingId={HEADING_ID}
          src={reading}
          description={
            merchants.length === 0 ? undefined : (
              <>
                {words.describe(merchants.length)}
                {view === "paused" && brakePaused > 0 ? (
                  <>
                    {" "}
                    {brakePaused} of them {brakePaused === 1 ? "is" : "are"} held by the{" "}
                    <Link to="/admin/brake">emergency brake</Link>, whose Release resumes{" "}
                    {brakePaused === 1 ? "it" : "them"}.
                  </>
                ) : null}
              </>
            )
          }
          flush
        >
          {merchants.length === 0 ? (
            view === "all" ? (
              <Empty kind="nothing-yet" title={words.empty}>
                {words.emptyBody}
              </Empty>
            ) : (
              <Empty
                kind="no-match"
                title={words.empty}
                action={
                  <Link to={MERCHANTS_PATH} className="cap-btn">
                    Show all merchants
                  </Link>
                }
              >
                {words.emptyBody}
              </Empty>
            )
          ) : (
            <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={HEADING_ID} tabIndex={0}>
              <table className="cap-table">
                <caption className="cap-sr-only">{words.caption}</caption>
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
                    <MerchantRow key={m.id} merchant={m} view={view} undoPost={undoPost} />
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

function PlatformFigures({ figures, pending, reading }: { figures: Figures; pending: boolean; reading: ReactNode }) {
  const mrrAccounts = figures.mrrByCurrency.reduce((n, m) => n + m.accountCount, 0);
  return (
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
function useUndoPost(action: string): UndoPost {
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
        void submit({ intent, accountId, value: String(value), undo: "1" }, { method: "post", action });
      }),
    [submit, action],
  );
}

function MerchantRow({ merchant: m, view, undoPost }: { merchant: AdminMerchantRow; view: MerchantView; undoPost: UndoPost }) {
  const fetcher = useFetcher<ActionData>();
  const { say, fail } = useMessage();
  const busy = fetcher.state !== "idle";
  const who = merchantLabel(m);
  const status = merchantStatus(m);
  const answer = fetcher.data;
  const action = merchantsActionFor(view);

  useEffect(() => {
    if (!answer) return;
    if (!answer.ok) {
      fail(answer.error);
      return;
    }
    if (answer.intent === "cancel") return;
    const message = toggleMessage(answer);
    const { undo } = message;
    say(
      message.said,
      undo && message.undone
        ? { undo: () => undoPost(undo.intent, undo.accountId, undo.value), undone: message.undone }
        : {},
    );
  }, [answer, say, fail, undoPost]);

  return (
    <tr>
      <th scope="row">
        <Link to={merchantHref(m.id)} className="cap-table-open">
          {who}
        </Link>
        {m.name && m.ownerEmail ? <span className="cap-table-aside">{m.ownerEmail}</span> : null}
        {m.ownerEmail ? null : <span className="cap-table-aside">No owner on record</span>}
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
          // The band as words beside the rate: a hover title would sit under
          // the row's stretched link and never reach a mouse (PR 140 review).
          <Status tone={RATE_TONE[recoveryRateTone(m.recoveryRatePct)]} reason={recoveryRateBand(m.recoveryRatePct)}>
            {`${m.recoveryRatePct}%`}
          </Status>
        )}
      </td>
      <td data-num="">{moneyWords(m.recovered, "None yet")}</td>
      <td data-num="" data-drop="1">
        {m.activeRecoveriesCount}
      </td>
      <td>
        <span className={ABOVE_ROW_LINK}>
          <AdminTime at={m.lastWebhookAt} empty="None received" />
        </span>
      </td>
      <td data-drop="1">
        <span className={ABOVE_ROW_LINK}>
          <AdminTime at={m.createdAt} empty="Not recorded" />
        </span>
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
          <fetcher.Form method="post" action={action}>
            <input type="hidden" name="intent" value="billing-exempt" />
            <input type="hidden" name="accountId" value={m.id} />
            <input type="hidden" name="value" value={String(!m.billingExempt)} />
            <button type="submit" className="cap-btn" data-size="sm" disabled={busy}>
              {m.billingExempt ? "End exemption" : "Set exempt"}
              <span className="cap-sr-only"> from billing, {who}</span>
            </button>
          </fetcher.Form>
          <fetcher.Form method="post" action={action}>
            <input type="hidden" name="intent" value="processing-paused" />
            <input type="hidden" name="accountId" value={m.id} />
            <input type="hidden" name="value" value={String(!m.processingPaused)} />
            <button type="submit" className="cap-btn" data-size="sm" disabled={busy}>
              {m.processingPaused ? "Resume" : "Pause"}
              <span className="cap-sr-only"> processing for {who}</span>
            </button>
          </fetcher.Form>
          {m.cancelledAt ? null : (
            <Link to={merchantCancelHref(m.id, view)} className="cap-btn" data-size="sm" data-variant="danger">
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
function PostedResult({ result, action }: { result: ActionData; action: string }) {
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
  const message = toggleMessage(result);
  return (
    <div className="cap-banner" data-tone="ok" role="status">
      <Glyph name="ok" />
      <p className="cap-banner-text">{message.said}</p>
      {message.undo ? (
        <div className="cap-banner-actions">
          <Form method="post" action={action}>
            <input type="hidden" name="intent" value={message.undo.intent} />
            <input type="hidden" name="accountId" value={message.undo.accountId} />
            <input type="hidden" name="value" value={String(message.undo.value)} />
            <input type="hidden" name="undo" value="1" />
            <button type="submit" className="cap-btn">
              Undo
            </button>
          </Form>
        </div>
      ) : null}
    </div>
  );
}
