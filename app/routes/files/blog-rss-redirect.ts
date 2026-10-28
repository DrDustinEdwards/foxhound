import { redirect } from "react-router";

// Recova served its blog feed at /blog/rss.xml. Foxhound has one feed,
// /feed.rss, so the old address answers one 301 to it and readers subscribed
// to it keep working. The target is fixed, so this cannot become an open
// redirect.
export function loader() {
  return redirect("/feed.rss", 301);
}
