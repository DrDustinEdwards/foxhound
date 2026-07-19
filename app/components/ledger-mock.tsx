import { Badge } from "~/components/badge";

// The home page hero visual (Phase 6 Pass 1, copy correction #2). Replaces
// legacy components/hero/RecoveryDemo.tsx (an animated recovery-queue demo)
// with a static rendering of the billing evidence ledger: the action ->
// recovery -> fee chain, with a stripe_baseline row visibly marked FREE.
// This mirrors the visual structure of the real, DB-typed rows in
// app/components/billing-ledger-row.tsx (LedgerLineItemRow, LedgerFreeRow)
// but with hardcoded example data, no live query. No competitor can show
// this screen because the evidence chain IS the product.
interface MockRow {
  free: boolean;
  label: string;
  amount: string;
  date: string;
  detail: string;
}

const ROWS: MockRow[] = [
  {
    free: false,
    label: "Recovery fee",
    amount: "$69.80",
    date: "Jun 14",
    detail: "Foxhound retry on Jun 11 recovered $349.00 from Acme Analytics.",
  },
  {
    free: true,
    label: "Stripe baseline, FREE",
    amount: "$129.00",
    date: "Jun 9",
    detail: "No Foxhound action preceded this recovery. Stripe's own retry recovered it.",
  },
  {
    free: false,
    label: "Dispute fee",
    amount: "$84.00",
    date: "Jun 2",
    detail: "Bolt Analytics won a fraudulent dispute for $420.00, evidence reviewed and signed by the merchant.",
  },
  {
    free: false,
    label: "Recovery fee",
    amount: "$25.80",
    date: "May 28",
    detail: "Card update on May 26 recovered $129.00 from Northstar Inc.",
  },
];

export function LedgerMock() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-surface">
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
                <Badge tone={row.free ? "free" : "neutral"}>{row.label}</Badge>
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
