import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { LegalBody, LegalServiceDescription, More } from "~/components/legal-page";
import { CARD } from "~/components/marketing-card";
import { LegalDoc, type LegalSection } from "capsomer/react/legal-doc";
import "capsomer/legal-doc.css";
import "capsomer/link.css";
import { GOVERNING_LAW_JURISDICTION, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";
import { PRIVACY_COLLECTION } from "~/components/legal/privacy-collection";
import { PRIVACY_HANDLING } from "~/components/legal/privacy-handling";
import { PRIVACY_US_RESIDENTS } from "~/components/legal/privacy-us-residents";
import { PRIVACY_CLOSING } from "~/components/legal/privacy-closing";
import type { Route } from "./+types/privacy";

// The privacy notice. Foxhound differs from the standard wording where it works differently: the operator is Dustin Edwards, sole proprietor, Texas (CLAUDE.md, Launch); the product description says what Foxhound does (silent retry first, dispute responses only on approval or the merchant's opt-in auto-submit); the personal information list, the other sources and the service providers are Foxhound's own (Cloudflare; Google and Apple sign-in; Amazon for off-site file backups); the category answers follow the build (G is the session's coarse place from site-runtime's sessionDetails, K the intelligence scores and recommendations); the retention windows and the at-risk score are the engine's constants and the account deletion keeps fee evidence; the EU, UK, Swiss and Canadian paragraphs are left out, because the network's sites are written for US and Texas law only; the "Learn more" pointers in the summary link to their sections. There is no contact page; the email is the way to reach us. The page has one main landmark: marketing.tsx renders it.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Privacy Policy",
    description: "Privacy policy for Foxhound, the payment recovery platform for Stripe merchants.",
    path: "/privacy",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export const loader = siteUrlLoader;
const SECTIONS: LegalSection[] = [
  ...PRIVACY_COLLECTION,
  ...PRIVACY_HANDLING,
  ...PRIVACY_US_RESIDENTS,
  ...PRIVACY_CLOSING,
];

const SUMMARY_TERM = "fh-medium fh-text";

export default function PrivacyPage() {
  return (
    <LegalBody>
      <LegalDoc
        title="Privacy Policy"
        updated="2026-11-26"
        contentsLabel="Table of Contents"
        intro={
          <>
            <p>
              This Privacy Notice for Foxhound (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;),
              operated by Dustin Edwards, a sole proprietor based in {GOVERNING_LAW_JURISDICTION},
              United States, describes how and why we might access, collect, store, use, and/or
              share (&quot;process&quot;) your personal information when you use our services
              (&quot;Services&quot;), including when you:
            </p>
            <ul>
              <li>
                Visit our website at foxhoundapp.com or any website of ours that links to this
                Privacy Notice
              </li>
              <li>
                Use Foxhound. <LegalServiceDescription />
              </li>
              <li>Engage with us in other related ways, including any marketing or events</li>
            </ul>
            <p>
              Questions or concerns? Reading this Privacy Notice will help you understand your
              privacy rights and choices. We are responsible for making decisions about how your
              personal information is processed. If you do not agree with our policies and
              practices, please do not use our Services. If you still have any questions or
              concerns, please contact us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
              .
            </p>
            <div className="fh-privacy-block">
              <section className={CARD} aria-labelledby="privacy-summary">
                <div className="cap-panel-body">
                  <h2 id="privacy-summary" className="fh-privacy-title fh-mono fh-tiny fh-quiet">
                    Summary of key points
                  </h2>
                  <p className="fh-copy fh-relaxed fh-soft">
                    This summary provides key points from our Privacy Notice, but you can find out
                    more details about any of these topics by clicking the link following each key
                    point or by using our table of contents below to find the section you are
                    looking for.
                  </p>
                  <ul className="cap-stack fh-copy fh-relaxed fh-soft" data-gap="4">
                    <li>
                      <strong className={SUMMARY_TERM}>
                        What personal information do we process?
                      </strong>{" "}
                      When you visit, use, or navigate our Services, we may process personal
                      information depending on how you interact with us and the Services, the
                      choices you make, and the products and features you use.{" "}
                      <More to="collect">
                        Learn more about personal information you disclose to us.
                      </More>
                    </li>
                    <li>
                      <strong className={SUMMARY_TERM}>
                        Do we process any sensitive personal information?
                      </strong>{" "}
                      Some of the information may be considered &quot;special&quot; or
                      &quot;sensitive&quot; in certain jurisdictions, for example your racial or
                      ethnic origins, sexual orientation, and religious beliefs. We do not process
                      sensitive personal information.
                    </li>
                    <li>
                      <strong className={SUMMARY_TERM}>
                        Do we collect any information from third parties?
                      </strong>{" "}
                      We collect information from Stripe when a merchant connects a Stripe account,
                      and from Google or Apple when you sign in with them. We do not buy information
                      from data brokers or marketing partners.{" "}
                      <More to="other-sources">
                        Learn more about information collected from other sources.
                      </More>
                    </li>
                    <li>
                      <strong className={SUMMARY_TERM}>How do we process your information?</strong>{" "}
                      We process your information to provide, improve, and administer our Services,
                      communicate with you, for security and fraud prevention, and to comply with
                      law. We may also process your information for other purposes with your
                      consent. We process your information only when we have a valid legal reason to
                      do so.{" "}
                      <More to="process">Learn more about how we process your information.</More>
                    </li>
                    <li>
                      <strong className={SUMMARY_TERM}>
                        In what situations and with which parties do we share personal information?
                      </strong>{" "}
                      We may share information in specific situations and with specific third
                      parties.{" "}
                      <More to="share">
                        Learn more about when and with whom we share your personal information.
                      </More>
                    </li>
                    <li>
                      <strong className={SUMMARY_TERM}>
                        How do we keep your information safe?
                      </strong>{" "}
                      We have adequate organizational and technical processes and procedures in
                      place to protect your personal information. However, no electronic
                      transmission over the internet or information storage technology can be
                      guaranteed to be 100% secure, so we cannot promise or guarantee that hackers,
                      cybercriminals, or other unauthorized third parties will not be able to defeat
                      our security and improperly collect, access, steal, or modify your
                      information.{" "}
                      <More to="safe">Learn more about how we keep your information safe.</More>
                    </li>
                    <li>
                      <strong className={SUMMARY_TERM}>What are your rights?</strong> Depending on
                      where you are located geographically, the applicable privacy law may mean you
                      have certain rights regarding your personal information.{" "}
                      <More to="rights">Learn more about your privacy rights.</More>
                    </li>
                    <li>
                      <strong className={SUMMARY_TERM}>How do you exercise your rights?</strong> The
                      easiest way to exercise your rights is from your account settings, where you
                      can review, change, or delete your account, or by contacting us. We will
                      consider and act upon any request in accordance with applicable data
                      protection laws.
                    </li>
                    <li>
                      Want to learn more about what we do with any information we collect? Review
                      the Privacy Notice in full.
                    </li>
                  </ul>
                </div>
              </section>
            </div>
          </>
        }
        sections={SECTIONS}
      />
    </LegalBody>
  );
}

export const headers = () => publicPageHeaders();
