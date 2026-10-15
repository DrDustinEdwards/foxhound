import { Link, useNavigation, useRevalidator } from "react-router";
import { ExternalLink } from "lucide-react";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import { Status, type Tone as StatusTone } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/table.css";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { auditActor, auditDetail, auditTarget, describeAuditAction } from "~/lib/admin/audit-describe";
import { loadAuditLookups } from "~/lib/admin/audit-log.server";
import { listFailedAuditEntries, readSentry, type SentryIssue, type SentryState } from "~/lib/admin/errors.server";
import { plural } from "~/lib/admin/overview";
import { pagePending, type AdminHandle } from "~/lib/admin/page";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/errors";

export const handle: AdminHandle = { page: "Errors" };

export function meta() {
  return [{ title: "Errors - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [sentry, rows] = await Promise.all([readSentry(env), listFailedAuditEntries(db)]);
  const lookups = await loadAuditLookups(db, rows);
  const failed = rows.map((e) => ({
    id: e.id,
    createdAt: e.createdAt,
    actor: auditActor(e.actorEmail),
    action: describeAuditAction(e.action),
    target: auditTarget(e, lookups),
    detail: auditDetail(e),
  }));
  return { sentry, failed };
}

const ERRORS_PATH = "/admin/platform/errors";
const ISSUES_HEADING_ID = "admin-errors-issues-heading";
const FAILED_HEADING_ID = "admin-errors-failed-heading";
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "inline-flex min-h-6 items-center gap-1 text-text underline underline-offset-2 hover:text-brand-text";

// Sentry's levels in words, with Capsomer's status glyph. Foxhound is teal
// throughout (Q11), so a warning carries the notice tone and says Warning.
const LEVELS: Record<string, { tone: StatusTone; word: string }> = {
  fatal: { tone: "crit", word: "Fatal" },
  error: { tone: "crit", word: "Error" },
  warning: { tone: "info", word: "Warning" },
  info: { tone: "info", word: "Info" },
  debug: { tone: "nodata", word: "Debug" },
};

function levelOf(level: string): { tone: StatusTone; word: string } {
  return LEVELS[level] ?? { tone: "nodata", word: level ? level[0].toUpperCase() + level.slice(1) : "Unknown" };
}

const figure = (n: number) => n.toLocaleString("en-US");

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14)
// and his review of 2026-10-11: one page name (the shell's "Errors"), tables in
// Capsomer's parts with plain sentence-case words, relative times with the
// exact time on hover, a pending state and an empty state on every list.
// Recova's errors page (app/admin/platform/errors/page.tsx, blob 9cca8956) is
// the inventory: the last 50 audit entries naming an error or a failure, with
// Time, Action, Actor, Target and Detail in that order, and Sentry wired in once it exists.
// Sentry is listed only when Foxhound sends to it and can read it back
// (RULES.md 3.18); until then the page says so plainly. Read only.
export default function AdminErrors({ loaderData }: Route.ComponentProps) {
  const { sentry, failed } = loaderData;
  const pending = pagePending(useNavigation(), useRevalidator().state, ERRORS_PATH);
  const spinner = pending ? <Spinner size="sm" label="Reading again" /> : undefined;

  return (
    <div className="grid grid-cols-1 gap-6" aria-busy={pending || undefined}>
      <SentryNotice sentry={sentry} />

      {sentry.state === "ready" || sentry.state === "failed" ? (
        <Panel
          title="Unresolved errors"
          headingId={ISSUES_HEADING_ID}
          src={spinner}
          description={
            sentry.state === "ready" && sentry.issues.length > 0
              ? `${plural(sentry.issues.length, "unresolved error", "unresolved errors")} seen in the last 14 days, most recent first.`
              : "From Sentry, for the last 14 days."
          }
          flush
        >
          {sentry.state === "failed" ? (
            <Empty kind="failed" title="Could not read errors from Sentry.">
              {sentry.message}
            </Empty>
          ) : sentry.issues.length === 0 ? (
            <Empty kind="all-clear" title="No unresolved errors in the last 14 days." />
          ) : (
            <IssuesTable issues={sentry.issues} />
          )}
        </Panel>
      ) : null}

      <Panel
        title="Failed actions"
        headingId={FAILED_HEADING_ID}
        src={spinner}
        description={
          failed.length === 0
            ? "From the audit log."
            : `Showing the last ${plural(failed.length, "failed action", "failed actions")}, newest first.`
        }
        flush
      >
        {failed.length === 0 ? (
          <Empty kind="nothing-yet" title="No failed actions in the audit log.">
            An admin action that fails to apply, or a Stripe connection a deleted account could not revoke, is listed
            here.
          </Empty>
        ) : (
          <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={FAILED_HEADING_ID} tabIndex={0}>
            <table className="cap-table">
              <caption className="cap-sr-only">Failed actions from the audit log, newest first.</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Action</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Target</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {failed.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <AdminTime at={e.createdAt} />
                    </td>
                    <td>{e.action}</td>
                    <td className="break-all">{e.actor}</td>
                    <td data-wrap="">
                      {e.target === null ? (
                        <span className="text-text-tertiary">None</span>
                      ) : e.target.href ? (
                        <Link to={e.target.href} className={LINK}>
                          {e.target.label}
                        </Link>
                      ) : (
                        <span className="break-all">{e.target.label}</span>
                      )}
                    </td>
                    <td data-wrap="" className={e.detail === null ? "text-text-tertiary" : "text-text-secondary"}>
                      {e.detail ?? "None"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Why Sentry is not listed, in plain words, when it is not. */
function SentryNotice({ sentry }: { sentry: SentryState }) {
  if (sentry.state === "not-connected") {
    return (
      <Banner tone="info" title="Error reporting is not connected.">
        Foxhound sends no errors to Sentry until SENTRY_DSN is set, so there are none to list here.
      </Banner>
    );
  }
  if (sentry.state === "no-reader") {
    return (
      <Banner tone="info" title="Errors are sent to Sentry, but this page cannot read them yet.">
        Set {sentry.missing.join(" and ")} to list them here.
      </Banner>
    );
  }
  if (sentry.state === "unreadable-dsn") {
    return (
      <Banner tone="info" title="Errors are sent to Sentry, but this page cannot read them.">
        This page reads only from sentry.io, and SENTRY_DSN points somewhere else.
      </Banner>
    );
  }
  return null;
}

function IssuesTable({ issues }: { issues: SentryIssue[] }) {
  return (
    <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={ISSUES_HEADING_ID} tabIndex={0}>
      <table className="cap-table">
        <caption className="cap-sr-only">Unresolved errors from Sentry, most recent first.</caption>
        <thead>
          <tr>
            <th scope="col">Error</th>
            <th scope="col">Level</th>
            <th scope="col">Events</th>
            <th scope="col">Users</th>
            <th scope="col">Last seen</th>
            <th scope="col">First seen</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => {
            const level = levelOf(issue.level);
            return (
              <tr key={issue.id}>
                <td data-wrap="">
                  {issue.permalink ? (
                    <a href={issue.permalink} target="_blank" rel="noreferrer" className={LINK}>
                      <span className="break-all">{issue.title}</span>
                      <ExternalLink aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
                      <span className="cap-sr-only"> (opens in Sentry)</span>
                    </a>
                  ) : (
                    <span className="break-all">{issue.title}</span>
                  )}
                  <span className="block font-mono text-micro text-text-secondary break-all">
                    {issue.culprit ? `${issue.shortId}, ${issue.culprit}` : issue.shortId}
                  </span>
                </td>
                <td>
                  <Status tone={level.tone}>{level.word}</Status>
                </td>
                <td className="tabular-nums">{figure(issue.count)}</td>
                <td className="tabular-nums">{figure(issue.userCount)}</td>
                <td>
                  <AdminTime at={issue.lastSeen} empty="Not known" />
                </td>
                <td>
                  <AdminTime at={issue.firstSeen} empty="Not known" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
