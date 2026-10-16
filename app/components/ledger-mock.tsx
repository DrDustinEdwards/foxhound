import { Pill } from "capsomer/react/status";

import { DISPUTE_FEE_BPS, RECOVERY_FEE_BPS } from "~/lib/constants";
import { formatMoney } from "~/lib/money-format";

import "capsomer/status.css";

// The home page hero visual (Phase 6 Pass 1, copy correction #2). Replaces
// legacy components/hero/RecoveryDemo.tsx (an animated recovery-queue demo)
// with a static rendering of the billing evidence ledger: the action ->
// recovery -> fee chain, with a stripe_baseline row visibly marked FREE.
// This mirrors the visual structure of the real, DB-typed rows in
// app/components/billing-ledger-row.tsx (LedgerLineItemRow, LedgerFreeRow)
// but with hardcoded example data, no live query. No competitor can show
// this screen because the evidence chain IS the product.
//
// THREE rows, one per line-item type the ledger can show: a recovery fee, a
// free stripe_baseline row, and a dispute fee. A fourth row shipped
// originally, inside a hero wrapper pinned to a fixed 360px with this card set
// to h-full and overflow-hidden. Measured on the live site, that clipped 62px
// at the desktop column and 135px at a 375px viewport, so the last row was cut
// mid sentence and the caption strip below never rendered at all.
//
// The card now sizes to its OWN content and the hero wrapper carries min-h
// rather than h, so nothing here can be silently cut again. Keep it that way:
// a fixed height on either element brings the whole failure mode back, and it
// reappears at narrow widths first, where every detail line wraps to two.
interface MockRow {
  free: boolean;
  label: string;
  amount: string;
  date: string;
  detail: string;
}

/** A fee on a sample amount, at the engine's rate, so the mock can never show a
 *  fee the billing run would not charge (RULES.md 2.1). */
const fee = (cents: number, bps: number) => formatMoney(Math.round((cents * bps) / 10_000), "usd");

const ROWS: MockRow[] = [
  {
    free: false,
    label: "Recovery fee",
    amount: fee(34_900, RECOVERY_FEE_BPS),
    date: "Jun 14",
    detail: "Foxhound retry on Jun 11 recovered $349.00 from Acme Analytics.",
  },
  {
    free: true,
    label: "Stripe baseline, FREE",
    amount: "$129.00",
    date: "Jun 9",
    detail: "No Foxhound action preceded this recovery. Stripe recovered it.",
  },
  {
    free: false,
    label: "Dispute fee",
    amount: fee(42_000, DISPUTE_FEE_BPS),
    date: "Jun 2",
    detail: "Bolt Analytics won a $420.00 dispute, evidence signed by the merchant.",
  },
];

export function LedgerMock() {
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-1.5 border-b border-border-sub bg-bg px-3 py-2">
        <div className="h-2.5 w-2.5 rounded-full bg-border" />
        <div className="h-2.5 w-2.5 rounded-full bg-border" />
        <div className="h-2.5 w-2.5 rounded-full bg-border" />
        <div className="mx-3 flex-1">
          <div className="rounded border border-border-sub bg-surface px-2 py-0.5 text-center font-mono text-micro text-text-subtle">
            app.foxhoundapp.com/billing
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-border-sub px-4 py-3">
        <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Evidence ledger
        </span>
        <span className="font-mono text-micro text-text-subtle">Sample data</span>
      </div>

      <ol className="flex flex-1 flex-col">
        {ROWS.map((row) => (
          <li
            key={row.detail}
            className="flex flex-col gap-1.5 border-b border-border-sub px-4 py-3 last:border-0"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Pill variant={row.free ? "secondary" : "outline"}>{row.label}</Pill>
                <span className="font-mono text-micro text-text-subtle">{row.date}</span>
              </div>
              <p
                className={`font-mono text-body font-medium ${row.free ? "text-text-tertiary" : "text-text"}`}
              >
                {row.amount}
              </p>
            </div>
            <p className="text-micro text-text-tertiary">{row.detail}</p>
          </li>
        ))}
      </ol>

      <div className="border-t border-border-sub bg-bg px-4 py-2">
        <span className="font-mono text-micro uppercase tracking-wide text-text-subtle">
          Every fee traces to evidence you can click into
        </span>
      </div>
    </div>
  );
}
