import { ACCESSIBILITY_PATH, accessibilityStatement } from "@drdustinedwards/site-helpers/accessibility";

import { LegalBody } from "~/components/legal-page";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/accessibility";

// /accessibility: the statement every site in the network carries, from
// Prelum's accessibilityStatement, so the standard and the wording are the same
// everywhere. Foxhound is built from Capsomer's components, and its links in
// running text are underlined in the accent color (measured on foxhoundapp.com,
// 2026-11-01). The page wears the legal pages' shell (/privacy, /terms,
// /security): MarketingPageHeader over the 720px column, its headings, text and
// links in the legal pages' classes. Prelum escapes every field it writes.

const statement = accessibilityStatement({
  siteName: "Foxhound",
  contact: { href: `mailto:${SUPPORT_EMAIL}`, label: SUPPORT_EMAIL },
  date: "2026-11-01",
  capsomer: true,
  links: "underline",
});

const BODY =
  "[&_h2]:mb-4 [&_h2]:mt-12 [&_h2]:text-title [&_h2]:font-medium [&_h2]:text-text " +
  "[&_p]:mb-4 [&_p]:text-subhead [&_p]:leading-relaxed [&_p]:text-text-secondary " +
  "[&_ul]:mb-4 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6 [&_ul]:text-subhead [&_ul]:leading-relaxed [&_ul]:text-text-secondary " +
  "[&_a]:text-accent-text [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-accent-hover";

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: statement.title,
    description: statement.description,
    path: ACCESSIBILITY_PATH,
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function AccessibilityPage() {
  return (
    <>
      <MarketingPageHeader eyebrow="Legal" title={statement.title} subtext="Last reviewed November 1, 2026" />
      <LegalBody>
        <div className={BODY} dangerouslySetInnerHTML={{ __html: statement.html }} />
      </LegalBody>
    </>
  );
}
