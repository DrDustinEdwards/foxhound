import { useId } from "react";
import { Form, useNavigation, useRevalidator } from "react-router";
import { Link, routerRenderLink } from "capsomer/react/link";
import { ExpandRows } from "capsomer/react/disclosure";
import { Empty } from "capsomer/react/empty";
import { Pagination, pageHref } from "capsomer/react/pagination";
import { Panel } from "capsomer/react/panel";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";
import { Status } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/disclosure.css";
import "capsomer/field.css";
import "capsomer/pagination.css";
import "capsomer/table.css";

import { Time } from "capsomer/react/time";
import { getDb } from "~/db";
import { merchantHref, pagePending, type AdminHandle } from "~/lib/admin/page";
import {
  isFiltered,
  parseWebhookFilters,
  WEBHOOK_PAGE_SIZE,
  WEBHOOKS_PATH,
  webhookCountWords,
} from "~/lib/admin/webhooks";
import {
  getWebhookHealthSummary,
  listWebhookEvents,
  type WebhookEventRow,
} from "~/lib/admin/webhooks.server";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

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
  const [summary, list] = await Promise.all([
    getWebhookHealthSummary(db),
    listWebhookEvents(db, filters),
  ]);
  // The page actually served, so the form and the pager agree with the list.
  return { summary, list, filters: { ...filters, page: list.page } };
}

const HEADING_ID = "admin-webhooks-heading";
const COLUMNS = 5;
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "fh-row-link";

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
    <div className="cap-stack" data-gap="6">
      <StatTiles label="Webhook health">
        <StatTile
          href={WEBHOOKS_PATH}
          renderLink={routerRenderLink}
          label="Received"
          figure={String(summary.totalLast24h)}
          detail="In the last 24 hours"
        />
        <StatTile
          href={`${WEBHOOKS_PATH}?errors=1`}
          renderLink={routerRenderLink}
          label="Errors"
          figure={String(summary.errorsLast24h)}
          tone={summary.errorsLast24h > 0 ? "crit" : undefined}
          detail="In the last 24 hours. Opens every event with an error."
        />
        <StatTile
          href={`${WEBHOOKS_PATH}?pending=1`}
          renderLink={routerRenderLink}
          label="Unprocessed"
          figure={String(summary.unprocessedCount)}
          tone={summary.unprocessedCount > 0 ? "crit" : undefined}
          detail="Received and not yet processed"
        />
      </StatTiles>

      <Panel
        title="Webhook events"
        headingId={HEADING_ID}
        reading={pending}
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
          className="fh-filter-bar"
        >
          <div className="cap-field fh-filter-search">
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
          <label className="cap-check fh-check-row">
            <input type="checkbox" name="errors" value="1" defaultChecked={filters.errorsOnly} />{" "}
            Errors only
          </label>
          <label className="cap-check fh-check-row">
            <input type="checkbox" name="pending" value="1" defaultChecked={filters.pendingOnly} />{" "}
            Pending only
          </label>
          <div className="cap-cluster" data-gap="4">
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
          <div
            className="cap-table-wrap"
            data-reflow=""
            data-cap="table"
            role="region"
            aria-labelledby={HEADING_ID}
            tabIndex={0}
          >
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
          <div className="fh-panel-foot">
            <Pagination
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              perPage={WEBHOOK_PAGE_SIZE}
              noun="events"
              hrefFor={(n) =>
                pageHref(
                  WEBHOOKS_PATH,
                  { type: filters.type, errors: filters.errorsOnly, pending: filters.pendingOnly },
                  n,
                )
              }
              label="Webhook event pages"
            />
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

/** One event and, under it, its payload across the whole table (Capsomer's
 *  ExpandRows), opened by the event type's button, so Enter or Space opens it
 *  and a screen reader hears the state. */
function EventRows({ event }: { event: WebhookEventRow }) {
  return (
    <ExpandRows
      name={<span className="fh-break fh-mono fh-tiny">{event.eventType}</span>}
      toggleSuffix="payload"
      columns={COLUMNS}
      row={(toggle) => (
        <>
          <th scope="row" className="fh-regular">
            {toggle}
          </th>
          <td data-label="Account">
            {event.accountId ? (
              <Link
                to={merchantHref(event.accountId)}
                className={`${LINK} fh-mono fh-tiny fh-break`}
              >
                {event.accountId}
              </Link>
            ) : (
              <span className="fh-quiet">No account</span>
            )}
          </td>
          <td data-label="Status">
            {event.errorMessage ? (
              <Status tone="crit">Error</Status>
            ) : event.processed ? (
              <Status tone="ok">Processed</Status>
            ) : (
              <Status tone="info">Pending</Status>
            )}
          </td>
          <td data-label="Received">
            <Time at={event.receivedAt} empty="never" tip />
          </td>
          <td
            data-label="Error"
            data-wrap=""
            className={event.errorMessage ? "fh-error" : "fh-quiet"}
          >
            {event.errorMessage ?? "None"}
          </td>
        </>
      )}
      detail={
        <pre
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region takes focus so a keyboard can scroll it (axe scrollable-region-focusable)
          tabIndex={0}
          aria-label={`${event.eventType} payload`}
          className="fh-payload fh-mono fh-tiny fh-text"
        >
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      }
    />
  );
}
