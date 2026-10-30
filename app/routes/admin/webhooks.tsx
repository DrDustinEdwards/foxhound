import { useId, useState } from "react";
import { Form, Link, useNavigation, useRevalidator } from "react-router";
import { ChevronRight } from "lucide-react";
import { Empty } from "capsomer/react/empty";
import { Pagination } from "capsomer/react/pagination";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import { StatTile, StatTiles, type StatTileLinkProps } from "capsomer/react/stat-tile";
import { Status } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/pagination.css";
import "capsomer/table.css";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { merchantHref, pagePending, type AdminHandle } from "~/lib/admin/page";
import {
  isFiltered,
  parseWebhookFilters,
  WEBHOOK_PAGE_SIZE,
  WEBHOOKS_PATH,
  webhookCountWords,
  webhookListHref,
} from "~/lib/admin/webhooks";
import { getWebhookHealthSummary, listWebhookEvents, type WebhookEventRow } from "~/lib/admin/webhooks.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/webhooks";
import { NOINDEX } from "~/lib/seo/meta";

export const handle: AdminHandle = { page: "Webhooks" };

export function meta() {
  return [{ title: "Webhooks - Foxhound admin" }, NOINDEX];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const filters = parseWebhookFilters(new URL(request.url).searchParams);
  const [summary, list] = await Promise.all([getWebhookHealthSummary(db), listWebhookEvents(db, filters)]);
  // The page actually served, so the form and the pager agree with the list.
  return { summary, list, filters: { ...filters, page: list.page } };
}

const HEADING_ID = "admin-webhooks-heading";
const COLUMNS = 5;
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "inline-block min-h-6 leading-6 text-text underline underline-offset-2";

