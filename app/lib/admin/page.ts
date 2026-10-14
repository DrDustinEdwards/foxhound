// Every admin route names its page in its `handle`, and the admin shell's top
// bar shows it (the page's one heading). A detail page names itself from its
// own loader data. One name per page: the menu entry, the top bar and the tab
// title say the same thing (Dustin's review, 2026-10-11).
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
