import { formatDate } from "capsomer/behavior/time";
import { useEffect, useId, useRef, useState } from "react";
import { useShownFor } from "capsomer/react/hooks";
import { data, useNavigation } from "react-router";
import { Link } from "capsomer/react/link";
import { eq } from "drizzle-orm";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { compareFigures, Delta, type DeltaValue } from "capsomer/react/delta";
import { Segmented } from "capsomer/react/segmented";
import { Switch } from "capsomer/react/switch";
import "capsomer/button.css";
import "capsomer/delta.css";
import "capsomer/empty.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/segmented.css";
import "capsomer/switch.css";
import "capsomer/table.css";
// Capsomer's tokens and the amber family, which the components above read, as
// /settings/audit and /settings/alerts load them.
import "~/site-header.css";

import { AuditSummary } from "~/components/audit/sections";
import { DemoForm, useDemoGuard } from "~/lib/demo/use-demo-guard";
import { accounts, getDb } from "~/db";
import { listAuditRuns } from "~/lib/audit/persist.server";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";
import { formatTotals, toStoredAuditRun } from "~/lib/audit/render";
import { createSaveQueue, type SaveQueue } from "~/lib/audit/save-queue";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { applyAuditSettings } from "~/lib/settings/apply.server";
import { LOOKBACK_OPTIONS, readAuditSettings } from "~/lib/settings/audit-settings";

import type { Route } from "./+types/dashboard";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// J43, row U2: Recova's /audit/dashboard, at Recova's path.
// Read whole at HEAD: app/audit/dashboard/page.tsx (blob 988c190a, 9,206 bytes)
// and app/audit/dashboard/AuditSettingsForm.tsx (blob 9016a436, 3,634 bytes),
// with components/audit/AuditAISummary.tsx (5ba213df) and components/Toggle.tsx
// (0ebdd395).
//
// RECOVA IS THE SPEC for what is on the page and in what order. Populated: the
// header (Audit history, the last run's date, Run new audit), the AI summary,
// Since last run when there are two runs, History, and Settings. Empty: the
// card (No audit runs yet, two lines, Run first audit), then Settings. The
// page keeps Recova's 1280px column and padding. The look is Capsomer 0.9.0's
// (Q10 to Q12): PageHead, Panel, the table, the empty state's markup, the
// segmented control, the switch and the button, amber throughout, and
// text on the five sizes. What Recova's look still needs is
// listed for Capsomer's per-site layer in the J43
// pull request; no Foxhound class sits on a Capsomer element.
//
// THE SETTINGS CARD IS RECOVA'S, AND IT IS NOT A SECOND WRITER. Recova renders
// AuditSettingsForm here as well as at /settings/audit, both writing the same
// two columns. This page posts to its own action, which writes through
// applyAuditSettings, the one core /settings/audit and the MCP
// set_audit_settings tool already share, so there is one write path with two
// forms on it, as in Recova. Like Recova's form it saves as each control
// changes, with no save button, and says Saving, Saved. or Save failed. beside
// it. The controls stay enabled during a save, with aria-busy on the group
// and Capsomer's busy state on the switch, and a change made mid-save is
// queued. Recova appends its raw error code to the failure line ("save_failed");
// that is a raw value shown to a merchant, so it is left off.
//
// TWO TRUTHFULNESS FIXES, both class (c). The digest description drops
// "written by AI", as /settings/audit already does on Dustin's word in 316's
// session. And a figure that could not be read on a run says so instead of
// Recova's `?? 0`, in the table and in Since last run, which
// shows no comparison when either side is unread (compareTotals below).
//
// ONE LINE PER CURRENCY (Dustin, 2026-10-25, parity/APPROVED-DIFFERENCES.md).
// Each money figure is its totals per currency from money_by_currency, read
// through toStoredAuditRun as /audit/results/:id reads them, stacked one line
// per currency in currency-code order. Since last run compares each currency
// with the same currency on the last run. A run stored before that column
// has one figure that may have added currencies together (Recova's sum), so
// it shows what it stored and no change is drawn against it.

