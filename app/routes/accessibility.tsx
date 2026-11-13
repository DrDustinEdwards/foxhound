import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import {
  ACCESSIBILITY_PATH,
  accessibilityStatement,
} from "@drdustinedwards/site-helpers/accessibility";

import { LegalDoc } from "capsomer/react/legal-doc";
import "capsomer/legal-doc.css";

import { LegalBody } from "~/components/legal-page";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/accessibility";
import { markup } from "capsomer/behavior/trusted-html";

// /accessibility: the statement every site in the network carries, from
// Prelum's accessibilityStatement, so the standard and the wording are the same
// everywhere. Foxhound is built from Capsomer's components, and its links are
// Capsomer's link system (capsomer/links.css in app.css, link.css on the public pages) with a line on hover (Capsomer's Foxhound entry). The page wears the legal pages' shell (/privacy, /terms,
// /security): Capsomer's legal page in the 720px column, its headings and text
// in the legal pages' classes. Prelum escapes every field it writes.

const REVIEWED = "2026-11-13";

const statement = accessibilityStatement({
  siteName: "Foxhound",
  contact: { href: `mailto:${SUPPORT_EMAIL}`, label: SUPPORT_EMAIL },
  date: REVIEWED,
  capsomer: true,
  links: "marked",
});

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
    <LegalBody>
      <LegalDoc
        title={statement.title}
        updated={REVIEWED}
        updatedLabel="Last reviewed"
        intro={<div dangerouslySetInnerHTML={markup(statement.html)} />}
        sections={[]}
      />
    </LegalBody>
  );
}

export const headers = () => publicPageHeaders();
