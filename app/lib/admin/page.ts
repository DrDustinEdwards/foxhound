// Every admin route names its page in its `handle`, and the admin shell's top
// bar shows it (the page's one heading). A detail page names itself from its
// own loader data. One name per page: the menu entry, the top bar and the tab
// title say the same thing (Dustin's review, 2026-10-11). The merchant app's
// shell reads the same handle for a page its menu rows do not name.
export interface AdminHandle<Data = unknown> {
  page: string | ((data: Data) => string);
}

export function adminPageName(
  matches: ReadonlyArray<{ handle?: unknown; loaderData?: unknown; data?: unknown }>,
): string | null {
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const handle = matches[i].handle as AdminHandle | undefined;
    if (!handle?.page) continue;
    if (typeof handle.page === "string") return handle.page;
    const data = matches[i].loaderData ?? matches[i].data;
    return data ? handle.page(data) : null;
  }
  return null;
}

/** A page's own lists are pending while its data is read again (the
 *  revalidator, or a navigation that lands on this page), not while the admin
 *  is leaving for another page. "/admin/users/" is the same page as
 *  "/admin/users" (the patterns.md "Loading" rule). */
export function pagePending(
  navigation: { state: string; location?: { pathname: string } },
  revalidatorState: string,
  pathname: string,
): boolean {
  if (revalidatorState === "loading") return true;
  if (navigation.state !== "loading" || !navigation.location) return false;
  return trimSlash(navigation.location.pathname) === trimSlash(pathname);
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/** A merchant's admin page. */
export function merchantHref(accountId: string): string {
  return `/admin/merchants/${encodeURIComponent(accountId)}`;
}
