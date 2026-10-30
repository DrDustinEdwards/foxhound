import { Link, useNavigation, useRevalidator } from "react-router";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { listPlatformUsers } from "~/lib/admin/users.server";
import { membershipWord, usersCountSentence } from "~/lib/admin/users";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { merchantHref, pagePending, type AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/users";
import { NOINDEX } from "~/lib/seo/meta";

export const handle: AdminHandle = { page: "Users" };

export function meta() {
  return [{ title: "Users - Foxhound admin" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const users = await listPlatformUsers(db, env);
  return { users };
}

const HEADING_ID = "admin-users-heading";
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "inline-block min-h-6 leading-6 text-text underline underline-offset-2";

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14):
// one page name (the shell's "Users"), a plain sentence with the count, then
// Capsomer's table, one person per row. Recova's users page is the inventory
// (email, last sign-in, joined, user id); a person may belong to several
// accounts (RULES.md 1.6), so every account shows, pending invites marked.
// Read only: the page has no actions.
export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  const { users } = loaderData;
  const pending = pagePending(useNavigation(), useRevalidator().state, "/admin/users");

  return (
    <div aria-busy={pending || undefined}>
      <Panel
        title="People"
        headingId={HEADING_ID}
        src={pending ? <Spinner size="sm" label="Reading again" /> : undefined}
        description={
          users.length === 0
            ? undefined
            : `${usersCountSentence(users.length)} Each person is one row, newest first, with every account they belong to.`
        }
        flush
      >
        {users.length === 0 ? (
          <Empty kind="nothing-yet" title="No users yet.">
            A person appears here once they sign up for Foxhound.
          </Empty>
        ) : (
          <div className="cap-table-wrap" data-cap="table" data-reflow="" role="region" aria-labelledby={HEADING_ID} tabIndex={0}>
            <table className="cap-table">
              <caption className="cap-sr-only">Everyone who can sign in to Foxhound, one person per row</caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Accounts</th>
                  <th scope="col">Platform role</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">Joined</th>
                  <th scope="col">User ID</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <th scope="row" className="font-normal">
                      <span className="block text-text">{u.name}</span>
                      <span className="block text-text-tertiary">{u.email}</span>
                    </th>
                    <td data-label="Accounts">
                      {u.memberships.length === 0 ? (
                        <span className="text-text-tertiary">No account</span>
                      ) : (
                        <ul className="m-0 grid list-none gap-1 p-0">
                          {u.memberships.map((m) => (
                            <li key={m.accountId}>
                              <Link to={merchantHref(m.accountId)} className={LINK}>
                                {m.accountName ?? m.accountId}
                              </Link>{" "}
                              <span className="text-text-tertiary">{membershipWord(m)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td data-label="Platform role">{u.isAdmin ? "Admin" : <span className="text-text-tertiary">Merchant</span>}</td>
                    <td data-label="Last sign-in">
                      <AdminTime at={u.lastSignInAt} empty="No sign-in on record" />
                    </td>
                    <td data-label="Joined">
                      <AdminTime at={u.createdAt} />
                    </td>
                    <td data-label="User ID" className="font-mono text-micro break-all text-text-tertiary">{u.id}</td>
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
