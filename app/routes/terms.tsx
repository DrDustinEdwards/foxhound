import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { GOVERNING_LAW_JURISDICTION, siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/terms";

// Ported from legacy app/(marketing)/terms/page.tsx (Phase 6 Pass 1). Same
// 26-section structure, de-branded Recova -> Foxhound throughout. The
// company description paragraph and the Subscriptions section are rewritten
// per copy corrections #1, #3, #4, #8 (silent-first, baseline-free,
// review-and-sign disputes, maturity-window billing); every other section
// is boilerplate legal structure carried over unchanged in substance.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Terms of Service - Foxhound",
    description: "Terms of service for Foxhound, the payment recovery platform for Stripe merchants.",
    path: "/terms",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

interface SectionDef {
  id: string;
  number: number;
  title: string;
}

const SECTIONS: SectionDef[] = [
  { id: "services", number: 1, title: "OUR SERVICES" },
  { id: "ip", number: 2, title: "INTELLECTUAL PROPERTY RIGHTS" },
  { id: "user-representations", number: 3, title: "USER REPRESENTATIONS" },
  { id: "registration", number: 4, title: "USER REGISTRATION" },
  { id: "purchases", number: 5, title: "PURCHASES AND PAYMENT" },
  { id: "subscriptions", number: 6, title: "SUBSCRIPTIONS" },
  { id: "prohibited", number: 7, title: "PROHIBITED ACTIVITIES" },
  { id: "contributions", number: 8, title: "USER GENERATED CONTRIBUTIONS" },
  { id: "contribution-license", number: 9, title: "CONTRIBUTION LICENSE" },
  { id: "third-party", number: 10, title: "THIRD-PARTY WEBSITES AND CONTENT" },
  { id: "services-management", number: 11, title: "SERVICES MANAGEMENT" },
  { id: "privacy", number: 12, title: "PRIVACY POLICY" },
  { id: "term-termination", number: 13, title: "TERM AND TERMINATION" },
  { id: "modifications", number: 14, title: "MODIFICATIONS AND INTERRUPTIONS" },
  { id: "governing-law", number: 15, title: "GOVERNING LAW" },
  { id: "disputes", number: 16, title: "DISPUTE RESOLUTION" },
  { id: "corrections", number: 17, title: "CORRECTIONS" },
  { id: "disclaimer", number: 18, title: "DISCLAIMER" },
  { id: "liability", number: 19, title: "LIMITATIONS OF LIABILITY" },
  { id: "indemnification", number: 20, title: "INDEMNIFICATION" },
  { id: "user-data", number: 21, title: "USER DATA" },
  { id: "electronic", number: 22, title: "ELECTRONIC COMMUNICATIONS, TRANSACTIONS, AND SIGNATURES" },
  { id: "california", number: 23, title: "CALIFORNIA USERS AND RESIDENTS" },
  { id: "miscellaneous", number: 24, title: "MISCELLANEOUS" },
  { id: "data-processing", number: 25, title: "DATA PROCESSING" },
  { id: "contact", number: 26, title: "CONTACT US" },
];

function Section({ id, number, title, children }: { id: string; number: number; title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 id={id} className="mb-4 mt-12 scroll-mt-20 text-title font-medium text-text">
        {number}. {title}
      </h2>
      {children}
    </section>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 mt-6 text-item-title font-medium text-text">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-item-title leading-relaxed text-text-secondary">{children}</p>;
}

export default function TermsPage() {
  return (
    <>
      <MarketingPageHeader eyebrow="Legal" title="Terms of Service" subtext="Last updated July 18, 2026" />

      {/* div, not main: marketing.tsx already renders this page's one main landmark. */}
      <div className="mx-auto max-w-[720px] px-6 pb-16">
        <section className="mb-12">
          <h2 className="mb-3 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">Contents</h2>
          <ol className="m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 p-0 sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <li key={s.id} className="list-none text-label">
                <a href={`#${s.id}`} className="text-brand-text underline underline-offset-2">
                  {s.number}. {s.title}
                </a>
              </li>
            ))}
          </ol>
        </section>

        <hr className="my-10 border-border" />

        <section>
          <h2 className="mb-4 mt-12 text-title font-medium text-text">AGREEMENT TO OUR LEGAL TERMS</h2>
          <P>
            We are Foxhound (&quot;Company,&quot; &quot;we,&quot; &quot;us,&quot; &quot;our&quot;), operated by
            Dustin Edwards, a sole proprietor based in {GOVERNING_LAW_JURISDICTION}, United States.
          </P>
          <P>
            We operate the website https://foxhoundapp.com (the &quot;Site&quot;), as well as any other
            related products and services that refer or link to these legal terms (the &quot;Legal
            Terms&quot;) (collectively, the &quot;Services&quot;).
          </P>
          <P>
            Foxhound is a SaaS application that recovers failed subscription payments for businesses using
            Stripe. When a subscriber&apos;s payment fails, Foxhound detects the failure via Stripe
            webhook, classifies the decline, and attempts a silent retry before any customer ever sees an
            email. If the silent retry does not work, Foxhound generates a personalized recovery email and
            continues the sequence over 30 days. Foxhound also drafts dispute evidence automatically, but
            every submission requires a merchant to review and approve it first, there is no automatic
            submission. Merchants connect their Stripe account once via OAuth, and Foxhound runs
            automatically in the background. Foxhound does not store card numbers or access payout or bank
            account information.
          </P>
          <P>
            You can contact us by email at{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand-text underline underline-offset-2">
              {SUPPORT_EMAIL}
            </a>
            .
          </P>
          <P>
            These Legal Terms constitute a legally binding agreement made between you, whether personally
            or on behalf of an entity (&quot;you&quot;), and Foxhound, concerning your access to and use of
            the Services. You agree that by accessing the Services, you have read, understood, and agreed
            to be bound by all of these Legal Terms. IF YOU DO NOT AGREE WITH ALL OF THESE LEGAL TERMS,
            THEN YOU ARE EXPRESSLY PROHIBITED FROM USING THE SERVICES AND YOU MUST DISCONTINUE USE
            IMMEDIATELY.
          </P>
          <P>
            We will provide you with prior notice of any scheduled changes to the Services you are using.
            The modified Legal Terms will become effective upon posting or notifying you by
            {" "}{SUPPORT_EMAIL}, as stated in the email message. By continuing to use the Services
            after the effective date of any changes, you agree to be bound by the modified terms.
          </P>
          <P>
            The Services are intended for users who are at least 18 years old. Persons under the age of 18
            are not permitted to use or register for the Services.
          </P>
          <P>We recommend that you print a copy of these Legal Terms for your records.</P>
        </section>

        <Section id="services" number={1} title="OUR SERVICES">
          <P>
            The information provided when using the Services is not intended for distribution to or use by
            any person or entity in any jurisdiction or country where such distribution or use would be
            contrary to law or regulation or which would subject us to any registration requirement within
            such jurisdiction or country. Those who choose to access the Services from other locations do
            so on their own initiative and are solely responsible for compliance with local laws, where
            applicable.
          </P>
          <P>
            The Services are not tailored to comply with industry-specific regulations (HIPAA, FISMA, and
            similar), so if your use would be subject to such laws, you may not use the Services. You may
            not use the Services in a way that would violate the Gramm-Leach-Bliley Act (GLBA).
          </P>
        </Section>

        <Section id="ip" number={2} title="INTELLECTUAL PROPERTY RIGHTS">
          <H3>Our intellectual property</H3>
          <P>
            We are the owner or the licensee of all intellectual property rights in our Services,
            including all source code, databases, functionality, software, website designs, and text in
            the Services (collectively, the &quot;Content&quot;), as well as the trademarks, service marks,
            and logos contained therein (the &quot;Marks&quot;).
          </P>
          <P>
            Our Content and Marks are protected by copyright and trademark laws and treaties in the United
            States and around the world.
          </P>
          <P>The Content and Marks are provided &quot;AS IS&quot; for your internal business purpose only.</P>
          <H3>Your use of our Services</H3>
          <P>
            Subject to your compliance with these Legal Terms, including the &quot;PROHIBITED
            ACTIVITIES&quot; section below, we grant you a non-exclusive, non-transferable, revocable
            license to access the Services and download or print a copy of any portion of the Content to
            which you have properly gained access, solely for your internal business purpose.
          </P>
          <P>
            Except as set out in this section or elsewhere in our Legal Terms, no part of the Services and
            no Content or Marks may be copied, reproduced, republished, uploaded, posted, publicly
            displayed, encoded, translated, transmitted, distributed, sold, or licensed for any commercial
            purpose without our express prior written permission.
          </P>
          <P>
            If you wish to make any other use of the Services, Content, or Marks, address your request to
            {" "}{SUPPORT_EMAIL}. We reserve all rights not expressly granted to you in and to the
            Services, Content, and Marks.
          </P>
          <P>
            Any breach of these Intellectual Property Rights will constitute a material breach of our Legal
            Terms and your right to use our Services will terminate immediately.
          </P>
          <H3>Your submissions</H3>
          <P>
            By directly sending us any question, comment, suggestion, idea, feedback, or other information
            about the Services (&quot;Submissions&quot;), you agree to assign to us all intellectual
            property rights in such Submission, without acknowledgment or compensation to you.
          </P>
          <P>
            You are solely responsible for your Submissions and agree to reimburse us for any losses we
            suffer because of your breach of this section, a third party&apos;s intellectual property
            rights, or applicable law.
          </P>
        </Section>

        <Section id="user-representations" number={3} title="USER REPRESENTATIONS">
          <P>
            By using the Services, you represent and warrant that: (1) all registration information you
            submit will be true, accurate, current, and complete; (2) you will maintain the accuracy of
            such information; (3) you have the legal capacity and agree to comply with these Legal Terms;
            (4) you are not a minor in the jurisdiction in which you reside; (5) you will not access the
            Services through automated or non-human means, except through the Foxhound MCP endpoint
            using an API key issued to your account, which is governed by the API terms below; (6) you
            will not use the Services for any
            illegal or unauthorized purpose; and (7) your use will not violate any applicable law or
            regulation.
          </P>
          <P>
            If you provide any information that is untrue, inaccurate, not current, or incomplete, we have
            the right to suspend or terminate your account.
          </P>

          <H3>API terms</H3>
          <P>
            Foxhound publishes a Model Context Protocol endpoint so that an AI agent you choose can read
            and manage your own account on your behalf. Access requires an API key you generate inside
            your account. Keys are scoped to the single account that issued them, they can be revoked at
            any time from the same page, and rate limits apply.
          </P>
          <P>
            Some actions are never available to an API key, whatever the key or the agent: submitting
            dispute evidence, connecting a Stripe account, disconnecting a Stripe account, and anything
            that records an outcome or bills. Those require a signed-in person, and the endpoint exposes
            no tool for them.
          </P>
          <P>
            You are responsible for everything done under your keys, including actions taken by an agent
            you have given a key to, exactly as you are responsible for actions taken by a person you have
            given access to. Revoke a key you no longer control.
          </P>
        </Section>

        <Section id="registration" number={4} title="USER REGISTRATION">
          <P>
            You may be required to register to use the Services. You agree to keep your password
            confidential and are responsible for all use of your account and password.
          </P>
        </Section>

        <Section id="purchases" number={5} title="PURCHASES AND PAYMENT">
          <P>We accept the following forms of payment:</P>
          <ul className="mb-4 list-disc space-y-1.5 pl-6 text-item-title leading-relaxed text-text-secondary">
            <li>Visa</li>
            <li>Mastercard</li>
            <li>American Express</li>
            <li>Discover</li>
          </ul>
          <P>
            You agree to provide current, complete, and accurate purchase and account information for all
            purchases made via the Services, and to keep it updated. Sales tax will be added where
            required. We may change prices at any time. All payments are in US dollars.
          </P>
          <P>
            You authorize us to charge your chosen payment provider for amounts owed upon each billing run.
            We reserve the right to correct any pricing errors, even after payment has been requested or
            received, and to refuse any order.
          </P>
        </Section>

        <Section id="subscriptions" number={6} title="SUBSCRIPTIONS">
          <H3>Billing and maturity</H3>
          <P>
            Recovery and Disputes are billed as a percentage of outcomes: 20% of Foxhound-attributed
            recoveries, and 20% of disputes Foxhound wins (capped at $500 per dispute). A recovery is
            never billed until it has been held for 30 or more days, each monthly billing run charges only
            the prior month&apos;s matured recoveries. Recoveries that Stripe&apos;s own tools would have
            produced without any Foxhound action are recorded and shown to you for free, never billed.
            Intelligence&apos;s predictive layer is billed as a flat monthly subscription at the rate then
            in effect; its MRR and churn analytics are free. Audit is free with no billing.
          </P>
          <H3>Cancellation</H3>
          <P>
            All purchases are non-refundable. You can cancel at any time from your account settings by
            disconnecting your Stripe account or canceling the applicable subscription. Cancellation takes
            effect immediately. You remain responsible for fees already matured and owed prior to
            cancellation. Questions: {SUPPORT_EMAIL}.
          </P>
          <H3>Fee changes</H3>
          <P>We may, from time to time, change the subscription fee and will communicate any price changes to you in accordance with applicable law.</P>
        </Section>

        <Section id="prohibited" number={7} title="PROHIBITED ACTIVITIES">
          <P>You may not access or use the Services for any purpose other than that for which we make the Services available. As a user, you agree not to:</P>
          <ul className="mb-4 list-disc space-y-1.5 pl-6 text-item-title leading-relaxed text-text-secondary">
            <li>Systematically retrieve data to create a collection or database without written permission.</li>
            <li>Trick, defraud, or mislead us or other users, including attempts to learn account credentials.</li>
            <li>Circumvent, disable, or otherwise interfere with security-related features of the Services.</li>
            <li>Disparage, tarnish, or otherwise harm, in our opinion, us or the Services.</li>
            <li>Use information from the Services to harass, abuse, or harm another person.</li>
            <li>Make improper use of support services or submit false reports of abuse.</li>
            <li>Use the Services in a manner inconsistent with applicable laws or regulations.</li>
            <li>Engage in unauthorized framing of or linking to the Services.</li>
            <li>Upload or transmit viruses, Trojan horses, or similar material.</li>
            <li>
              Use automated scripts, bots, or data-mining tools against the Services, other than the
              Foxhound MCP endpoint used with an API key issued to your account.
            </li>
            <li>Delete copyright or proprietary rights notices from any Content.</li>
            <li>Impersonate another user or person.</li>
            <li>Interfere with or disrupt the Services or connected networks.</li>
            <li>Harass, intimidate, or threaten our employees or agents.</li>
            <li>Bypass measures designed to prevent or restrict access to the Services.</li>
            <li>Copy or adapt the Services&apos; software.</li>
            <li>Use the Services to compete with us without our express written permission.</li>
          </ul>
        </Section>

        <Section id="contributions" number={8} title="USER GENERATED CONTRIBUTIONS">
          <P>
            The Services do not offer users a way to submit or post public content. Any Contributions you
            do transmit to us may be treated in accordance with our Privacy Policy.
          </P>
        </Section>

        <Section id="contribution-license" number={9} title="CONTRIBUTION LICENSE">
          <P>
            You and the Services agree that we may access, store, process, and use any information and
            personal data you provide following the terms of the Privacy Policy and your settings.
          </P>
          <P>
            By submitting suggestions or other feedback about the Services, you agree that we can use and
            share such feedback for any purpose without compensation to you.
          </P>
        </Section>

        <Section id="third-party" number={10} title="THIRD-PARTY WEBSITES AND CONTENT">
          <P>
            The Services may link to other websites or content belonging to third parties. Such
            third-party content is not investigated, monitored, or checked for accuracy by us, and we are
            not responsible for it. If you access a third-party website through the Services, you do so at
            your own risk.
          </P>
        </Section>

        <Section id="services-management" number={11} title="SERVICES MANAGEMENT">
          <P>
            We reserve the right, but not the obligation, to monitor the Services for violations of these
            Legal Terms, take appropriate legal action against violators, restrict or disable access to any
            Contributions, remove content that is excessive in size or burdensome to our systems, and
            otherwise manage the Services to protect our rights and property.
          </P>
        </Section>

        <Section id="privacy" number={12} title="PRIVACY POLICY">
          <P>
            We care about data privacy and security. Please review our{" "}
            <Link to="/privacy" className="text-brand-text underline underline-offset-2">
              Privacy Policy
            </Link>
            . By using the Services, you agree to be bound by our Privacy Policy, which is incorporated
            into these Legal Terms. The Services are hosted in the United States; if you access them from a
            region with different data protection laws, you consent to your data being transferred to and
            processed in the United States.
          </P>
        </Section>

        <Section id="term-termination" number={13} title="TERM AND TERMINATION">
          <P>
            These Legal Terms remain in full force while you use the Services. We reserve the right to,
            without notice or liability, deny access to and use of the Services to any person for any
            reason, including breach of these Legal Terms, and to terminate your account or delete your
            content at any time in our sole discretion.
          </P>
          <P>
            If we terminate or suspend your account, you are prohibited from registering a new account
            under your name, a fake name, or a third party&apos;s name. We reserve the right to pursue
            appropriate legal action.
          </P>
        </Section>

        <Section id="modifications" number={14} title="MODIFICATIONS AND INTERRUPTIONS">
          <P>
            We reserve the right to change, modify, or remove the contents of the Services at any time
            without notice and without liability. We cannot guarantee the Services will be available at all
            times; we may experience interruptions for maintenance or other reasons and are not liable for
            any resulting loss or inconvenience.
          </P>
        </Section>

        <Section id="governing-law" number={15} title="GOVERNING LAW">
          <P>
            These Legal Terms and your use of the Services are governed by and construed in accordance
            with the laws of {GOVERNING_LAW_JURISDICTION}, without regard to its conflict of law
            principles.
          </P>
        </Section>

        <Section id="disputes" number={16} title="DISPUTE RESOLUTION">
          <H3>Informal negotiations</H3>
          <P>
            To expedite resolution and control cost, the parties agree to first attempt to negotiate any
            dispute related to these Legal Terms informally for at least thirty (30) days before initiating
            arbitration, commencing upon written notice from one party to the other.
          </P>
          <H3>Binding arbitration</H3>
          <P>
            If informal negotiation fails, the dispute will be finally and exclusively resolved by binding
            arbitration under the Commercial Arbitration Rules of the American Arbitration Association
            (&quot;AAA&quot;). The arbitration may be conducted in person, through document submission, by
            phone, or online, and will take place in {GOVERNING_LAW_JURISDICTION} unless otherwise
            agreed. No dispute related to the Services may be brought more than one year after the cause
            of action arose.
          </P>
          <H3>Restrictions</H3>
          <P>
            Arbitration is limited to the dispute between the parties individually; no arbitration will be
            joined with another proceeding, and no dispute may be brought on a class or representative
            basis.
          </P>
          <H3>Exceptions</H3>
          <P>
            Disputes seeking to enforce or protect intellectual property rights, disputes arising from
            allegations of theft, piracy, invasion of privacy, or unauthorized use, and claims for
            injunctive relief are not subject to the above provisions.
          </P>
        </Section>

        <Section id="corrections" number={17} title="CORRECTIONS">
          <P>
            There may be information on the Services that contains typographical errors, inaccuracies, or
            omissions. We reserve the right to correct any errors and to update information at any time
            without prior notice.
          </P>
        </Section>

        <Section id="disclaimer" number={18} title="DISCLAIMER">
          <P>
            THE SERVICES ARE PROVIDED ON AN AS-IS AND AS-AVAILABLE BASIS. YOUR USE OF THE SERVICES IS AT
            YOUR SOLE RISK. TO THE FULLEST EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR
            IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE
            DO NOT WARRANT THE ACCURACY OR COMPLETENESS OF ANY CONTENT AND ASSUME NO LIABILITY FOR ERRORS,
            UNAUTHORIZED ACCESS TO OUR SERVERS, INTERRUPTIONS IN TRANSMISSION, OR HARMFUL CODE TRANSMITTED
            THROUGH THE SERVICES BY ANY THIRD PARTY.
          </P>
        </Section>

        <Section id="liability" number={19} title="LIMITATIONS OF LIABILITY">
          <P>
            IN NO EVENT WILL WE OR OUR DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE TO YOU OR ANY THIRD PARTY
            FOR ANY INDIRECT, CONSEQUENTIAL, EXEMPLARY, INCIDENTAL, SPECIAL, OR PUNITIVE DAMAGES ARISING
            FROM YOUR USE OF THE SERVICES. OUR LIABILITY TO YOU FOR ANY CAUSE WHATSOEVER WILL AT ALL TIMES
            BE LIMITED TO THE AMOUNT YOU PAID US DURING THE SIX MONTHS PRIOR TO THE CAUSE OF ACTION
            ARISING. SOME JURISDICTIONS DO NOT ALLOW THESE LIMITATIONS, SO SOME MAY NOT APPLY TO YOU.
          </P>
        </Section>

        <Section id="indemnification" number={20} title="INDEMNIFICATION">
          <P>
            You agree to defend, indemnify, and hold us harmless from any loss, damage, liability, claim,
            or demand, including reasonable attorneys&apos; fees, made by any third party due to or arising
            out of your use of the Services, breach of these Legal Terms, or violation of a third
            party&apos;s rights.
          </P>
        </Section>

        <Section id="user-data" number={21} title="USER DATA">
          <P>
            We maintain certain data you transmit to the Services for the purpose of managing performance,
            as well as data relating to your use. Although we perform regular backups, you are solely
            responsible for all data you transmit, and we have no liability for any loss or corruption of
            such data.
          </P>
        </Section>

        <Section id="electronic" number={22} title="ELECTRONIC COMMUNICATIONS, TRANSACTIONS, AND SIGNATURES">
          <P>
            Visiting the Services, sending us emails, and completing online forms constitute electronic
            communications. You consent to receive electronic communications and agree that electronic
            signatures, contracts, and records satisfy any legal requirement that such communication be in
            writing.
          </P>
        </Section>

        <Section id="california" number={23} title="CALIFORNIA USERS AND RESIDENTS">
          <P>
            If any complaint with us is not satisfactorily resolved, you can contact the Complaint
            Assistance Unit of the Division of Consumer Services of the California Department of Consumer
            Affairs in writing at 1625 North Market Blvd., Suite N 112, Sacramento, California 95834, or by
            telephone at (800) 952-5210 or (916) 445-1254.
          </P>
        </Section>

        <Section id="miscellaneous" number={24} title="MISCELLANEOUS">
          <P>
            These Legal Terms and any posted policies constitute the entire agreement between you and us.
            Our failure to enforce any right does not waive it. We may assign our rights and obligations at
            any time. If any provision is found unlawful or unenforceable, that provision is severable and
            does not affect the remaining provisions. No joint venture, partnership, employment, or agency
            relationship is created by these Legal Terms.
          </P>
        </Section>

        <Section id="data-processing" number={25} title="DATA PROCESSING">
          <P>
            Merchants using Foxhound are the data controllers for their end customers&apos; personal
            information. Foxhound acts solely as a data processor on behalf of the merchant. Merchants are
            solely responsible for their own legal bases and privacy notices for their customers. Foxhound
            processes customer data only as directed by the merchant and as necessary to provide the
            recovery, disputes, and intelligence services.
          </P>
        </Section>

        <Section id="contact" number={26} title="CONTACT US">
          <P>To resolve a complaint regarding the Services or to receive further information, contact us at:</P>
          <P>
            Foxhound
            <br />
            Email:{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand-text underline underline-offset-2">
              {SUPPORT_EMAIL}
            </a>
            <br />
            Website:{" "}
            <Link to="/" className="text-brand-text underline underline-offset-2">
              foxhoundapp.com
            </Link>
          </P>
        </Section>
      </div>
    </>
  );
}
