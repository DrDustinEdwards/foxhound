import { useEffect, useId, useRef, useState } from "react";
import { data, useNavigation, useRouteLoaderData } from "react-router";
import { Link } from "capsomer/react/link";
import { eq } from "drizzle-orm";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import { Switch } from "capsomer/react/switch";
import "capsomer/button.css";
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
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { accounts, getDb } from "~/db";
import type { loader as appShellLoader } from "~/layouts/app-shell";
import { listAuditRuns } from "~/lib/audit/persist.server";
import { formatCents, formatTotals, toStoredAuditRun } from "~/lib/audit/render";
import { createSaveQueue, type SaveQueue } from "~/lib/audit/save-queue";
import { compareTotals, type TrendComparison, type TrendSide } from "~/lib/audit/trend";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { applyAuditSettings } from "~/lib/settings/apply.server";
import { LOOKBACK_OPTIONS, readAuditSettings } from "~/lib/settings/audit-settings";

import type { Route } from "./+types/dashboard";
import { NOINDEX } from "~/lib/seo/meta";
import { formatDateShort } from "~/lib/date-format";
import { readForm } from "~/lib/http/body";

// J43, row U2: Recova's /audit/dashboard, at Recova's path.
// Read whole at HEAD: app/audit/dashboard/page.tsx (blob 988c190a, 9,206 bytes)
// and app/audit/dashboard/AuditSettingsForm.tsx (blob 9016a436, 3,634 bytes),
// with components/audit/AuditAISummary.tsx (5ba213df) and components/Toggle.tsx
// (0ebdd395). The old /audit/history answers one 301 here
// (app/routes/audit/history-redirect.ts).
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
// shows no comparison when either side is unread (app/lib/audit/trend.ts).
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
        // NULL when the run stored none (trend.ts).
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
    const form = await readForm(request);
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

type RunView = Route.ComponentProps["loaderData"]["runs"][number];

/** A stored figure, one line per currency, or "Not read" when the scope was
 *  not read on that run. Recova prints a zero here; a zero that means unknown
 *  is what 362 ruling 2 forbids. */
