// Nav paths that more than one module has to agree on. Client-safe: no server
// imports, so the switcher component can read it without dragging a .server
// module into the client bundle.

/** Where the switcher's "+ Add account" row goes. That last part is the point. */
export const ADD_ACCOUNT_PATH = "/connect/additional";
