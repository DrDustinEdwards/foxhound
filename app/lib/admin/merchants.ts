// The admin Merchants page's pure helpers (not a .server module: the page
// renders them), tested without a database. The rows come from
// listAdminMerchants and the figures from getMerchantFigures
// (~/lib/admin/merchants.server).

import { PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { formatMoney } from "~/lib/money-format";

export const MERCHANTS_PATH = "/admin/merchants";
/** Where the page's forms post: the index route's own action. */
export const MERCHANTS_ACTION = `${MERCHANTS_PATH}?index`;

/** The Merchants page's three lists, as Recova's Merchants menu had them
 *  (app/admin/admin-nav.ts, blob c5df324c): every merchant, the paused ones and
 *  the billing exempt ones, each at Recova's own address. On the family admin
 *  pattern they are filters of one page, drawn as Capsomer's links form of
 *  tabs ("the better default for admin filters", tabs.md), so Back, a bookmark
 *  and a server render all work. */
export type MerchantView = "all" | "paused" | "billing-exempt";

export const MERCHANT_VIEWS: ReadonlyArray<{ view: MerchantView; label: string; path: string }> = [
  { view: "all", label: "All merchants", path: MERCHANTS_PATH },
  { view: "paused", label: "Paused", path: `${MERCHANTS_PATH}/paused` },
  { view: "billing-exempt", label: "Billing exempt", path: `${MERCHANTS_PATH}/billing-exempt` },
];

export function merchantViewPath(view: MerchantView): string {
  return MERCHANT_VIEWS.find((v) => v.view === view)?.path ?? MERCHANTS_PATH;
}

/** The rows a list shows: exactly those whose flag is set, as Recova's
 *  .eq("processing_paused", true) and .eq("billing_exempt", true) reads did,
 *  so a cancelled merchant still holding the flag stays on the list. */
export function merchantsInView<T extends { processingPaused: boolean; billingExempt: boolean }>(
  rows: readonly T[],
  view: MerchantView,
): T[] {
  if (view === "paused") return rows.filter((r) => r.processingPaused);
  if (view === "billing-exempt") return rows.filter((r) => r.billingExempt);
  return [...rows];
}

/** Where a list's forms post: the list's own address, so a post made without
 *  script lands back on the same list. The index route needs ?index. */
export function merchantsActionFor(view: MerchantView): string {
  return view === "all" ? MERCHANTS_ACTION : merchantViewPath(view);
}

/** The confirm page for cancelling one merchant, on the list it was asked from. */
export function merchantCancelHref(accountId: string, view: MerchantView = "all"): string {
  return `${merchantViewPath(view)}?cancel=${encodeURIComponent(accountId)}`;
}

/** Where that confirm page posts: the list's action, keeping ?cancel so a
 *  mistyped word shows the confirm page again. */
export function merchantCancelAction(accountId: string, view: MerchantView): string {
  const action = merchantsActionFor(view);
  return `${action}${action.includes("?") ? "&" : "?"}cancel=${encodeURIComponent(accountId)}`;
}

/** Cancel cannot be undone (it revokes the Stripe grant), so it is typed
 *  (Capsomer confirm-dialog: "Type a short word only for what cannot be
 *  recovered"). Case does not matter; the server checks it again. */
export const CANCEL_CONFIRM_WORD = "cancel";

export function isCancelConfirmValid(typed: string): boolean {
  return typed.trim().toLowerCase() === CANCEL_CONFIRM_WORD;
}

export type MerchantTone = "crit" | "warn" | "ok" | "info" | "nodata";

/** One status per row, in Recova's order (Paused, then Exempt, then Active,
 *  then Inactive), with Foxhound's Cancelled first: a cancelled merchant is
 *  stopped whatever its flags say. Inactive is Recova's word for a merchant
 *  with no live Stripe connection. */
export function merchantStatus(row: {
  cancelledAt: Date | null;
  processingPaused: boolean;
  pauseReason: string | null;
  billingExempt: boolean;
  connectionStatus: "connected" | "disconnected" | "never_connected";
}): { tone: MerchantTone; word: string } {
  if (row.cancelledAt) return { tone: "crit", word: "Cancelled" };
  if (row.processingPaused) {
    return { tone: "crit", word: row.pauseReason === PAUSE_REASON_BRAKE ? "Paused by brake" : "Paused" };
  }
  if (row.billingExempt) return { tone: "info", word: "Billing exempt" };
  if (row.connectionStatus === "connected") return { tone: "ok", word: "Active" };
  return { tone: "nodata", word: "Inactive" };
}

export const CONNECTION_WORDS = {
  connected: "Connected",
  disconnected: "Disconnected",
  never_connected: "Never connected",
} as const;

/** Amounts in several currencies are never added together (RULES.md 3.20):
 *  each is said once, joined with a plus. */
export function moneyWords(amounts: ReadonlyArray<{ cents: number; currency: string }>, none: string): string {
  return amounts.length === 0 ? none : amounts.map((m) => formatMoney(m.cents, m.currency)).join(" + ");
}

export type ToggleIntent = "billing-exempt" | "processing-paused";

/** What a row is called: its name, else its owner's email (Recova showed the
 *  email when an account had no name), else its id. */
export function merchantLabel(row: { id: string; name: string | null; ownerEmail: string | null }): string {
  return row.name ?? row.ownerEmail ?? row.id;
}

export interface ToggleResult {
  ok: true;
  intent: ToggleIntent;
  accountId: string;
  name: string | null;
  /** The value the flag was asked to hold. */
  value: boolean;
  /** Whether the write changed it. A stale row asking for the value the flag
   *  already holds changes nothing, and has nothing to undo. */
  changed: boolean;
  /** A resume that took a merchant off the emergency brake's books. */
  wasBrakePause: boolean;
}

export interface ToggleMessage {
  said: string;
  /** What the message says once Undo has run. */
  undone: string | null;
  /** The post that undoes it, or null when there is no Undo. */
  undo: { intent: ToggleIntent; accountId: string; value: boolean } | null;
}

/** What a toggle's answer says in the page and the Undo it offers, if any.
 *  The in-page (script) path and the no-script banner both read this, so the
 *  rule is in one place:
 *  - nothing changed: no Undo, it says so;
 *  - a resume of a brake pause: no Undo, because a pause from here is a
 *    person's pause, which the brake's Release leaves alone, so it would not
 *    put back what was there;
 *  - otherwise Undo posts the other value, marked as an Undo, which the
 *    action writes only where the flag still holds what this change set (and
 *    a pause's Undo resumes only a person's pause, never the brake's). */
export function toggleMessage(r: Pick<ToggleResult, "intent" | "accountId" | "name" | "value" | "changed" | "wasBrakePause">): ToggleMessage {
  const who = r.name ?? r.accountId;
  const undo = { intent: r.intent, accountId: r.accountId, value: !r.value };
  if (!r.changed) {
    const already =
      r.intent === "billing-exempt"
        ? r.value
          ? "already billing exempt"
          : "already billed"
        : r.value
          ? "already paused"
          : "already running";
    return { said: `${who} was ${already}. Nothing was changed.`, undone: null, undo: null };
  }
  if (r.intent === "billing-exempt") {
    return r.value
      ? { said: `${who} is billing exempt.`, undone: `${who} is billed again.`, undo }
      : { said: `${who} is billed again.`, undone: `${who} is billing exempt again.`, undo };
  }
  if (r.value) {
    return { said: `Paused processing for ${who}.`, undone: `Processing for ${who} is running again.`, undo };
  }
  if (r.wasBrakePause) {
    return {
      said:
        `Resumed processing for ${who}. The emergency brake had paused it, so there is no Undo: ` +
        "a pause from here is a manual one, which the brake's Release leaves alone.",
      undone: null,
      undo: null,
    };
  }
  return { said: `Resumed processing for ${who}.`, undone: `Processing for ${who} is paused again.`, undo };
}
