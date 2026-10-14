import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  RETENTION_AI_CALLS_DAYS,
  RETENTION_EMAIL_SENDS_DAYS,
  RETENTION_ENGAGEMENT_DAYS,
  RETENTION_WEBHOOK_EVENTS_DAYS,
  STRIPE_AUDIT_SCOPE,
  STRIPE_CONNECT_SCOPE,
} from "~/lib/constants";
import { GOVERNING_LAW_JURISDICTION, siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/security";

// /security (377 item 11).
//
// WHAT THIS PAGE IS, and the constraint is the whole design: it states what
// Foxhound actually does and nothing else. 377 item 11 is explicit that no
// attestation claim of any kind appears until an auditor has signed one, so
// there is no SOC 2, no penetration test, no "bank-grade", no compliance badge
// and no security theatre on this page. A buyer's security questionnaire is
// answered by facts about the system or it is not answered.
//
// EVERY FACTUAL CLAIM IS DERIVED FROM THE THING THAT MAKES IT TRUE. The OAuth
// scopes come from the constants the OAuth calls send, and the retention windows
// from the constants the sweepers delete on, so this page cannot drift away from
// the code the way marketing copy did (376 item 18). The subprocessor list is
// pinned to /privacy's, because two pages naming different subprocessors is a
// worse failure than either naming none.
//
// The shell is /privacy's and /terms': MarketingPageHeader plus the same 720px
// prose column, the same Section and P helpers. No layout system changes.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Security - Foxhound",
    description:
      "How Foxhound handles Stripe access, encryption, data retention, subprocessors and vulnerability reports.",
    path: "/security",
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

export const SECURITY_SECTIONS: SectionDef[] = [
  { id: "stripe-access", number: 1, title: "WHAT FOXHOUND CAN DO IN YOUR STRIPE ACCOUNT" },
  { id: "card-data", number: 2, title: "CARD DATA" },
  { id: "encryption", number: 3, title: "ENCRYPTION AT REST" },
  { id: "sessions", number: 4, title: "ACCOUNTS AND SESSIONS" },
  { id: "subprocessors", number: 5, title: "SUBPROCESSORS" },
  { id: "retention", number: 6, title: "HOW LONG DATA IS KEPT" },
  { id: "disclosure", number: 7, title: "REPORTING A VULNERABILITY" },
  { id: "dpa", number: 8, title: "DATA PROCESSING AGREEMENT" },
  { id: "entity", number: 9, title: "WHO OPERATES FOXHOUND" },
];

function Section({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: number;
  title: string;
  children: React.ReactNode;
}) {
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

export default function SecurityPage() {
  return (
    <>
      <MarketingPageHeader
        eyebrow="Legal"
        title="Security"
        subtext="What Foxhound can reach, how it is stored, and how to report a problem"
      />

      <div className="mx-auto max-w-[720px] px-6 pb-16">
        <section className="mb-12">
          <h2 className="mb-3 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">
            Contents
          </h2>
          <ol className="m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 p-0 sm:grid-cols-2">
            {SECURITY_SECTIONS.map((s) => (
              <li key={s.id} className="list-none text-label">
                <a
                  href={`#${s.id}`}
                  className="text-brand-text underline underline-offset-2"
                >
                  {s.number}. {s.title}
                </a>
              </li>
            ))}
          </ol>
        </section>

        <hr className="my-10 border-border" />

        <P>
          This page describes what Foxhound can reach in a connected Stripe account, how that access
          is stored, who else processes the data, and how to report a vulnerability. It states what
          the system does today. Where Foxhound has no certification, it says so rather than
          implying one.
        </P>

        <Section id="stripe-access" number={1} title="WHAT FOXHOUND CAN DO IN YOUR STRIPE ACCOUNT">
          <P>
            Foxhound connects through Stripe Connect OAuth, and it asks for two different levels of
            access depending on what you are doing.
          </P>
          <P>
            <strong className="text-text">The free audit requests {STRIPE_AUDIT_SCOPE} scope.</strong>{" "}
            It reads invoices, subscriptions, disputes and customer records to produce the report,
            and it cannot write anything at all. If you only ever run an audit, Foxhound never has
            permission to change your Stripe account.
          </P>
          <P>
            <strong className="text-text">Merchant onboarding requests {STRIPE_CONNECT_SCOPE} scope</strong>, because
            recovery involves writes. Foxhound writes in exactly three places: retrying payment on an
            invoice that has already failed, setting a customer default payment method after that
            customer updates their card, and submitting dispute evidence once someone on your team
            has approved it. It never changes prices, products or subscription plans, never creates a
            charge outside an invoice you already issued, and never reaches your payouts or bank
            account.
          </P>
          <P>
            An audit prospect who becomes a merchant re-authorizes at that point. The audit
            connection is never silently upgraded.
          </P>
        </Section>

        <Section id="card-data" number={2} title="CARD DATA">
          <P>
            No card number, expiry or CVC ever reaches Foxhound. Card details are entered on Stripe
            surfaces and stay with Stripe. When a customer updates a card through a Foxhound link,
            the page collects nothing: it hands off to Stripe and Foxhound learns only that the
            payment method changed.
          </P>
        </Section>

        <Section id="encryption" number={3} title="ENCRYPTION AT REST">
          <P>
            The Stripe access token for a connected account is encrypted before it is stored, using
            AES-256-GCM with a 96-bit initialization vector per record. Nothing else Foxhound stores
            is a credential.
          </P>
          <P>
            Keys are a keyring rather than a single value: every stored record carries the id of the
            key that encrypted it, so a key can be rotated by adding a new one and re-encrypting on
            read, without a migration that has to touch every row at once. Traffic in transit is TLS
            end to end, terminated by Cloudflare.
          </P>
        </Section>

        <Section id="sessions" number={4} title="ACCOUNTS AND SESSIONS">
          <P>
            Sign-in is email and password or Google, and sessions are stored in Cloudflare D1, the
            same database as the rest of the application data. Sessions are not held in a key-value
            store or in a third-party session service.
          </P>
          <P>
            API keys for the Foxhound MCP endpoint are shown once, at the moment you generate them,
            and only a hash is stored, so Foxhound cannot show you a key again and cannot leak one it
            does not hold. Revoking a key takes effect immediately. Some actions are never available
            to an API key at all: submitting dispute evidence, connecting or disconnecting Stripe,
            and anything that records an outcome or bills. Those require a signed-in person, and the
            endpoint exposes no tool for them.
          </P>
        </Section>

        <Section id="subprocessors" number={5} title="SUBPROCESSORS">
          <P>
            Foxhound shares data with the infrastructure providers that run the service: Stripe
            (payments and Connect), Cloudflare (hosting, database and email delivery), and Anthropic
            (drafting recovery emails and dispute evidence). The same three are named in the{" "}
            <Link to="/privacy" className="text-brand-text underline underline-offset-2">
              privacy policy
            </Link>
            , and that list is the authoritative one.
          </P>
          <P>
            Foxhound does not sell data and does not share it with advertising or analytics networks.
          </P>
        </Section>

        <Section id="retention" number={6} title="HOW LONG DATA IS KEPT">
          <P>
            Engagement events are kept for {RETENTION_ENGAGEMENT_DAYS} days and email send records
            for {RETENTION_EMAIL_SENDS_DAYS} days. Webhook events are kept for{" "}
            {RETENTION_WEBHOOK_EVENTS_DAYS} days and AI call logs for {RETENTION_AI_CALLS_DAYS}{" "}
            days. Billing records are kept for as long as the law requires. Scheduled jobs delete
            data past those windows rather than leaving it to accumulate.
          </P>
          <P>
            Disconnecting Stripe stops recovery work on that account immediately. Cancelling the
            account removes it. Neither waives fees already earned on recoveries Foxhound attributed.
          </P>
        </Section>

        <Section id="disclosure" number={7} title="REPORTING A VULNERABILITY">
          <P>
            Email <span className="font-mono">{SUPPORT_EMAIL}</span> with what you found and how to
            reproduce it. The same address is published at{" "}
            <span className="font-mono">/.well-known/security.txt</span> per RFC 9116, with an expiry
            date so you can tell the contact is current.
          </P>
          <P>
            Foxhound is a small operation and runs no bug bounty, so there is no payment and no
            triage queue. What there is: a real address that a person reads, and no legal action
            against anyone who reports a genuine issue in good faith and gives us a chance to fix it
            before publishing.
          </P>
        </Section>

        <Section id="dpa" number={8} title="DATA PROCESSING AGREEMENT">
          <P>
            A data processing agreement is available on request. Email{" "}
            <span className="font-mono">{SUPPORT_EMAIL}</span>.
          </P>
        </Section>

        <Section id="entity" number={9} title="WHO OPERATES FOXHOUND">
          <P>
            Foxhound is operated by Dustin Edwards, a sole proprietor based in{" "}
            {GOVERNING_LAW_JURISDICTION}, United States. There is no separate legal entity behind it
            today, and this page will say so until there is.
          </P>
          <P>
            Foxhound holds no third-party security certification. Nothing here is an audit,
            attestation or compliance claim, and none will appear on this page until an assessor has
            signed one.
          </P>
        </Section>
      </div>
    </>
  );
}
