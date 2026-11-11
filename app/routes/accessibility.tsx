import {
  ACCESSIBILITY_PATH,
  accessibilityStatement,
} from "@drdustinedwards/site-helpers/accessibility";

import { LegalDoc } from "capsomer/react/legal-doc";
import "capsomer/legal-doc.css";

import { LegalBody } from "~/components/legal-page";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/accessibility";

// /accessibility: the statement every site in the network carries, from
// Prelum's accessibilityStatement, so the standard and the wording are the same
// everywhere. Foxhound is built from Capsomer's components, and its links in
// running text are underlined in the accent color (measured on foxhoundapp.com,
// 2026-11-01). The page wears the legal pages' shell (/privacy, /terms,
// /security): Capsomer's legal page, its headings, text and links in the legal
// pages' classes. Prelum escapes every field it writes.

const REVIEWED = "2026-11-01";

const statement = accessibilityStatement({
  siteName: "Foxhound",
  contact: { href: `mailto:${SUPPORT_EMAIL}`, label: SUPPORT_EMAIL },
  date: REVIEWED,
  capsomer: true,
  links: "underline",
});

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
    <LegalBody>
      <LegalDoc
        title={statement.title}
        updated={REVIEWED}
        updatedLabel="Last reviewed"
        intro={<div dangerouslySetInnerHTML={{ __html: statement.html }} />}
        sections={[]}
      />
    </LegalBody>
  );
}