export function meta() {
  return [{ title: "Audit history - Foxhound" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const db = getDb(env);

  // Recova reads its last ten runs and the account's two settings together.
  const [runs, settingsRows] = await Promise.all([
    listAuditRuns(db, membership.accountId, 10),
    db
      .select({
        auditLookbackDays: accounts.auditLookbackDays,
        auditAutoRun: accounts.auditAutoRun,
      })
      .from(accounts)
      .where(eq(accounts.id, membership.accountId))
      .limit(1),
  ]);

  return {
    runs: runs.map((row) => {
      // The same mapping the stored-run page uses, so a figure reads the
      // same here as on /audit/results/:id. Null where the scope was not read.
      const run = toStoredAuditRun(row);
      return {
        id: run.id,
        runAt: run.runAt,
        // NULL when the run stored none (compareTotals).
        currency: row.currency,
        perCurrency: row.moneyByCurrency !== null,
        failedInvoices: run.failedInvoices?.totals ?? null,
        openDisputes: run.disputes?.open.totals ?? null,
        mrr: run.health?.mrr ?? null,
        summary: run.summary,
      };
    }),
    settings: readAuditSettings(settingsRows[0] ?? { auditLookbackDays: null, auditAutoRun: null }),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  // A failed write throws (the D1 batch lands or throws), so it is caught,
  // logged whole, and answered 500 with Recova's failure line on the page.
  try {
    const form = await readForm(request, BODY_MAX_BYTES);
    const result = await applyAuditSettings(getDb(env), membership.accountId, {
      lookbackDays: form.get("audit_lookback_days"),
      autoRun: form.get("audit_auto_run"),
    });
    // applyAuditSettings clamps both inputs and either writes or throws, so it
    // has no refusal to report. Were one ever to come back, it is a failed
    // save like any other: thrown, logged whole and answered 500 below.
    if (!result.ok) throw new Error(`audit settings refused: ${result.error}`);
    return data({ ok: true as const, ...result.state });
  } catch (err) {
    console.error("audit dashboard settings write failed:", err);
    return data({ ok: false as const }, { status: 500 });
  }
}

/** One currency's line of a Since last run row. */
interface TrendLine {
  currency: string;
  currentCents: number;
  previousCents: number;
  comparison: DeltaValue;
}

/** One run's side of a money row: its per-currency totals (null when the
 *  scope was not read), and whether the run stored them per currency. */
interface TrendSide {
  totals: readonly { currency: string; cents: number }[] | null;
  currency: string | null;
  perCurrency: boolean;
}

/**
 * A money row compared like with like, one line per currency (Dustin,
 * 2026-10-25, one line per currency): each currency's figure on this run
 * against the same currency's on the last, through Capsomer's compareFigures, in
 * currency-code order. A currency missing from one side is zero there, since
 * the totals leave zeroes out.
 *
 * Null, and so no change drawn, when either side is unread or was stored
 * before money_by_currency. Such a run's one figure may have added several
 * currencies together, so a move against it would be a move nobody made.
 */
function compareTotals(
  current: TrendSide,
  previous: TrendSide,
  higherIsBetter: boolean,
): TrendLine[] | null {
  if (current.totals === null || previous.totals === null) return null;
  if (!current.perCurrency || !previous.perCurrency) return null;
  const cents = (side: readonly { currency: string; cents: number }[], currency: string) =>
    side.find((t) => t.currency === currency)?.cents ?? 0;
  const currencies = [
    ...new Set([...current.totals, ...previous.totals].map((t) => t.currency)),
  ].sort((a, b) => a.localeCompare(b));
  // No money on either run: one zero line in the run's currency, as a
  // single-currency run always showed.
  if (currencies.length === 0)
    currencies.push((current.currency ?? previous.currency ?? "usd").toLowerCase());
  return currencies.map((currency) => {
    const currentCents = cents(current.totals ?? [], currency);
    const previousCents = cents(previous.totals ?? [], currency);
    return {
      currency,
      currentCents,
      previousCents,
      comparison: compareFigures(currentCents, previousCents, { higherIsBetter }),
    };
  });
}

type RunView = Route.ComponentProps["loaderData"]["runs"][number];

/** A stored figure, one line per currency, or "Not read" when the scope was
 *  not read on that run. Recova prints a zero here; a zero that means unknown
 *  is what 362 ruling 2 forbids. */
function Amount({ totals, currency }: { totals: TrendSide["totals"]; currency: string | null }) {
  if (totals === null) return <span className="fh-quiet">Not read</span>;
  const lines = formatTotals(totals, currency ?? "usd");
  if (lines.length === 1) return <>{lines[0]}</>;
  return (
    <span className="fh-auditd-delta">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

/** One of Recova's TrendRows: the label, then this run against the last, then
 *  the move, one line per currency. With no like-for-like comparison (a
 *  scope unread, or a run stored as one total) it shows both runs' figures
 *  and no move. */
function TrendRow({
  label,
  current,
  previous,
  higherIsBetter,
}: {
  label: string;
  current: TrendSide;
  previous: TrendSide;
  higherIsBetter: boolean;
}) {
  const lines = compareTotals(current, previous, higherIsBetter);
  return (
    <div className="fh-auditd-line">
      <div className="fh-small fh-soft">{label}</div>
      {lines === null ? (
        <div className="fh-auditd-figures fh-mono fh-small">
          <span className="fh-text">
            <Amount totals={current.totals} currency={current.currency} />
          </span>
          <span className="fh-faint">
            vs <Amount totals={previous.totals} currency={previous.currency} />
          </span>
        </div>
      ) : (
        <div className="fh-auditd-figure">
          {lines.map((line) => (
            <div key={line.currency} className="fh-auditd-figures fh-mono fh-small">
              <span className="fh-text">{formatMoneyShort(line.currentCents, line.currency)}</span>
              <span className="fh-faint">
                vs {formatMoneyShort(line.previousCents, line.currency)}
              </span>
              <Delta delta={line.comparison} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type SaveResult = { ok: true; lookbackDays: number; autoRun: boolean } | { ok: false } | undefined;

/** Recova's AuditSettingsForm: the lookback period, then the monthly digest,
 *  each saving as it changes, and the status line under them. */
export function AuditSettingsForm({
  defaultLookbackDays,
  defaultAutoRun,
  result,
  saving,
}: {
  defaultLookbackDays: number;
  defaultAutoRun: boolean;
  result: SaveResult;
  saving: boolean;
}) {
  const demo = useDemoGuard({ keepScroll: true });
  const [lookbackDays, setLookbackDays] = useState(String(defaultLookbackDays));
  const [autoRun, setAutoRun] = useState(defaultAutoRun);
  const formRef = useRef<HTMLFormElement>(null);
  const digestLabel = useId();
  const lookbackHelp = useId();
  const digestHelp = useId();

  // Recova clears "Saved." after three seconds and keeps a failure until the
  // next try.
  const [shown] = useShownFor(result, 3000, (r) => r.ok);

  // The control has already changed in the page when its handler runs, so the
  // form posts the new value.
  // The controls are never disabled during a save, because disabling the
  // radio or switch that has focus throws focus to the page body. A change
  // made while a save is in flight is held and sent once that save settles
  // (app/lib/audit/save-queue.ts), so saves cannot land out of order and the
  // last value wins. In the demo ReadOnlyForm refuses the submit in place,
  // so no save ever starts and nothing is queued.
  const queue = useRef<SaveQueue | null>(null);
  queue.current ??= createSaveQueue(() => formRef.current?.requestSubmit());
  const wasSaving = useRef(saving);
  useEffect(() => {
    if (wasSaving.current && !saving) queue.current?.settled();
    wasSaving.current = saving;
  }, [saving]);
  const save = () => {
    if (demo.readOnly) formRef.current?.requestSubmit();
    else queue.current?.change();
  };

  return (
    <DemoForm keepScroll method="post" ref={formRef}>
      <div aria-busy={saving || undefined}>
        <div className="fh-auditd-lookback">
          {/* The visible label repeats the legend's words, which name the group
            for a screen reader, so it is hidden from one to be read once. */}
          <div className="fh-auditd-label fh-small fh-medium fh-text" aria-hidden="true">
            Lookback period
          </div>
          <p id={lookbackHelp} className="fh-auditd-label fh-tiny fh-faint">
            How far back we look when calculating your audit.
          </p>
          <Segmented
            legend={<span className="cap-sr-only">Lookback period</span>}
            name="audit_lookback_days"
            describedBy={lookbackHelp}
            value={lookbackDays}
            onChange={(next) => {
              if (next === lookbackDays) return;
              setLookbackDays(next);
              save();
            }}
            options={LOOKBACK_OPTIONS.map((n) => ({
              value: String(n),
              label: `${n} days`,
            }))}
          />
        </div>

        <div className="fh-auditd-digest">
          <div className="fh-auditd-digest-text">
            <div id={digestLabel} className="fh-auditd-digest-label fh-small fh-text">
              Monthly audit digest
            </div>
            <p id={digestHelp} className="fh-tiny fh-faint">
              On the 1st of each month, we run a fresh audit and email you a comparison versus the
              prior month. No extra charge.
            </p>
          </div>
          {/* Unchecked posts nothing, which the action reads as off. */}
          <Switch
            label={null}
            aria-labelledby={digestLabel}
            name="audit_auto_run"
            value="true"
            checked={autoRun}
            busy={saving}
            onCheckedChange={(next) => {
              setAutoRun(next);
              save();
            }}
            aria-describedby={digestHelp}
          />
        </div>
      </div>

      <div role="status" className="fh-auditd-status fh-tiny">
        {saving ? <span className="fh-faint">Saving…</span> : null}
        {!saving && shown?.ok === true ? <span className="fh-green">Saved.</span> : null}
        {!saving && shown?.ok === false ? <span className="fh-red">Save failed.</span> : null}
      </div>
    </DemoForm>
  );
}

function SettingsPanel({
  settings,
  result,
}: {
  settings: { lookbackDays: number; autoRun: boolean };
  result: SaveResult;
}) {
  const navigation = useNavigation();
  const saving =
    navigation.state === "submitting" && navigation.formMethod?.toUpperCase() === "POST";
  return (
    <div className="fh-auditd-block">
      <Panel title="Settings">
        <AuditSettingsForm
          defaultLookbackDays={settings.lookbackDays}
          defaultAutoRun={settings.autoRun}
          result={result}
          saving={saving}
        />
      </Panel>
    </div>
  );
}

function RunNewAudit({ children }: { children: string }) {
  return (
    <Link to="/audit/connect" className="cap-btn" data-variant="primary">
      {children}
    </Link>
  );
}

export default function AuditDashboard({ loaderData, actionData }: Route.ComponentProps) {
  const { runs, settings } = loaderData;
  const result = actionData as SaveResult;

  // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-10. The shell owns
  // the page's one <main>, so this is a plain wrapper.
  if (runs.length === 0) {
    return (
      <div className="fh-auditd-page cap-admin-page" data-width="page">
        {/* Capsomer's empty state, as markup: its React part puts the title in
            a <p>, and Recova's is the page's h1 (gap named in the J43 PR). */}
        <div className="fh-auditd-head">
          <div className="cap-empty" data-kind="nothing-yet">
            <div className="cap-empty-header">
              <h1 className="cap-empty-title">No audit runs yet</h1>
              <p className="cap-empty-text">Run a full diagnostic of your Stripe account.</p>
              <p className="cap-empty-text">Free, on demand, takes 30 seconds.</p>
            </div>
            <div className="cap-empty-content">
              <RunNewAudit>Run first audit</RunNewAudit>
            </div>
          </div>
        </div>
        <SettingsPanel settings={settings} result={result} />
      </div>
    );
  }

  const last: RunView = runs[0];
  const previous: RunView | undefined = runs[1];
  const at = (run: RunView, totals: TrendSide["totals"]): TrendSide => ({
    totals,
    currency: run.currency,
    perCurrency: run.perCurrency,
  });

  return (
    <div className="fh-auditd-page cap-admin-page" data-width="page">
      <div className="fh-auditd-head">
        <PageHead
          title="Audit history"
          lead={`Last run ${formatDate(last.runAt, { style: "medium" }) ?? ""}`}
          actions={<RunNewAudit>Run new audit</RunNewAudit>}
        />
      </div>

      <AuditSummary summary={last.summary} />

      {previous ? (
        <div className="fh-auditd-block">
          <Panel title="Since last run">
            <TrendRow
              label="Failed invoices"
              current={at(last, last.failedInvoices)}
              previous={at(previous, previous.failedInvoices)}
              higherIsBetter={false}
            />
            <TrendRow
              label="MRR"
              current={at(last, last.mrr)}
              previous={at(previous, previous.mrr)}
              higherIsBetter
            />
            <TrendRow
              label="Open disputes"
              current={at(last, last.openDisputes)}
              previous={at(previous, previous.openDisputes)}
              higherIsBetter={false}
            />
          </Panel>
        </div>
      ) : null}

      <div className="fh-auditd-block">
        <Panel title="History" flush>
          <div
            className="cap-table-wrap"
            data-reflow=""
            data-cap="table"
            role="region"
            aria-label="Audit runs"
            tabIndex={0}
          >
            <table className="cap-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col" data-num="">
                    Failed
                  </th>
                  <th scope="col" data-num="">
                    Disputes
                  </th>
                  <th scope="col" data-num="">
                    MRR
                  </th>
                  <th scope="col" data-num="">
                    <span className="cap-sr-only">View</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <th scope="row">{formatDate(run.runAt, { style: "medium" }) ?? ""}</th>
                    <td data-label="Failed" data-num="" className="fh-mono">
                      <Amount totals={run.failedInvoices} currency={run.currency} />
                    </td>
                    <td data-label="Disputes" data-num="" className="fh-mono">
                      <Amount totals={run.openDisputes} currency={run.currency} />
                    </td>
                    <td data-label="MRR" data-num="" className="fh-mono">
                      <Amount totals={run.mrr} currency={run.currency} />
                    </td>
                    <td data-label="View" data-num="">
                      <Link to={`/audit/results/${run.id}`} className="cap-btn" data-variant="link">
                        View
                        <span className="cap-sr-only">
                          {" "}
                          the run of {formatDate(run.runAt, { style: "medium" }) ?? ""}
                        </span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <SettingsPanel settings={settings} result={result} />
    </div>
  );
}
