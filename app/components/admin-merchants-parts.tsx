// Parts of the admin merchants page (routes/admin/merchants/index.tsx split):
// the merchant list and rows, platform figures, undo posts and the posted result.

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Form, useFetcher, useFetchers, useNavigation, useRevalidator } from "react-router";
import { Link } from "capsomer/react/link";
import { ExternalLink } from "lucide-react";
import { Empty } from "capsomer/react/empty";
import { useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import { Glyph, Status } from "capsomer/react/status";
import { TabLink, TabsNav } from "capsomer/react/tabs";
import { AdminTime } from "~/components/admin-time";
import {
  CONNECTION_WORDS,
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
} from "~/lib/admin/merchants";
import type { AdminMerchantRow } from "~/lib/admin/merchants.server";
import { plural } from "~/lib/admin/overview";
import { merchantHref, pagePending } from "~/lib/admin/page";
import { recoveryRateBand, recoveryRateTone } from "~/lib/dashboard/recovery-rate";
import type { Route } from "../routes/admin/merchants/+types/index";
import type { ActionData } from "../routes/admin/merchants/index";

const HEADING_ID = "admin-merchants-heading";
// Capsomer's cap-table-open stretches the merchant link over the row and lifts
// only links, buttons and checkboxes above it. The times are tooltip triggers
// (hover and focus show the exact time), so my own wrapper lifts them too,
// until Capsomer lifts every focusable element (capsomer job_ea794ed5e851);
// then this wrapper goes.
const ABOVE_ROW_LINK = "relative z-[1]";

type Figures = NonNullable<Route.ComponentProps["loaderData"]["figures"]>;

/** What each list says above its table, and on an empty list. Recova's lists
 *  said the count ("2 merchants paused."); these say it as a sentence, with
 *  what the flag does in Foxhound's engine: billing_exempt and
 *  processing_paused both leave a merchant out of the billing run
 *  (app/db/billable.ts, accountBillingEligibleCondition), and only a pause
 *  stops processing. A pause defers fees: the first run after it clears bills
 *  what matured meanwhile (PR 144 review). An exemption forgives them, as
 *  Recova's did (Dustin, 2026-10-25): a fee earned or due while exempt is never
 *  billed (billing_exemption_periods, read by app/db/billable.ts). */
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
      `${plural(n, "merchant is", "merchants are")} paused, newest first. A paused merchant is neither processed nor billed while paused; fees already earned are billed at the first billing run after it is resumed. Resume takes effect at once and can be undone, except for a merchant the emergency brake paused.`,
  },
  "billing-exempt": {
    caption: "Every billing exempt merchant, newest first, with its actions",
    empty: "No merchants are billing exempt.",
    emptyBody: "A merchant set exempt here appears on this list.",
    describe: (n) =>
      `${plural(n, "merchant is", "merchants are")} billing exempt, newest first. A billing exempt merchant is processed as usual and is not billed while exempt. Fees that come due while exempt are forgiven: they are never billed, even after the exemption ends. Ending an exemption takes effect at once and can be undone.`,
  },
};

export function MerchantsList({
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
            <div className="cap-table-wrap" data-cap="table" data-reflow="wide" role="region" aria-labelledby={HEADING_ID} tabIndex={0}>
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
      <td data-label="Status">
        <Status tone={status.tone}>{status.word}</Status>
      </td>
      <td data-label="Stripe">
        <Status tone={m.connectionStatus === "connected" ? "ok" : "nodata"}>{CONNECTION_WORDS[m.connectionStatus]}</Status>
      </td>
      <td data-label="Recovery rate">
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
      <td data-num="" data-label="Recovered">{moneyWords(m.recovered, "None yet")}</td>
      <td data-num="" data-drop="1" data-label="Active recoveries">
        {m.activeRecoveriesCount}
      </td>
      <td data-label="Last webhook">
        <span className={ABOVE_ROW_LINK}>
          <AdminTime at={m.lastWebhookAt} empty="None received" />
        </span>
      </td>
      <td data-drop="1" data-label="Joined">
        <span className={ABOVE_ROW_LINK}>
          <AdminTime at={m.createdAt} empty="Not recorded" />
        </span>
      </td>
      {/* In the card layout (data-reflow) the buttons take the card's full width. */}
      <td data-label="Actions" className="[grid-column:1/-1]">
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
          <ViewAsForm accountId={m.id} who={who} />
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

/** Recova's row action "Impersonate", as Foxhound's read-only "View as
 *  merchant" (app/lib/admin/impersonation.server.ts). A full document post,
 *  because it leaves /admin for the merchant's app. */
export function ViewAsForm({ accountId, who }: { accountId: string; who: string }) {
  return (
    <Form method="post" action="/admin/view-as" reloadDocument>
      <input type="hidden" name="accountId" value={accountId} />
      <button type="submit" className="cap-btn" data-size="sm">
        View as merchant<span className="cap-sr-only"> {who}, read-only</span>
      </button>
    </Form>
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
    const said = `Canceled ${who}. Its Stripe connections are disconnected and its processing has stopped.`;
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
