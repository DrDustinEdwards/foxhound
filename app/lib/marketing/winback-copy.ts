import { WINBACK_STEP1_HOURS, WINBACK_UNFLAGGED_STEP1_HOURS } from "~/lib/constants";

// The one Recovery timing Intelligence changes, in one sentence for every
// surface that describes it (the Intelligence FAQ and the Platform guide).
// resolveWinbackStep1Offset in app/lib/webhooks/process.ts, legacy parity:
// on an account with Intelligence, a customer not flagged winback_priority has
// win-back step 1 moved from WINBACK_STEP1_HOURS to
// WINBACK_UNFLAGGED_STEP1_HOURS. Nothing writes the flag yet
// (WINBACK_PRIORITY_ACTION has no producer), so the second sentence says so.

const hours = (n: number) => `${n} ${n === 1 ? "hour" : "hours"}`;

export const INTELLIGENCE_WINBACK_SENTENCE = `On an account with Intelligence, the first win-back email after a cancellation waits ${hours(WINBACK_UNFLAGGED_STEP1_HOURS)} instead of ${hours(WINBACK_STEP1_HOURS)}, unless the customer is flagged as a win-back priority. Nothing in Foxhound flags a customer as a win-back priority yet, so today every cancelled customer on such an account waits ${hours(WINBACK_UNFLAGGED_STEP1_HOURS)}.`;