// A Capsomer tile is a link or a button; each figure opens the events behind it.
function tileLink({ href, children, ...rest }: StatTileLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14)
// and his review of 2026-10-11: one page name (the shell's "Webhooks"), the
// figures first, then one table in Capsomer's parts with plain sentence-case
// words, relative times with the exact time on hover, a pending state and an
// empty state. Recova's webhook log (app/admin/platform/webhooks, blobs
// b0aaed26 and b0fcce84) is the inventory: the event-type filter, the errors
// only toggle, the account column, the payload opened in place and 50 events a
// page. Filters and pages are links in the address, read by the loader, so the
// list works without script. Read only: nothing here changes an event.
export default function AdminWebhooks({ loaderData }: Route.ComponentProps) {
  const { summary, list, filters } = loaderData;
  const pending = pagePending(useNavigation(), useRevalidator().state, WEBHOOKS_PATH);
  const filtered = isFiltered(filters);
  const typeId = useId();

  return (
    <div className="grid grid-cols-1 gap-6">
      <StatTiles label="Webhook health">
        <StatTile
          href={WEBHOOKS_PATH}
          renderLink={tileLink}
          label="Received"
          figure={String(summary.totalLast24h)}
          detail="In the last 24 hours"
        />
        <StatTile
          href={`${WEBHOOKS_PATH}?errors=1`}
          renderLink={tileLink}
          label="Errors"
          figure={String(summary.errorsLast24h)}
          tone={summary.errorsLast24h > 0 ? "crit" : undefined}
          detail="In the last 24 hours. Opens every event with an error."
        />
        <StatTile
          href={`${WEBHOOKS_PATH}?pending=1`}
          renderLink={tileLink}
          label="Unprocessed"
          figure={String(summary.unprocessedCount)}
          tone={summary.unprocessedCount > 0 ? "crit" : undefined}
          detail="Received and not yet processed"
        />
      </StatTiles>

      <div aria-busy={pending || undefined}>
        <Panel
          title="Webhook events"
          headingId={HEADING_ID}
          src={pending ? <Spinner size="sm" label="Reading again" /> : undefined}
          description={
            filtered
              ? `${webhookCountWords(list.total)} match this filter, newest first.`
              : `${webhookCountWords(list.total)} in the log, newest first.`
          }
          flush
        >
          {/* Keyed by the filters so the fields show the address after Back. */}
          <Form
            key={JSON.stringify(filters)}
            method="get"
            action={WEBHOOKS_PATH}
            className="flex flex-wrap items-end gap-x-4 gap-y-3 border-b border-border px-4 py-3"
          >
            <div className="cap-field min-w-56 grow sm:w-80 sm:grow-0">
              <label className="cap-field-label" htmlFor={typeId}>
                Event type
              </label>
              <input
                className="cap-input"
                id={typeId}
                name="type"
                type="search"
                defaultValue={filters.type}
                placeholder="For example: invoice.payment_failed"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <label className="cap-check min-h-6">
              <input type="checkbox" name="errors" value="1" defaultChecked={filters.errorsOnly} /> Errors only
            </label>
            <label className="cap-check min-h-6">
              <input type="checkbox" name="pending" value="1" defaultChecked={filters.pendingOnly} /> Pending only
            </label>
            <div className="flex items-center gap-3">
              <button type="submit" className="cap-btn">
                Filter
              </button>
              {filtered ? (
                <Link to={WEBHOOKS_PATH} className={LINK}>
                  Clear filter
                </Link>
              ) : null}
            </div>
          </Form>

          {list.events.length === 0 ? (
            filtered ? (
              <Empty
                kind="no-match"
                title="No events match this filter."
                action={
                  <Link to={WEBHOOKS_PATH} className={LINK}>
                    Clear filter
                  </Link>
                }
              />
            ) : (
              <Empty kind="nothing-yet" title="No webhook events recorded yet.">
                Every event Stripe sends to Foxhound appears here as it arrives.
              </Empty>
            )
          ) : (
            <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={HEADING_ID} tabIndex={0}>
              <table className="cap-table">
                <caption className="cap-sr-only">
                  Webhook events, newest first. Open an event type to see its payload.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Event type</th>
                    <th scope="col">Account</th>
                    <th scope="col">Status</th>
                    <th scope="col">Received</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {list.events.map((e) => (
                    <EventRows key={e.id} event={e} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {list.pageCount > 1 ? (
            <div className="border-t border-border px-4 py-3">
              <Pagination
                page={list.page}
                pageCount={list.pageCount}
                total={list.total}
                perPage={WEBHOOK_PAGE_SIZE}
                noun="events"
                hrefFor={(n) => webhookListHref(filters, n)}
                label="Webhook event pages"
              />
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

/** One event and, under it, its payload across the whole table, opened by the
 *  event type's button (aria-expanded, aria-controls), so Enter or Space
 *  opens it and a screen reader hears the state. */
function EventRows({ event }: { event: WebhookEventRow }) {
  const [open, setOpen] = useState(false);
  const payloadId = useId();

  return (
    <>
      <tr>
        <th scope="row" className="font-normal">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={payloadId}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-sm text-left font-mono text-micro text-text hover:underline"
          >
            <ChevronRight
              aria-hidden="true"
              className={`size-4 shrink-0 text-text-tertiary transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            />
            <span className="break-all">{event.eventType}</span>
            <span className="cap-sr-only"> payload</span>
          </button>
        </th>
        <td>
          {event.accountId ? (
            <Link to={merchantHref(event.accountId)} className={`${LINK} font-mono text-micro break-all`}>
              {event.accountId}
            </Link>
          ) : (
            <span className="text-text-tertiary">No account</span>
          )}
        </td>
        <td>
          {event.errorMessage ? (
            <Status tone="crit">Error</Status>
          ) : event.processed ? (
            <Status tone="ok">Processed</Status>
          ) : (
            <Status tone="info">Pending</Status>
          )}
        </td>
        <td>
          <AdminTime at={event.receivedAt} />
        </td>
        <td data-wrap="" className={event.errorMessage ? "text-error-text" : "text-text-tertiary"}>
          {event.errorMessage ?? "None"}
        </td>
      </tr>
      <tr id={payloadId} hidden={!open}>
        <td colSpan={COLUMNS}>
          <pre
            tabIndex={0}
            aria-label={`${event.eventType} payload`}
            className="m-0 max-h-96 overflow-auto rounded-md border border-border bg-sunken p-3 font-mono text-micro text-text"
          >
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </td>
      </tr>
    </>
  );
}
