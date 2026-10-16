// The admin Merchants page's pure helpers (not a .server module: the page
// renders them), tested without a database. The rows come from
// listAdminMerchants and the figures from getMerchantFigures
// (~/lib/admin/merchants.server).

import { PAUSE_REASON_BRAKE } from "~/lib/admin/brake";
import { formatMoney } from "~/lib/money-format";

export const MERCHANTS_PATH = "/admin/merchants";
/** Where the page's forms post: the index route's own action. */
export const MERCHANTS_ACTION = `${MERCHANTS_PATH}?index`;

/** The confirm page for cancelling one merchant. */
export function merchantCancelHref(accountId: string): string {
  return `${MERCHANTS_PATH}?cancel=${encodeURIComponent(accountId)}`;
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

export interface ToggleResult {
  ok: true;
  intent: ToggleIntent;
  accountId: string;
  name: string | null;
  /** The value the flag was set to. */
  value: boolean;
  /** A resume that took a merchant off the emergency brake's books. */
  wasBrakePause: boolean;
}

/** What a toggle did, in a sentence, what its Undo says once it has run, and
 *  whether it has an Undo at all. A resume of a brake pause has none: pausing
 *  again from here is a person's pause, which the brake's Release leaves
 *  alone, so it would not put back what was there (setProcessingPaused). */
export function toggleWords(r: Pick<ToggleResult, "intent" | "accountId" | "name" | "value" | "wasBrakePause">): {
  said: string;
  undone: string | null;
} {
  const who = r.name ?? r.accountId;
  if (r.intent === "billing-exempt") {
    return r.value
      ? { said: `${who} is billing exempt.`, undone: `${who} is billed again.` }
      : { said: `${who} is billed again.`, undone: `${who} is billing exempt again.` };
  }
  if (r.value) {
    return { said: `Paused processing for ${who}.`, undone: `Processing for ${who} is running again.` };
  }
  if (r.wasBrakePause) {
    return {
      said:
        `Resumed processing for ${who}. The emergency brake had paused it, so there is no Undo: ` +
        "a pause from here is a manual one, which the brake's Release leaves alone.",
      undone: null,
    };
  }
  return { said: `Resumed processing for ${who}.`, undone: `Processing for ${who} is paused again.` };
}
