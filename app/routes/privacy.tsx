import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/privacy";

// Ported from legacy app/(marketing)/privacy/page.tsx (Phase 6 Pass 1): same
// 15-section structure. Legacy's body text ran to roughly 55KB of generic
// template legal copy; this rewrites each section to describe what Foxhound
// actually does (Stripe Connect read_write scope, Cloudflare D1/Workers
// storage, first-party engagement tracking, Anthropic-based email drafting,
// the real retention windows from app/lib/constants.ts) rather than porting
// the legacy wording verbatim.
//
// "Summary of key points" callout restored (TASK-foxhound-parity-cluster-
// b.md fix 5), confirmed live on recova-eta.vercel.app/privacy before
// building: a bordered card between the intro paragraph and the numbered
// sections. The bullets below are written against THIS page's actual 15
// sections, not copied from legacy's summary: legacy's policy differs
// (GDPR/CCPA boilerplate; this one describes the real Stripe OAuth scope,
// Foxhound's own AI-drafting-plus-human-approval flow, and its real
// retention windows). Legacy's own summary intro claims "click the link
// following each key point," but the live page renders zero such links
// (checked directly, 0 `<a>` elements inside its summary list) - a legacy
// copy/content mismatch, not something to replicate; this version's intro
// only promises what actually exists here (the Contents list above).
//
// Also fixes a duplicate nested <main> landmark noticed while touching
// this component: marketing.tsx already renders the page's one <main>.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Privacy Policy - Foxhound",
    description: "Privacy policy for Foxhound, the payment recovery platform for Stripe merchants.",
    path: "/privacy",
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
  { id: "collect", number: 1, title: "WHAT INFORMATION DO WE COLLECT?" },
  { id: "process", number: 2, title: "HOW DO WE PROCESS YOUR INFORMATION?" },
  { id: "legal-bases", number: 3, title: "WHAT LEGAL BASES DO WE RELY ON?" },
  { id: "share", number: 4, title: "WHEN AND WITH WHOM DO WE SHARE YOUR INFORMATION?" },
  { id: "ai", number: 5, title: "DO WE USE ARTIFICIAL INTELLIGENCE?" },
  { id: "international", number: 6, title: "IS YOUR INFORMATION TRANSFERRED INTERNATIONALLY?" },
  { id: "retention", number: 7, title: "HOW LONG DO WE KEEP YOUR INFORMATION?" },
  { id: "safe", number: 8, title: "HOW DO WE KEEP YOUR INFORMATION SAFE?" },
  { id: "minors", number: 9, title: "DO WE COLLECT INFORMATION FROM MINORS?" },
  { id: "rights", number: 10, title: "WHAT ARE YOUR PRIVACY RIGHTS?" },
  { id: "dnt", number: 11, title: "CONTROLS FOR DO-NOT-TRACK FEATURES" },
  { id: "us-residents", number: 12, title: "DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS?" },
  { id: "updates", number: 13, title: "DO WE MAKE UPDATES TO THIS NOTICE?" },
  { id: "contact", number: 14, title: "HOW CAN YOU CONTACT US ABOUT THIS NOTICE?" },
  { id: "review", number: 15, title: "HOW CAN YOU REVIEW, UPDATE, OR DELETE YOUR DATA?" },
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

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-item-title leading-relaxed text-text-secondary">{children}</p>;
}

