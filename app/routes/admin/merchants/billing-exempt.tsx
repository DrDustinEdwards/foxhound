// Recova's Billing exempt list (app/admin/merchants/billing-exempt/page.tsx,
// blob a0c4f9da) at its own address. On the family admin pattern it is a
// filter of the Merchants page (J50), so this is that page's module: the loader
// reads the list from the address, and the action, its writers and Undo are
// the Merchants page's own.
import type { AdminHandle } from "~/lib/admin/page";

export { action, default, loader, meta } from "./index";

// One page name: the menu's Merchants, as the list's tab says which list.
export const handle: AdminHandle = { page: "Merchants" };