function Amount({ totals, currency }: { totals: TrendSide["totals"]; currency: string | null }) {
  if (totals === null) return <span className="text-text-tertiary">Not read</span>;
  const lines = formatTotals(totals, currency ?? "usd");
  if (lines.length === 1) return <>{lines[0]}</>;
  return (
    <span className="inline-flex flex-col items-end">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

/** Recova's move: the arrow is drawn, and the direction is also in words for
 *  a screen reader, so the color is never the only signal. */
function Move({ cmp }: { cmp: TrendComparison }) {
  if (cmp.kind === "unchanged") return <span className="text-text-subtle">no change</span>;
  if (cmp.kind !== "moved") return null;
  return (
    <span className={cmp.tone === "good" ? "text-green" : "text-red"}>
      <span aria-hidden="true">{cmp.direction === "up" ? "▲" : "▼"}</span>
      <span className="sr-only">{cmp.direction}</span> {cmp.deltaPct}%
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
    <div className="flex items-baseline justify-between gap-4 border-b border-border-sub py-2 last:border-b-0">
      <div className="text-label text-text-secondary">{label}</div>
      {lines === null ? (
        <div className="flex flex-wrap items-baseline justify-end gap-2 font-mono text-label">
          <span className="text-text">
            <Amount totals={current.totals} currency={current.currency} />
          </span>
          <span className="text-text-subtle">
            vs <Amount totals={previous.totals} currency={previous.currency} />
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-end gap-1">
          {lines.map((line) => (
            <div key={line.currency} className="flex flex-wrap items-baseline justify-end gap-2 font-mono text-label">
              <span className="text-text">{formatCents(line.currentCents, line.currency)}</span>
              <span className="text-text-subtle">vs {formatCents(line.previousCents, line.currency)}</span>
              <Move cmp={line.comparison} />
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
  const [lookbackDays, setLookbackDays] = useState(String(defaultLookbackDays));
  const [autoRun, setAutoRun] = useState(defaultAutoRun);
  const formRef = useRef<HTMLFormElement>(null);
  const isDemo = Boolean(useRouteLoaderData<typeof appShellLoader>("app-shell")?.isDemo);
  const digestLabel = useId();
  const lookbackHelp = useId();
  const digestHelp = useId();

  // Recova clears "Saved." after three seconds and keeps a failure until the
  // next try.
  const [dismissed, setDismissed] = useState<SaveResult>(undefined);
  const shown = result !== dismissed ? result : undefined;
  useEffect(() => {
    if (!result?.ok) return;
    const timer = setTimeout(() => setDismissed(result), 3000);
    return () => clearTimeout(timer);
  }, [result]);

  // The control has already changed in the page when its handler runs, so the
  // form posts the new value.
  // The controls are never disabled during a save, because disabling the
  // radio or switch that has focus throws focus to the page body. A change
  // made while a save is in flight is held and sent once that save settles
  // (app/lib/audit/save-queue.ts), so saves cannot land out of order and the
  // last value wins. In the demo DemoGuardedForm refuses the submit in place,
  // so no save ever starts and nothing is queued.
  const queue = useRef<SaveQueue | null>(null);
  queue.current ??= createSaveQueue(() => formRef.current?.requestSubmit());
  const wasSaving = useRef(saving);
  useEffect(() => {
    if (wasSaving.current && !saving) queue.current?.settled();
    wasSaving.current = saving;
  }, [saving]);
  const save = () => {
    if (isDemo) formRef.current?.requestSubmit();
    else queue.current?.change();
  };

  return (
    <DemoGuardedForm method="post" ref={formRef} preventScrollReset>
      <div aria-busy={saving || undefined}>
        <div className="mb-5 min-w-0">
          {/* The visible label repeats the legend's words, which name the group
            for a screen reader, so it is hidden from one to be read once. */}
          <div className="mb-1 text-label font-medium text-text" aria-hidden="true">
            Lookback period
          </div>
          <p id={lookbackHelp} className="m-0 mb-1 text-micro text-text-subtle">
            How far back we look when calculating your audit.
          </p>
          <Segmented
            legend={<span className="sr-only">Lookback period</span>}
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

        <div className="flex min-w-0 items-start justify-between gap-4 border-t border-border py-3">
          <div className="pr-4">
            <div id={digestLabel} className="mb-0.5 text-label text-text">
              Monthly audit digest
            </div>
            <p id={digestHelp} className="m-0 text-micro text-text-subtle">
              On the 1st of each month, we run a fresh audit and email you a comparison versus the prior
              month. No extra charge.
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

      <div role="status" className="mt-3 min-h-4 text-micro">
        {saving ? <span className="text-text-subtle">Saving…</span> : null}
        {!saving && shown?.ok === true ? <span className="text-green">Saved.</span> : null}
        {!saving && shown?.ok === false ? <span className="text-red">Save failed.</span> : null}
      </div>
    </DemoGuardedForm>
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
  const saving = navigation.state === "submitting" && navigation.formMethod?.toUpperCase() === "POST";
  return (
    <div className="mb-5">
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
      <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8">
        {/* Capsomer's empty state, as markup: its React part puts the title in
            a <p>, and Recova's is the page's h1 (gap named in the J43 PR). */}
        <div className="mb-6">
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
    <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8">
      <div className="mb-6">
        <PageHead
          title="Audit history"
          lead={`Last run ${formatDateShort(last.runAt)}`}
          actions={<RunNewAudit>Run new audit</RunNewAudit>}
        />
      </div>

      <AuditSummary summary={last.summary} />

      {previous ? (
        <div className="mb-5">
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

      <div className="mb-5">
        <Panel title="History" flush>
          <div className="cap-table-wrap" data-reflow="" data-cap="table" role="region" aria-label="Audit runs" tabIndex={0}>
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
                    <span className="sr-only">View</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <th scope="row">{formatDateShort(run.runAt)}</th>
                    <td data-label="Failed" data-num="" className="font-mono">
                      <Amount totals={run.failedInvoices} currency={run.currency} />
                    </td>
                    <td data-label="Disputes" data-num="" className="font-mono">
                      <Amount totals={run.openDisputes} currency={run.currency} />
                    </td>
                    <td data-label="MRR" data-num="" className="font-mono">
                      <Amount totals={run.mrr} currency={run.currency} />
                    </td>
                    <td data-label="View" data-num="">
                      <Link to={`/audit/results/${run.id}`} className="cap-btn" data-variant="link">
                        View
                        <span className="sr-only"> the run of {formatDateShort(run.runAt)}</span>
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
