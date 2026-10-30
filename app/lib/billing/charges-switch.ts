// Hard rule 12: no paying merchant's money moves until the LLC exists. This is
// the switch, off until then, and flipping it is a reviewed one-line PR. While
// it is off the monthly run still writes the ledger (invoices stay draft and
// visible), but nothing creates, finalizes or pays a Stripe invoice and the
// charge-retry sweep does not run, so no draft is marked failed in the
// meantime. It is a constant, not a D1 row or a var, so a restore, a reseed or
// a deploy cannot turn charging on by accident.
export const PLATFORM_CHARGES_ENABLED = false;
