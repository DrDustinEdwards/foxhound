import { trackPageDates, type PageRecord } from "@drdustinedwards/site-helpers/lastmod";
import { htmlToMarkdown } from "@drdustinedwards/site-helpers/markdown-copy";
import { sql } from "drizzle-orm";
import { inList, chunked, rowsPerInsert } from "@dustinedwards/site-runtime/d1";

import { getDb, pageDateRows, type Db } from "~/db";
import type { CronHandler } from "~/lib/cron/run";
import { siteUrl } from "~/lib/seo/jsonld";

// The day each code-written page of /sitemap.xml last changed. No row dates these pages (marketing, docs, decline codes,
// comparisons), so the daily page-dates job reads each as Markdown, the way the Markdown copies are made, with Prelum's
// trackPageDates, and keeps the day its text last changed in page_dates. The sitemap reads it back with loadPageDates.

/** Renders a path through the Worker's own page handler and returns its HTML, or null when it is not a page. workers/app.ts sets it. */
export type PageRenderer = (path: string, env: Env) => Promise<string | null>;
let renderPage: PageRenderer | undefined;
export function setPageRenderer(renderer: PageRenderer): void {
  renderPage = renderer;
}

/** Every row of page_dates as the record Prelum's trackPageDates and pageDates take. */
export async function loadPageDates(db: Db): Promise<PageRecord> {
  const rows = await db.select().from(pageDateRows);
  return Object.fromEntries(rows.map((r) => [r.path, { hash: r.hash, lastmod: r.lastmod }]));
}

async function savePageDates(db: Db, record: PageRecord): Promise<void> {
  const previous = await loadPageDates(db);
  const changed = Object.entries(record).filter(
    ([path, entry]) => previous[path]?.hash !== entry.hash,
  );
  // D1 takes 100 bound variables a statement: three columns, so rowsPerInsert(3) rows at a time.
  for (const part of chunked(changed, rowsPerInsert(3))) {
    await db
      .insert(pageDateRows)
      .values(part.map(([path, entry]) => ({ path, ...entry })))
      .onConflictDoUpdate({
        target: pageDateRows.path,
        set: { hash: sqlExcluded("hash"), lastmod: sqlExcluded("lastmod") },
      });
  }
  const gone = Object.keys(previous).filter((path) => !(path in record));
  if (gone.length > 0) await db.delete(pageDateRows).where(inList(pageDateRows.path, gone));
}

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

/** The daily job: date every code-written page of the sitemap. */
export const runPageDates: CronHandler = async (env) => {
  if (!renderPage) throw new Error("page-dates: no page renderer is set");
  const render = renderPage;
  const { codePagePaths } = await import("~/routes/files/sitemap");
  const origin = siteUrl(env);
  const db = getDb(env);
  const { record, changed } = await trackPageDates({
    paths: codePagePaths(),
    read: async (path) => {
      const html = await render(path, env);
      if (html === null) return null;
      const facts = htmlToMarkdown(html, { base: `${origin}${path}` });
      return `${facts.title}\n${facts.description}\n${facts.markdown}`;
    },
    load: () => loadPageDates(db),
    save: (next) => savePageDates(db, next),
  });
  return {
    rowsProcessed: Object.keys(record).length,
    message: changed ? "page dates updated" : "no page changed",
  };
};
