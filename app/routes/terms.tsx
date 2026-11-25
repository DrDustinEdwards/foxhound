import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { LegalBody, LegalServiceDescription } from "~/components/legal-page";
import { LegalDoc, type LegalSection } from "capsomer/react/legal-doc";
import "capsomer/legal-doc.css";
import "capsomer/link.css";
import { GOVERNING_LAW_JURISDICTION, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";
import { TERMS_USE } from "~/components/legal/terms-use";
import { TERMS_CONTENT } from "~/components/legal/terms-content";
import { TERMS_CLOSING } from "~/components/legal/terms-closing";
import type { Route } from "./+types/terms";

// The terms of service. Foxhound differs from the standard wording where it works differently: the operator is Dustin Edwards, sole proprietor, Texas (hard rule 12); the product description is the one /privacy carries (LegalServiceDescription); the API terms and the MCP exception to "no automated access" (agent keys); sign-in is passwordless, and Foxhound has no usernames; billing follows PRICING.md (attribution, the maturity window, the dispute cap and free Intelligence), with every number from the engine's constants; "Erath, Texas" names the county, Erath County. The chrome kit is shared with /privacy in ~/components/legal-page.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Terms of Service",
    description:
      "Terms of service for Foxhound, the payment recovery platform for Stripe merchants.",
    path: "/terms",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export const loader = siteUrlLoader;
const SECTIONS: LegalSection[] = [...TERMS_USE, ...TERMS_CONTENT, ...TERMS_CLOSING];

export default function TermsPage() {
  return (
    <LegalBody>
      <LegalDoc
        title="Terms of Service"
        updated="2026-11-11"
        contentsLabel="Contents"
        intro={
          <>
            <section>
              <h2>AGREEMENT TO OUR LEGAL TERMS</h2>
              <p>
                We are Foxhound (&quot;Company,&quot; &quot;we,&quot; &quot;us,&quot;
                &quot;our&quot;), operated by Dustin Edwards, a sole proprietor based in{" "}
                {GOVERNING_LAW_JURISDICTION}, United States.
              </p>
              <p>
                We operate the website https://foxhoundapp.com (the &quot;Site&quot;), as well as
                any other related products and services that refer or link to these legal terms (the
                &quot;Legal Terms&quot;) (collectively, the &quot;Services&quot;).
              </p>
              <p>
                <LegalServiceDescription />
              </p>
              <p>
                You can contact us by email at{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
              </p>
              <p>
                These Legal Terms constitute a legally binding agreement made between you, whether
                personally or on behalf of an entity (&quot;you&quot;), and Foxhound, concerning
                your access to and use of the Services. You agree that by accessing the Services,
                you have read, understood, and agreed to be bound by all of these Legal Terms. IF
                YOU DO NOT AGREE WITH ALL OF THESE LEGAL TERMS, THEN YOU ARE EXPRESSLY PROHIBITED
                FROM USING THE SERVICES AND YOU MUST DISCONTINUE USE IMMEDIATELY.
              </p>
              <p>
                We will provide you with prior notice of any scheduled changes to the Services you
                are using. The modified Legal Terms will become effective upon posting or notifying
                you by {SUPPORT_EMAIL}, as stated in the email message. By continuing to use the
                Services after the effective date of any changes, you agree to be bound by the
                modified terms.
              </p>
              <p>
                The Services are intended for users who are at least 18 years old. Persons under the
                age of 18 are not permitted to use or register for the Services.
              </p>
              <p>We recommend that you print a copy of these Legal Terms for your records.</p>
            </section>
          </>
        }
        sections={SECTIONS}
      />
    </LegalBody>
  );
}

export const headers = () => publicPageHeaders();
