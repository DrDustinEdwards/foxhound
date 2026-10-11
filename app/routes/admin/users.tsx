import { Badge } from "~/components/badge";
import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { listPlatformUsers } from "~/lib/admin/users.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/users";

export const handle: AdminHandle = { page: "Users" };

export function meta() {
  return [{ title: "Users - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const users = await listPlatformUsers(db, env);
  return { users };
}

export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  const { users } = loaderData;

  return (
    <div>

      {users.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No platform users yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-3 font-normal">User</th>
                <th className="px-4 py-3 font-normal">Account</th>
                <th className="px-4 py-3 font-normal">Role</th>
                <th className="px-4 py-3 font-normal">Platform role</th>
                <th className="px-4 py-3 font-normal">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3">
                    <p className="text-text">{u.name}</p>
                    <p className="text-text-tertiary">{u.email}</p>
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">{u.accountName ?? u.accountId ?? "-"}</td>
                  <td className="px-4 py-3">
                    {u.role ? (
                      <Badge tone={u.memberStatus === "active" ? "neutral" : "failure"}>
                        {u.role}
                        {u.memberStatus && u.memberStatus !== "active" ? ` (${u.memberStatus})` : ""}
                      </Badge>
                    ) : (
                      <span className="text-text-tertiary">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.isAdmin ? (
                      <span className="font-mono text-micro uppercase tracking-wide text-text">Admin</span>
                    ) : (
                      <span className="text-text-tertiary">Merchant</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary"><AdminTime at={u.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
