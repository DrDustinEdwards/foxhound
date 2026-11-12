import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Link } from "capsomer/react/link";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { organizationJsonLd, siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/contact";

// Recova had /contact; Foxhound's support address was only on /about, /help and
// the legal pages (parity audit, 2026-11-10). One page that says where to write
// and what to put in the message, so a merchant gets an answer without a second
// round of email. The address is SUPPORT_EMAIL, never retyped.

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Contact",
      description: `Email Foxhound support at ${SUPPORT_EMAIL} for billing, account and recovery questions.`,
      path: "/contact",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
    ...(loaderData ? [jsonLd(organizationJsonLd(loaderData.siteUrl))] : []),
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function ContactPage() {
  return (
    <div>
      <MarketingPageHeader
        eyebrow="Contact"
        title="Contact support"
        subtext="One inbox for billing, account and recovery questions."
      />

      {/* div, not main: marketing.tsx already renders this page's one main landmark. */}
      <div className="mx-auto max-w-2xl px-4 pb-20 sm:px-8">
        <div className="flex flex-col gap-6 text-body leading-relaxed text-text-secondary">
          <p>
            Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Responses within 24 hours
            on business days.
          </p>
          <div>
            <h2 className="mb-2 text-subhead font-medium text-text">What to include</h2>
            <ul className="m-0 list-disc space-y-1 pl-5">
              <li>Write from the address you sign in to Foxhound with.</li>
              <li>
                For a payment, its Stripe invoice ID (<code className="font-mono">in_</code>) or
                payment ID (<code className="font-mono">pi_</code>).
              </li>
              <li>
                For a dispute, its Stripe dispute ID (<code className="font-mono">dp_</code>).
              </li>
            </ul>
          </div>
          <p>
            Many answers are already in the <Link to="/docs">documentation</Link>, including{" "}
            <Link to="/docs/recovery">troubleshooting for recovery</Link>. To report a security
            issue, see <Link to="/security">Security</Link>; for an accessibility problem, see{" "}
            <Link to="/accessibility">Accessibility</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}

export const headers = () => publicPageHeaders();
