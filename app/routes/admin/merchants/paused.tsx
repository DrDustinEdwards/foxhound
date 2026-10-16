// Recova's Paused list (app/admin/merchants/paused/page.tsx, blob 43b1cf35) at
// its own address. On the family admin pattern it is a filter of the Merchants
// page (J50), so this is that page's module: the loader reads the list from
// the address, and the action, its writers, Undo and the brake guard are the
// Merchants page's own.
export { action, default, handle, loader, meta } from "./index";
