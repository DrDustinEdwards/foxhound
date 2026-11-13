import { Table } from "capsomer/react/table";
import { usePagePending } from "capsomer/react/route-hooks";
import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";

import { Time } from "capsomer/react/time";
import { getDb } from "~/db";
import { listPlatformUsers } from "~/lib/admin/users.server";
import { membershipWord, usersCountSentence } from "~/lib/admin/users";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { merchantHref, type AdminHandle } from "~/lib/admin/page";

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
const LINK = "fh-row-link";

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14):
// one page name (the shell's "Users"), a plain sentence with the count, then
// Capsomer's table, one person per row. Recova's users page is the inventory
// (email, last sign-in, joined, user id); a person may belong to several
// accounts, so every account shows, pending invites marked.
// Read only: the page has no actions.
export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  const { users } = loaderData;
  const pending = usePagePending("/admin/users");

  return (
    <Panel
      title="People"
      headingId={HEADING_ID}
      reading={pending}
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
        <Table
          caption="Everyone who can sign in to Foxhound, one person per row"
          captionHidden
          labelledBy={HEADING_ID}
          reflow
        >
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
                <th scope="row" className="fh-regular">
                  <span className="fh-line fh-text">{u.name}</span>
                  <span className="fh-line fh-quiet">{u.email}</span>
                </th>
                <td data-label="Accounts">
                  {u.memberships.length === 0 ? (
                    <span className="fh-quiet">No account</span>
                  ) : (
                    <ul className="cap-stack" data-gap="2">
                      {u.memberships.map((m) => (
                        <li key={m.accountId}>
                          <Link to={merchantHref(m.accountId)} className={LINK}>
                            {m.accountName ?? m.accountId}
                          </Link>{" "}
                          <span className="fh-quiet">{membershipWord(m)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td data-label="Platform role">
                  {u.isAdmin ? "Admin" : <span className="fh-quiet">Merchant</span>}
                </td>
                <td data-label="Last sign-in">
                  <Time at={u.lastSignInAt} empty="No sign-in on record" tip />
                </td>
                <td data-label="Joined">
                  <Time at={u.createdAt} empty="never" tip />
                </td>
                <td data-label="User ID" className="fh-mono fh-tiny fh-break fh-quiet">
                  {u.id}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
