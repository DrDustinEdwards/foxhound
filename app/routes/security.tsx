import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { LegalBody } from "~/components/legal-page";
import { Link } from "capsomer/react/link";
import { LegalDoc, type LegalSection } from "capsomer/react/legal-doc";
import "capsomer/legal-doc.css";
import "capsomer/link.css";
import {
  RETENTION_AI_CALLS_DAYS,
  RETENTION_EMAIL_SENDS_DAYS,
  RETENTION_ENGAGEMENT_DAYS,
  RETENTION_WEBHOOK_EVENTS_DAYS,
  STRIPE_AUDIT_SCOPE,
  STRIPE_CONNECT_SCOPE,
} from "~/lib/constants";
import { AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import { GOVERNING_LAW_JURISDICTION, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/security";

// /security.
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
// the code the way marketing copy did. The subprocessor list is
// pinned to /privacy's, because two pages naming different subprocessors is a
// worse failure than either naming none.
//
// The shell is /privacy's and /terms': Capsomer's LegalDoc in legal-page's column.

export const loader = siteUrlLoader;

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Security",
    description:
      "How Foxhound handles Stripe access, encryption, data retention, subprocessors and vulnerability reports.",
    path: "/security",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

const SECTIONS: LegalSection[] = [
  {
    id: "stripe-access",
    title: "WHAT FOXHOUND CAN DO IN YOUR STRIPE ACCOUNT",
    body: (
      <>
        <p>
          Foxhound connects through Stripe Connect OAuth, and it asks for two different levels of
          access depending on what you are doing.
        </p>
        <p>
          <strong className="text-text">
            The free audit requests {STRIPE_AUDIT_SCOPE} scope too.
          </strong>{" "}
          Stripe no longer offers read-only access to platforms like Foxhound, so Stripe asks you
          for full (read and write) access. During the audit Foxhound only reads invoices,
          subscriptions, disputes and customer records to produce the report, and writes nothing.
          After {AUDIT_GRANT_MINUTES} minutes Foxhound disconnects itself from your Stripe account,
          unless you connect a Foxhound account.
        </p>
        <p>
          <strong className="text-text">
            Merchant onboarding requests {STRIPE_CONNECT_SCOPE} scope
          </strong>
          , because recovery involves writes. Foxhound writes for these things and no others:
          retrying payment on an invoice that has already failed, setting a customer default payment
          method after that customer updates their card, opening a Stripe checkout when a former
          customer chooses to resubscribe, submitting dispute evidence once someone on your team has
          approved it, and closing a dispute at Stripe when you choose to accept it. It never
          changes prices, products or subscription plans, never charges a customer except by
          retrying a failed invoice or through a checkout they complete, and never reaches your
          payouts or bank account.
        </p>
        <p>
          An audit prospect who becomes a merchant re-authorizes at that point. The audit connection
          is never silently upgraded.
        </p>
      </>
    ),
  },
  {
    id: "card-data",
    title: "CARD DATA",
    body: (
      <>
        <p>
          No card number, expiry or CVC ever reaches Foxhound. Card details are entered on Stripe
          surfaces and stay with Stripe. When a customer updates a card through a Foxhound link, the
          page collects nothing: it hands off to Stripe and Foxhound learns only that the payment
          method changed.
        </p>
      </>
    ),
  },
  {
    id: "encryption",
    title: "ENCRYPTION AT REST",
    body: (
      <>
        <p>
          The Stripe access token for a connected account is encrypted before it is stored, using
          AES-256-GCM with a 96-bit initialization vector per record. Nothing else Foxhound stores
          is a credential.
        </p>
        <p>
          Keys are a keyring rather than a single value: every stored record carries the id of the
          key that encrypted it, so a key can be rotated by adding a new one and re-encrypting on
          read, without a migration that has to touch every row at once. Traffic in transit is TLS
          end to end, terminated by Cloudflare.
        </p>
      </>
    ),
  },
  {
    id: "sessions",
    title: "ACCOUNTS AND SESSIONS",
    body: (
      <>
        <p>
          Sign-in has no passwords: a link or code sent to your email, a passkey, or your Google or
          Apple account. Sessions are stored in Cloudflare D1, the same database as the rest of the
          application data. Sessions are not held in a key-value store or in a third-party session
          service.
        </p>
        <p>
          API keys for the Foxhound MCP endpoint are shown once, at the moment you generate them,
          and only a hash is stored, so Foxhound cannot show you a key again and cannot leak one it
          does not hold. Revoking a key takes effect immediately. Some actions are never available
          to an API key at all: submitting dispute evidence, connecting or disconnecting Stripe, and
          anything that records an outcome or bills. Those require a signed-in person, and the
          endpoint exposes no tool for them.
        </p>
      </>
    ),
  },
  {
    id: "subprocessors",
    title: "SUBPROCESSORS",
    body: (
      <>
        <p>
          Foxhound shares data with the infrastructure providers that run the service: Stripe
          (payments and Connect), Cloudflare (hosting, database and email delivery), and Anthropic
          (drafting recovery emails and dispute evidence). The same three are named in the{" "}
          <Link to="/privacy">privacy policy</Link>, and that list is the authoritative one.
        </p>
        <p>
          Foxhound does not sell data and does not share it with advertising or analytics networks.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "HOW LONG DATA IS KEPT",
    body: (
      <>
        <p>
          Engagement events are kept for {RETENTION_ENGAGEMENT_DAYS} days and email send records for{" "}
          {RETENTION_EMAIL_SENDS_DAYS} days. Webhook events are kept for{" "}
          {RETENTION_WEBHOOK_EVENTS_DAYS} days and AI call logs for {RETENTION_AI_CALLS_DAYS} days.
          Billing records are kept for as long as the law requires. Scheduled jobs delete data past
          those windows rather than leaving it to accumulate.
        </p>
        <p>
          Disconnecting Stripe stops recovery work on that account immediately. Canceling the
          account removes it. Neither waives fees already earned on recoveries Foxhound attributed.
        </p>
      </>
    ),
  },
  {
    id: "disclosure",
    title: "REPORTING A VULNERABILITY",
    body: (
      <>
        <p>
          Email <span className="font-mono">{SUPPORT_EMAIL}</span> with what you found and how to
          reproduce it. The same address is published at{" "}
          <span className="font-mono">/.well-known/security.txt</span> per RFC 9116, with an expiry
          date so you can tell the contact is current.
        </p>
        <p>
          Foxhound is a small operation and runs no bug bounty, so there is no payment and no triage
          queue. What there is: a real address that a person reads, and no legal action against
          anyone who reports a genuine issue in good faith and gives us a chance to fix it before
          publishing.
        </p>
      </>
    ),
  },
  {
    id: "dpa",
    title: "DATA PROCESSING AGREEMENT",
    body: (
      <>
        <p>
          A data processing agreement is available on request. Email{" "}
          <span className="font-mono">{SUPPORT_EMAIL}</span>.
        </p>
      </>
    ),
  },
  {
    id: "entity",
    title: "WHO OPERATES FOXHOUND",
    body: (
      <>
        <p>
          Foxhound is operated by Dustin Edwards, a sole proprietor based in{" "}
          {GOVERNING_LAW_JURISDICTION}, United States. There is no separate legal entity behind it
          today, and this page will say so until there is.
        </p>
        <p>
          Foxhound holds no third-party security certification. Nothing here is an audit,
          attestation or compliance claim, and none will appear on this page until an assessor has
          signed one.
        </p>
      </>
    ),
  },
];

export default function SecurityPage() {
  return (
    <LegalBody>
      <LegalDoc
        title="Security"
        updated="2026-11-11"
        intro={
          <>
            <p>
              This page describes what Foxhound can reach in a connected Stripe account, how that
              access is stored, who else processes the data, and how to report a vulnerability. It
              states what the system does today. Where Foxhound has no certification, it says so
              rather than implying one.
            </p>
          </>
        }
        sections={SECTIONS}
      />
    </LegalBody>
  );
}

export const headers = () => publicPageHeaders();
