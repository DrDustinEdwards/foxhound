import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import {
  ACCESSIBILITY_PATH,
  accessibilityStatement,
} from "@drdustinedwards/site-helpers/accessibility";

import { LegalBody } from "~/components/legal-page";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { SUPPORT_EMAIL, siteUrlLoader } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/accessibility";
import { markup } from "capsomer/behavior/trusted-html";

// /accessibility: the statement every site in the network carries, from
// Prelum's accessibilityStatement, so the standard and the wording are the same
// everywhere. Foxhound is built from Capsomer's components, and its links are
// Capsomer's link system (capsomer/links.css and link.css in app.css). The page wears the legal pages' shell (/privacy, /terms,
// /security): MarketingPageHeader over the 720px column, its headings, text and
// links in the legal pages' classes. Prelum escapes every field it writes.

const statement = accessibilityStatement({
  siteName: "Foxhound",
  contact: { href: `mailto:${SUPPORT_EMAIL}`, label: SUPPORT_EMAIL },
  date: "2026-11-12",
  capsomer: true,
  links: "marked",
});

const BODY =
  "[&_h2]:mb-4 [&_h2]:mt-12 [&_h2]:text-title [&_h2]:font-medium [&_h2]:text-text " +
  "[&_p]:mb-4 [&_p]:text-subhead [&_p]:leading-relaxed [&_p]:text-text-secondary " +
  "[&_ul]:mb-4 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6 [&_ul]:text-subhead [&_ul]:leading-relaxed [&_ul]:text-text-secondary";

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: statement.title,
    description: statement.description,
    path: ACCESSIBILITY_PATH,
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export const loader = siteUrlLoader;

export default function AccessibilityPage() {
  return (
    <>
      <MarketingPageHeader
        eyebrow="Legal"
        title={statement.title}
        subtext="Last reviewed November 1, 2026"
      />
      <LegalBody>
        <div className={BODY} dangerouslySetInnerHTML={markup(statement.html)} />
      </LegalBody>
    </>
  );
}

export const headers = () => publicPageHeaders();