export default function PrivacyPage() {
  return (
    <>
      <MarketingPageHeader eyebrow="Legal" title="Privacy Policy" subtext="Last updated July 18, 2026" />

      <div className="mx-auto max-w-[720px] px-6 pb-16">
        <section className="mb-12">
          <h2 className="mb-3 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">Contents</h2>
          <ol className="m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 p-0 sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <li key={s.id} className="list-none text-label">
                <a href={`#${s.id}`} className="text-amber-text underline underline-offset-2 hover:text-amber">
                  {s.number}. {s.title}
                </a>
              </li>
            ))}
          </ol>
        </section>

        <hr className="my-10 border-border" />

        <P>
          This notice describes how Foxhound (&quot;we,&quot; &quot;us,&quot; &quot;our&quot;) collects,
          uses, and shares information when a merchant connects a Stripe account and when that
          merchant&apos;s customers interact with recovery emails and hosted pages Foxhound sends on the
          merchant&apos;s behalf.
        </P>

        <section className="mb-8 mt-8 rounded-[12px] border border-border bg-surface p-6">
          <h2 className="mb-3 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">
            Summary of key points
          </h2>
          <p className="mb-4 text-item-title leading-relaxed text-text-secondary">
            This summary covers the key points from our Privacy Policy below. Use the contents list
            above to jump to the full detail on any topic.
          </p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0 text-copy leading-relaxed text-text-secondary">
            <li>
              <strong className="text-text">What information do we collect?</strong> Merchant Stripe
              data (invoices, subscriptions, disputes, customer records) through a Stripe OAuth
              connection, plus first-party engagement signals we generate ourselves, whether a recovery
              email was opened or clicked, never a third-party tracking vendor.
            </li>
            <li>
              <strong className="text-text">Do we use artificial intelligence?</strong> Yes, to draft
              recovery email copy and dispute evidence. Dispute evidence always requires a human on the
              merchant&apos;s team to review and approve before it reaches Stripe.
            </li>
            <li>
              <strong className="text-text">Who do we share information with?</strong> Only the
              infrastructure providers that run the Services: Stripe, Cloudflare, and Anthropic. We do
              not sell personal information or share it for anyone else&apos;s marketing.
            </li>
            <li>
              <strong className="text-text">How long do we keep information?</strong> Engagement events
              and email sends for 180 days, webhook and AI call logs for 90 days, billing records for as
              long as the account stays active.
            </li>
            <li>
              <strong className="text-text">How do we keep information safe?</strong> Stripe access is
              limited to a short list of actions, no card numbers are stored, and sensitive tokens are
              encrypted at rest with AES-256.
            </li>
            <li>
              <strong className="text-text">What are your rights?</strong> Merchants can review and
              update account data in Settings, and can request deletion by contacting us. A
              merchant&apos;s customers should contact that merchant directly.
            </li>
            <li>
              <strong className="text-text">Is information transferred internationally?</strong>{" "}
              Foxhound is a US company under US jurisdiction; Cloudflare Workers may process a request at
              an edge location outside the US as ordinary delivery, but our data stores and governing law
              are US-based.
            </li>
          </ul>
        </section>

        <Section id="collect" number={1} title="WHAT INFORMATION DO WE COLLECT?">
          <P>
            From merchants: account and contact information, and the Stripe data your OAuth connection
            grants us access to, invoices, subscriptions, disputes, and customer records needed to run
            recovery sequences and dispute drafts.
          </P>
          <P>
            From merchants&apos; customers: information Stripe already has about a failed payment (name,
            email, decline reason), plus first-party engagement signals we generate ourselves, whether a
            recovery email was opened or a link in it was clicked, recorded through our own tracking
            routes rather than a third-party vendor.
          </P>
        </Section>

        <Section id="process" number={2} title="HOW DO WE PROCESS YOUR INFORMATION?">
          <P>
            We process information to run recovery sequences (silent retries, then email sequences),
            draft dispute evidence for human review and approval, compute MRR and churn analytics, bill
            matured recoveries, and operate the product generally (authentication, support, fraud
            prevention).
          </P>
        </Section>

        <Section id="legal-bases" number={3} title="WHAT LEGAL BASES DO WE RELY ON?">
          <P>
            We process merchant data under contract, to provide the Services the merchant signed up for.
            We process a merchant&apos;s customer data as a processor acting on the merchant&apos;s
            instructions; the merchant, not Foxhound, is the data controller for their own customers and is
            responsible for having an appropriate legal basis and privacy notice of their own.
          </P>
        </Section>

        <Section id="share" number={4} title="WHEN AND WITH WHOM DO WE SHARE YOUR INFORMATION?">
          <P>
            We share data with the infrastructure providers that run the Services: Stripe (payments and
            Connect), Cloudflare (hosting, database, and email delivery), and Anthropic (drafting recovery
            email copy and dispute evidence, see the AI section below). We do not sell personal
            information, and we do not share merchant or customer data with anyone for their own marketing
            purposes.
          </P>
        </Section>

        <Section id="ai" number={5} title="DO WE USE ARTIFICIAL INTELLIGENCE?">
          <P>
            Yes. Foxhound uses AI models to draft recovery email copy and dispute evidence. Recovery
            copy passes an automated quality check before it sends. Dispute evidence always requires a
            human on the merchant&apos;s team to review and approve it before it is submitted to Stripe,
            there is no automatic submission path. AI drafting uses the decline or dispute data needed to
            write the draft; it is not used to build advertising profiles.
          </P>
        </Section>

        <Section id="international" number={6} title="IS YOUR INFORMATION TRANSFERRED INTERNATIONALLY?">
          <P>
            Foxhound is a US company operating under US jurisdiction. The Services run on Cloudflare
            Workers, a global network, so requests may be processed at an edge location outside the United
            States as part of ordinary delivery, but the company itself, its data stores, and its
            governing law are US-based.
          </P>
        </Section>

        <Section id="retention" number={7} title="HOW LONG DO WE KEEP YOUR INFORMATION?">
          <P>
            We keep raw engagement events (opens and clicks) and email send records for 180 days, then
            delete them. Webhook event logs and AI call records are kept for 90 days. Billing records
            (invoices, line items, the evidence ledger) are kept for as long as the account is active,
            since they are the record of what was billed and why.
          </P>
        </Section>

        <Section id="safe" number={8} title="HOW DO WE KEEP YOUR INFORMATION SAFE?">
          <P>
            The Stripe OAuth connection carries read and write scope, because retrying a failed invoice
            is a write. Foxhound uses the write half for three things and no others: retrying payment on
            an invoice that has already failed, setting a customer default payment method after that
            customer updates their card, and submitting dispute evidence once someone on your team has
            approved it. It never changes prices, products, or subscription plans, never creates a charge
            outside an invoice you already issued, and never reaches your payouts or bank account.
            Foxhound never stores card numbers. Sensitive tokens are encrypted at rest with AES-256.
            Access to production data is limited to what the Services need to run.
          </P>
        </Section>

        <Section id="minors" number={9} title="DO WE COLLECT INFORMATION FROM MINORS?">
          <P>The Services are intended for business use and are not directed at anyone under 18. We do not knowingly collect information from minors.</P>
        </Section>

        <Section id="rights" number={10} title="WHAT ARE YOUR PRIVACY RIGHTS?">
          <P>
            Merchants can review and update their account data from Settings at any time. Deletion is
            by request rather than self-serve: contact us and we will confirm what will be deleted and
            what we are required to keep. Section 15 sets out that process. A merchant&apos;s customers
            should contact that merchant directly, Foxhound processes their data on the
            merchant&apos;s instructions and is not the right party to field an end-customer request
            directly.
          </P>
        </Section>

        <Section id="dnt" number={11} title="CONTROLS FOR DO-NOT-TRACK FEATURES">
          <P>
            There is no uniform standard for Do-Not-Track signals yet, so the Services do not currently
            respond to them differently.
          </P>
        </Section>

        <Section id="us-residents" number={12} title="DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS?">
          <P>
            Depending on your state, you may have rights to access, correct, or delete personal
            information we hold about you, or to opt out of certain processing. Contact us at{" "}
            {SUPPORT_EMAIL} to make a request; we will respond consistent with applicable state
            law.
          </P>
        </Section>

        <Section id="updates" number={13} title="DO WE MAKE UPDATES TO THIS NOTICE?">
          <P>
            Yes. We will update this notice as needed to stay compliant with relevant laws, and we will
            update the date at the top of this page when we do.
          </P>
        </Section>

        <Section id="contact" number={14} title="HOW CAN YOU CONTACT US ABOUT THIS NOTICE?">
          <P>
            Email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-amber-text underline underline-offset-2 hover:text-amber">
              {SUPPORT_EMAIL}
            </a>
            . See also our{" "}
            <Link to="/terms" className="text-amber-text underline underline-offset-2 hover:text-amber">
              Terms of Service
            </Link>
            .
          </P>
        </Section>

        <Section id="review" number={15} title="HOW CAN YOU REVIEW, UPDATE, OR DELETE YOUR DATA?">
          <P>
            Merchants can review and update account information from Settings at any time. To request
            deletion of an account and its associated data, email {SUPPORT_EMAIL}; we will confirm
            what will be deleted and what, if anything, we are required to retain (for example, billing
            records tied to fees already charged).
          </P>
        </Section>
      </div>
    </>
  );
}
