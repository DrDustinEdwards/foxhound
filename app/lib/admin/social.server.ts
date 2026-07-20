// /admin/social data layer. No scout/responder/poster engine exists yet
// (confirmed by repo-wide grep: only the retention sweeper touches
// social_leads, nothing writes social_config/social_leads/social_posts).
// This reads the real (currently-empty) tables rather than faking a UI, so
// the page is honest about "built tables, no engine" and will show real data
// the moment an engine lands - matching the Settings notifications "not
// sending yet" precedent (app/routes/app/settings/index.tsx).

import { desc } from "drizzle-orm";

import type { Db } from "~/db";
import { socialConfig, socialLeads, socialPosts } from "~/db";

export async function getSocialSnapshot(db: Db) {
  const [config, recentLeads, recentPosts] = await Promise.all([
    db.select().from(socialConfig),
    db.select().from(socialLeads).orderBy(desc(socialLeads.scoutRunAt)).limit(20),
    db.select().from(socialPosts).orderBy(desc(socialPosts.createdAt)).limit(20),
  ]);
  return { config, recentLeads, recentPosts };
}
