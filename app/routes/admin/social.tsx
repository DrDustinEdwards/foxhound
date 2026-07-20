import { AdminNav } from "~/components/admin-nav";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { getSocialSnapshot } from "~/lib/admin/social.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/social";

export function meta() {
  return [{ title: "Social - Foxhound Admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const snapshot = await getSocialSnapshot(db);
  return snapshot;
}

export default function AdminSocial({ loaderData }: Route.ComponentProps) {
  const { config, recentLeads, recentPosts } = loaderData;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Social</h1>
      <AdminNav />

      <p className="rounded-lg border border-dashed border-border p-4 text-label text-text-tertiary">
        The scout/responder/poster engine isn't built yet. This page reads the real
        social_config/social_leads/social_posts tables, which are empty because nothing writes to
        them - not a stub with fabricated data. Once the engine lands, this page fills in with no
        further change here.
      </p>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Platform config</p>
        {config.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No platform configured yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {config.map((c) => (
              <li key={c.id} className="flex items-center justify-between text-label">
                <span className="text-text">{c.platform}</span>
                <Badge tone={c.enabled ? "success" : "neutral"}>{c.enabled ? "Enabled" : "Disabled"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Recent leads</p>
          {recentLeads.length === 0 ? (
            <p className="mt-2 text-label text-text-tertiary">None yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {recentLeads.map((l) => (
                <li key={l.id} className="text-label text-text-tertiary">
                  {l.platform}: {l.title ?? l.postUrl}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Recent posts</p>
          {recentPosts.length === 0 ? (
            <p className="mt-2 text-label text-text-tertiary">None yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {recentPosts.map((p) => (
                <li key={p.id} className="text-label text-text-tertiary">
                  {p.platform}: {p.status}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
