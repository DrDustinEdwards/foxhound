import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { LegalBody, LegalServiceDescription } from "~/components/legal-page";
import { CARD } from "~/components/marketing-card";
import { AwayLink, Link } from "capsomer/react/link";
import { LegalDoc, type LegalSection } from "capsomer/react/legal-doc";
import "capsomer/legal-doc.css";
import "capsomer/link.css";
import {
  RETENTION_AI_CALLS_DAYS,
  RETENTION_EMAIL_SENDS_DAYS,
  RETENTION_ENGAGEMENT_DAYS,
  RETENTION_WEBHOOK_EVENTS_DAYS,
} from "~/lib/constants";
import { GOVERNING_LAW_JURISDICTION, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/privacy";

// Recova's privacy notice, word for word (Dustin, 2026-11-11: "the privacy and
// terms page should have been word for word and then updated to be Foxhound
// instead of recova and then adjusted for any changes we might have made to how
// the sites work"). Source: recovamrr.com/privacy as served on 2026-11-11, the
// page built from legacy app/(marketing)/privacy/page.tsx. Every section, list
// and sentence is Recova's except where Foxhound works differently:
//
// - the operator is Dustin Edwards, sole proprietor, Texas (hard rule 12);
// - the product description says what Foxhound does (silent retry first,
//   dispute responses only on approval or the merchant's opt-in auto-submit);
// - the personal information list, the other sources and the service
//   providers are Foxhound's own (Cloudflare in place of Vercel, Supabase and
//   Resend; Google and Apple sign-in; Amazon for off-site file backups);
// - the retention windows are the engine's constants and the account deletion
//   that keeps fee evidence (Q14 and Q16), not Recova's one month;
// - the EU, UK, Swiss and Canadian paragraphs are left out, because the
//   network's sites are written for US and Texas law only;
// - the "Learn more" pointers in the summary link to their sections, which
//   Recova's never did, and Recova's dead /contact link is gone (Foxhound has
//   no contact page; the email is the way to reach us).
//
// The page has one main landmark: marketing.tsx renders it.

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
  {
    id: "collect",
    title: "WHAT INFORMATION DO WE COLLECT?",
    body: (
      <>
        <h3>Personal information you disclose to us</h3>
        <p>
          <em>In Short:</em> We collect personal information that you provide to us.
        </p>
        <p>
          We collect personal information that you voluntarily provide to us when you register on
          the Services, express an interest in obtaining information about us or our products and
          Services, when you participate in activities on the Services, or otherwise when you
          contact us.
        </p>
        <p>
          Personal Information Provided by You. The personal information that we collect depends on
          the context of your interactions with us and the Services, the choices you make, and the
          products and features you use. The personal information we collect may include the
          following:
        </p>
        <ul>
          <li>names</li>
          <li>email addresses</li>
          <li>passkeys, of which we store only the public key</li>
          <li>business names</li>
          <li>contact preferences</li>
        </ul>
        <p>Sensitive Information. We do not process sensitive information.</p>
        <p>
          Payment Data. We may collect data necessary to process your payment if you choose to make
          purchases, such as your payment instrument number, and the security code associated with
          your payment instrument. All payment data is handled and stored by Stripe. You may find
          their privacy notice link(s) here:{" "}
          <AwayLink href="https://stripe.com/privacy">https://stripe.com/privacy</AwayLink>.
        </p>
        <p>
          Social Media Login Data. If you choose to sign in with Google or Apple, we receive your
          name and email address from that provider.
        </p>
        <p>
          All personal information that you provide to us must be true, complete, and accurate, and
          you must notify us of any changes to such personal information.
        </p>
        <h3>Information automatically collected</h3>
        <p>
          <em>In Short:</em> Some information such as your Internet Protocol (IP) address and/or
          browser and device characteristics is collected automatically when you visit our Services.
        </p>
        <p>
          We automatically collect certain information when you visit, use, or navigate the
          Services. This information does not reveal your specific identity (like your name or
          contact information) but may include device and usage information, such as your IP
          address, browser and device characteristics, operating system, language preferences,
          referring URLs, device name, country, location, information about how and when you use our
          Services, and other technical information. This information is primarily needed to
          maintain the security and operation of our Services, and for our internal analytics and
          reporting purposes.
        </p>
        <p>The information we collect includes:</p>
        <ul>
          <li>
            Log and Usage Data. Log and usage data is service-related, diagnostic, usage, and
            performance information our servers automatically collect when you access or use our
            Services and which we record in log files. Depending on how you interact with us, this
            log data may include your IP address, device information, browser type, and settings and
            information about your activity in the Services (such as the date/time stamps associated
            with your usage, pages and files viewed, searches, and other actions you take such as
            which features you use), device event information (such as system activity, error
            reports (sometimes called &quot;crash dumps&quot;), and hardware settings).
          </li>
          <li>
            Device Data. We collect device data such as information about your computer, phone,
            tablet, or other device you use to access the Services. Depending on the device used,
            this device data may include information such as your IP address (or proxy server),
            device and application identification numbers, location, browser type, hardware model,
            Internet service provider and/or mobile carrier, operating system, and system
            configuration information.
          </li>
          <li>
            Email Engagement Data. When someone opens a recovery or win-back email we send for a
            merchant, or clicks a link in it, we record the open or the click through our own links
            and image, not through a third-party tracking service.
          </li>
        </ul>
        <h3 id="other-sources">Information collected from other sources</h3>
        <p>
          <em>In Short:</em> We collect data from Stripe when a merchant connects a Stripe account,
          and from Google or Apple when you sign in with them.
        </p>
        <p>
          When a merchant connects a Stripe account, we receive the Stripe data the Services need to
          run: the merchant&apos;s customers&apos; names and email addresses, their subscriptions
          and invoices, failed payments and the reasons Stripe gives for them, and disputes with the
          details Stripe holds on the disputed charge, such as a billing address. We process this
          information on the merchant&apos;s behalf and on the merchant&apos;s instructions. If you
          are a customer of a merchant that uses Foxhound, the merchant&apos;s own privacy notice
          explains how it uses your information. We do not buy information about you from data
          brokers, marketing partners, or other third parties.
        </p>
      </>
    ),
  },
  {
    id: "process",
    title: "HOW DO WE PROCESS YOUR INFORMATION?",
    body: (
      <>
        <p>
          <em>In Short:</em> We process your information to provide, improve, and administer our
          Services, communicate with you, for security and fraud prevention, and to comply with law.
          We process the personal information for the following purposes listed below. We may also
          process your information for other purposes only with your prior explicit consent.
        </p>
        <p>
          We process your personal information for a variety of reasons, depending on how you
          interact with our Services, including:
        </p>
        <ul>
          <li>
            To facilitate account creation and authentication and otherwise manage user accounts. We
            may process your information so you can create and log in to your account, as well as
            keep your account in working order.
          </li>
          <li>
            To deliver and facilitate delivery of services to the user. We may process your
            information to provide you with the requested service, including retrying failed
            payments, sending recovery and win-back emails on a merchant&apos;s behalf, drafting and
            submitting dispute evidence, and computing revenue and churn analytics.
          </li>
          <li>
            To bill our fees. We may process records of the payments Foxhound recovered and the
            disputes it won to calculate and charge our fees.
          </li>
          <li>
            To respond to user inquiries/offer support to users. We may process your information to
            respond to your inquiries and solve any potential issues you might have with the
            requested service.
          </li>
          <li>
            To send administrative information to you. We may process your information to send you
            details about our products and services, changes to our terms and policies, and other
            similar information.
          </li>
          <li>
            To request feedback. We may process your information when necessary to request feedback
            and to contact you about your use of our Services.
          </li>
          <li>
            To protect our Services. We may process your information as part of our efforts to keep
            our Services safe and secure, including fraud monitoring and prevention.
          </li>
          <li>
            To identify usage trends. We may process information about how you use our Services to
            better understand how they are being used so we can improve them.
          </li>
          <li>
            To save or protect an individual&apos;s vital interest. We may process your information
            when necessary to save or protect an individual&apos;s vital interest, such as to
            prevent harm.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "legal-bases",
    title: "WHAT LEGAL BASES DO WE RELY ON TO PROCESS YOUR PERSONAL INFORMATION?",
    body: (
      <>
        <p>
          <em>In Short:</em> We only process your personal information when we believe it is
          necessary and we have a valid legal reason (i.e., legal basis) to do so under applicable
          law, like with your consent, to comply with laws, to provide you with services to enter
          into or fulfill our contractual obligations, to protect your rights, or to fulfill our
          legitimate business interests.
        </p>
        <p>We may rely on the following legal bases to process your personal information:</p>
        <ul>
          <li>
            Consent. We may process your information if you have given us permission (i.e., consent)
            to use your personal information for a specific purpose. You can withdraw your consent
            at any time. <More to="rights">Learn more about withdrawing your consent.</More>
          </li>
          <li>
            Performance of a Contract. We may process your personal information when we believe it
            is necessary to fulfill our contractual obligations to you, including providing our
            Services or at your request prior to entering into a contract with you.
          </li>
          <li>
            Legitimate Interests. We may process your information when we believe it is reasonably
            necessary to achieve our legitimate business interests and those interests do not
            outweigh your interests and fundamental rights and freedoms. For example, we may process
            your personal information for some of the purposes described in order to: Analyze how
            our Services are used so we can improve them to engage and retain users; Diagnose
            problems and/or prevent fraudulent activities; Understand how our users use our products
            and services so we can improve user experience.
          </li>
          <li>
            Legal Obligations. We may process your information where we believe it is necessary for
            compliance with our legal obligations, such as to cooperate with a law enforcement body
            or regulatory agency, exercise or defend our legal rights, or disclose your information
            as evidence in litigation in which we are involved.
          </li>
          <li>
            Vital Interests. We may process your information where we believe it is necessary to
            protect your vital interests or the vital interests of a third party, such as situations
            involving potential threats to the safety of any person.
          </li>
        </ul>
        <p>
          When we process information about a merchant&apos;s customers, we do so on the
          merchant&apos;s instructions. The merchant is responsible for having its own legal basis
          and privacy notice for its customers, as our{" "}
          <Link to="/terms#data-processing">Terms of Service</Link> set out.
        </p>
      </>
    ),
  },
  {
    id: "share",
    title: "WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?",
    body: (
      <>
        <p>
          <em>In Short:</em> We may share information in specific situations described in this
          section and/or with the following third parties.
        </p>
        <p>
          Vendors, Consultants, and Other Third-Party Service Providers. We may share your data with
          third-party vendors, service providers, contractors, or agents (&quot;third parties&quot;)
          who perform services for us or on our behalf and require access to such information to do
          that work.
        </p>
        <p>The third parties we may share personal information with are as follows:</p>
        <ul>
          <li>AI Service Providers: Anthropic</li>
          <li>Invoice and Billing: Stripe</li>
          <li>Website Performance Monitoring: Sentry</li>
          <li>
            Cloud Computing Services, Database and File Storage, Email Delivery, and Website
            Analytics: Cloudflare
          </li>
          <li>Off-Site Backup Storage: Amazon Web Services</li>
          <li>Sign-In, if you choose it: Google and Apple</li>
        </ul>
        <p>We also may need to share your personal information in the following situations:</p>
        <p>
          Business Transfers. We may share or transfer your information in connection with, or
          during negotiations of, any merger, sale of company assets, financing, or acquisition of
          all or a portion of our business to another company.
        </p>
      </>
    ),
  },
  {
    id: "ai",
    title: "DO WE OFFER ARTIFICIAL INTELLIGENCE-BASED PRODUCTS?",
    body: (
      <>
        <p>
          <em>In Short:</em> We offer products, features, or tools powered by artificial
          intelligence, machine learning, or similar technologies.
        </p>
        <p>
          As part of our Services, we offer products, features, or tools powered by artificial
          intelligence, machine learning, or similar technologies (collectively, &quot;AI
          Products&quot;). These tools are designed to enhance your experience and provide you with
          innovative solutions. The terms in this Privacy Notice govern your use of the AI Products
          within our Services.
        </p>
        <h3>Use of AI Technologies</h3>
        <p>
          We provide the AI Products through third-party service providers (&quot;AI Service
          Providers&quot;), including Anthropic. As outlined in this Privacy Notice, your input,
          output, and personal information will be shared with and processed by these AI Service
          Providers to enable your use of our AI Products for purposes outlined in &quot;WHAT LEGAL
          BASES DO WE RELY ON TO PROCESS YOUR PERSONAL INFORMATION?&quot; You must not use the AI
          Products in any way that violates the terms or policies of any AI Service Provider.
        </p>
        <h3>Our AI Products</h3>
        <p>Our AI Products are designed for the following functions:</p>
        <ul>
          <li>AI document generation</li>
          <li>Natural language processing</li>
          <li>Drafting recovery and win-back emails in the merchant&apos;s brand voice</li>
          <li>Drafting dispute evidence</li>
          <li>Summarizing audit results</li>
        </ul>
        <p>
          AI-drafted dispute evidence goes to Stripe only when someone on the merchant&apos;s team
          approves it, or when the merchant has turned on auto-submit, which is off by default and
          records who turned it on and when. AI is not used to build advertising profiles.
        </p>
        <h3>How We Process Your Data Using AI</h3>
        <p>
          All personal information processed using our AI Products is handled in line with our
          Privacy Notice and our agreement with third parties. This ensures high security and
          safeguards your personal information throughout the process, giving you peace of mind
          about your data&apos;s safety.
        </p>
      </>
    ),
  },
  {
    id: "international",
    title: "IS YOUR INFORMATION TRANSFERRED INTERNATIONALLY?",
    body: (
      <>
        <p>
          <em>In Short:</em> We may transfer, store, and process your information in countries other
          than your own.
        </p>
        <p>
          Our database and its backups are stored with Cloudflare in North America. The Services run
          on Cloudflare&apos;s global network, so a request may be handled at a Cloudflare location
          near you, including outside the United States. Regardless of your location, please be
          aware that your information may be transferred to, stored by, and processed by us in our
          facilities and in the facilities of the third parties with whom we may share your personal
          information (see &quot;WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?&quot;
          above), including facilities in the United States, and other countries.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "HOW LONG DO WE KEEP YOUR INFORMATION?",
    body: (
      <>
        <p>
          <em>In Short:</em> We keep your information for as long as necessary to fulfill the
          purposes outlined in this Privacy Notice unless otherwise required by law.
        </p>
        <p>
          We will only keep your personal information for as long as it is necessary for the
          purposes set out in this Privacy Notice, unless a longer retention period is required or
          permitted by law (such as tax, accounting, or other legal requirements). In particular:
        </p>
        <ul>
          <li>
            Email opens and clicks are kept for {RETENTION_ENGAGEMENT_DAYS} days, and records of the
            emails we sent for {RETENTION_EMAIL_SENDS_DAYS} days.
          </li>
          <li>
            Stripe webhook event logs are kept for {RETENTION_WEBHOOK_EVENTS_DAYS} days, and records
            of AI calls for {RETENTION_AI_CALLS_DAYS} days.
          </li>
          <li>
            Account information is kept while the account is open. When you delete your account, we
            delete your login and your personal data, and for each account you own we remove your
            customers&apos; names and email addresses. We keep the amounts, dates, and Stripe IDs of
            the payments Foxhound recovered and the disputes it billed, because our fees are billed
            on them.
          </li>
          <li>
            Our nightly backups are kept for up to six months, so information deleted from the
            Services can remain in a backup until that backup is removed.
          </li>
        </ul>
        <p>
          When we have no ongoing legitimate business need to process your personal information, we
          will either delete or anonymize such information, or, if this is not possible (for
          example, because your personal information has been stored in backup archives), then we
          will securely store your personal information and isolate it from any further processing
          until deletion is possible.
        </p>
      </>
    ),
  },
  {
    id: "safe",
    title: "HOW DO WE KEEP YOUR INFORMATION SAFE?",
    body: (
      <>
        <p>
          <em>In Short:</em> We aim to protect your personal information through a system of
          organizational and technical security measures.
        </p>
        <p>
          We have implemented appropriate and reasonable technical and organizational security
          measures designed to protect the security of any personal information we process. However,
          despite our safeguards and efforts to secure your information, no electronic transmission
          over the Internet or information storage technology can be guaranteed to be 100% secure,
          so we cannot promise or guarantee that hackers, cybercriminals, or other unauthorized
          third parties will not be able to defeat our security and improperly collect, access,
          steal, or modify your information. Although we will do our best to protect your personal
          information, transmission of personal information to and from our Services is at your own
          risk. You should only access the Services within a secure environment.
        </p>
        <p>
          The Stripe connection carries read and write scope, because retrying a failed invoice is a
          write. Foxhound uses the write half for these things and no others: retrying payment on an
          invoice that has already failed, setting a customer&apos;s default payment method after
          that customer updates their card, opening a Stripe checkout when a former customer chooses
          to resubscribe, submitting dispute evidence once someone on your team has approved it or
          you have turned on auto-submit, and closing a dispute at Stripe when you choose to accept
          it. It never changes prices, products, or subscription plans, never charges a customer
          except by retrying a failed invoice or through a checkout they complete, and never reaches
          your payouts or bank account. Foxhound never stores card numbers, and Stripe access tokens
          are encrypted at rest with AES-256.
        </p>
      </>
    ),
  },
  {
    id: "minors",
    title: "DO WE COLLECT INFORMATION FROM MINORS?",
    body: (
      <>
        <p>
          <em>In Short:</em> We do not knowingly collect data from or market to children under 18
          years of age or the equivalent age as specified by law in your jurisdiction.
        </p>
        <p>
          We do not knowingly collect, solicit data from, or market to children under 18 years of
          age or the equivalent age as specified by law in your jurisdiction, nor do we knowingly
          sell such personal information. By using the Services, you represent that you are at least
          18 or the equivalent age as specified by law in your jurisdiction or that you are the
          parent or guardian of such a minor and consent to such minor dependent&apos;s use of the
          Services. If we learn that personal information from users less than 18 years of age or
          the equivalent age as specified by law in your jurisdiction has been collected, we will
          deactivate the account and take reasonable measures to promptly delete such data from our
          records. If you become aware of any data we may have collected from children under age 18
          or the equivalent age as specified by law in your jurisdiction, please contact us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </>
    ),
  },
  {
    id: "rights",
    title: "WHAT ARE YOUR PRIVACY RIGHTS?",
    body: (
      <>
        <p>
          <em>In Short:</em> Depending on your state of residence in the US, you have rights that
          allow you greater access to and control over your personal information. You may review,
          change, or terminate your account at any time.
        </p>
        <p>
          We will consider and act upon any request in accordance with applicable data protection
          laws.
        </p>
        <p>
          Withdrawing your consent: If we are relying on your consent to process your personal
          information, which may be express and/or implied consent depending on the applicable law,
          you have the right to withdraw your consent at any time. You can withdraw your consent at
          any time by contacting us by using the contact details provided in the section &quot;HOW
          CAN YOU CONTACT US ABOUT THIS NOTICE?&quot; below or updating your preferences.
        </p>
        <p>
          However, please note that this will not affect the lawfulness of the processing before its
          withdrawal nor, when applicable law allows, will it affect the processing of your personal
          information conducted in reliance on lawful processing grounds other than consent.
        </p>
        <p>
          Opting out of marketing and promotional communications: You can unsubscribe from our
          marketing and promotional communications at any time by clicking on the unsubscribe link
          in the emails that we send, or by contacting us using the details provided in the section
          &quot;HOW CAN YOU CONTACT US ABOUT THIS NOTICE?&quot; below. You will then be removed from
          the marketing lists. However, we may still communicate with you, for example, to send you
          service-related messages that are necessary for the administration and use of your
          account, to respond to service requests, or for other non-marketing purposes.
        </p>
        <h3>Account Information</h3>
        <p>
          If you would at any time like to review or change the information in your account or
          terminate your account, you can:
        </p>
        <ul>
          <li>Log in to your account settings and update your user account.</li>
          <li>Contact us using the contact information provided.</li>
        </ul>
        <p>
          Upon your request to terminate your account, we will deactivate or delete your account and
          information from our active databases. However, we may retain some information in our
          files to prevent fraud, troubleshoot problems, assist with any investigations, enforce our
          legal terms and/or comply with applicable legal requirements.
        </p>
        <p>
          If you have questions or comments about your privacy rights, you may email us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </>
    ),
  },
  {
    id: "dnt",
    title: "CONTROLS FOR DO-NOT-TRACK FEATURES",
    body: (
      <>
        <p>
          Most web browsers and some mobile operating systems and mobile applications include a
          Do-Not-Track (&quot;DNT&quot;) feature or setting you can activate to signal your privacy
          preference not to have data about your online browsing activities monitored and collected.
          At this stage, no uniform technology standard for recognizing and implementing DNT signals
          has been finalized. As such, we do not currently respond to DNT browser signals or any
          other mechanism that automatically communicates your choice not to be tracked online. If a
          standard for online tracking is adopted that we must follow in the future, we will inform
          you about that practice in a revised version of this Privacy Notice.
        </p>
        <p>
          California law requires us to let you know how we respond to web browser DNT signals.
          Because there currently is not an industry or legal standard for recognizing or honoring
          DNT signals, we do not respond to them at this time.
        </p>
      </>
    ),
  },
  {
    id: "us-residents",
    title: "DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS?",
    body: (
      <>
        <p>
          <em>In Short:</em> If you are a resident of California, Colorado, Connecticut, Delaware,
          Florida, Indiana, Iowa, Kentucky, Maryland, Minnesota, Montana, Nebraska, New Hampshire,
          New Jersey, Oregon, Rhode Island, Tennessee, Texas, Utah, or Virginia, you may have the
          right to request access to and receive details about the personal information we maintain
          about you and how we have processed it, correct inaccuracies, get a copy of, or delete
          your personal information. You may also have the right to withdraw your consent to our
          processing of your personal information. These rights may be limited in some circumstances
          by applicable law. More information is provided below.
        </p>
        <h3>Categories of Personal Information We Collect</h3>
        <p>
          The table below shows the categories of personal information we have collected in the past
          twelve (12) months.
        </p>
        <ul>
          <li>
            Category A: Identifiers (contact details, such as real name, alias, postal address,
            telephone or mobile contact number, unique personal identifier, online identifier,
            Internet Protocol address, email address, and account name): YES
          </li>
          <li>
            Category B: Personal information as defined in the California Customer Records statute
            (name, contact information, education, employment, employment history, and financial
            information): YES
          </li>
          <li>
            Category C: Protected classification characteristics under state or federal law (gender,
            age, date of birth, race and ethnicity, national origin, marital status, and other
            demographic data): NO
          </li>
          <li>
            Category D: Commercial information (transaction information, purchase history, financial
            details, and payment information): YES
          </li>
          <li>Category E: Biometric information (fingerprints and voiceprints): NO</li>
          <li>
            Category F: Internet or other similar network activity (browsing history, search
            history, online behavior, interest data, and interactions with our and other websites,
            applications, systems, and advertisements): YES
          </li>
          <li>Category G: Geolocation data (device location): NO</li>
          <li>
            Category H: Audio, electronic, sensory, or similar information (images and audio, video
            or call recordings created in connection with our business activities): NO
          </li>
          <li>
            Category I: Professional or employment-related information (business contact details in
            order to provide you our Services at a business level or job title, work history, and
            professional qualifications if you apply for a job with us): NO
          </li>
          <li>Category J: Education Information (student records and directory information): NO</li>
          <li>Category K: Inferences drawn from collected personal information: NO</li>
          <li>Category L: Sensitive personal Information: NO</li>
        </ul>
        <p>
          We may also collect other personal information outside of these categories through
          instances where you interact with us in person, online, or by phone or mail in the context
          of: receiving help through our customer support channels; participation in customer
          surveys or contests; and facilitation in the delivery of our Services and to respond to
          your inquiries.
        </p>
        <p>
          We will use and retain the collected personal information as needed to provide the
          Services or for:
        </p>
        <ul>
          <li>Category A - As long as the user has an account with us</li>
          <li>Category B - As long as the user has an account with us</li>
          <li>
            Category D - As long as the user has an account with us, and afterward the records our
            fees are billed on
          </li>
          <li>Category F - {RETENTION_ENGAGEMENT_DAYS} days</li>
        </ul>
        <p>
          Sources of Personal Information: Learn more about the sources of personal information we
          collect in &quot;<More to="collect">WHAT INFORMATION DO WE COLLECT?</More>&quot;
        </p>
        <p>
          How We Use and Share Personal Information: Learn more about how we use your personal
          information in the section, &quot;
          <More to="process">HOW DO WE PROCESS YOUR INFORMATION?</More>&quot;
        </p>
        <p>
          Will your information be shared with anyone else? We may disclose your personal
          information with our service providers pursuant to a written contract between us and each
          service provider. Learn more about how we disclose personal information to in the section,
          &quot;
          <More to="share">WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?</More>&quot;
        </p>
        <p>
          We may use your personal information for our own business purposes, such as for
          undertaking internal research for technological development and demonstration. This is not
          considered to be &quot;selling&quot; of your personal information.
        </p>
        <p>
          We have not sold or shared any personal information to third parties for a business or
          commercial purpose in the preceding twelve (12) months. We have disclosed the following
          categories of personal information to third parties for a business or commercial purpose
          in the preceding twelve (12) months: The categories of third parties to whom we disclosed
          personal information for a business or commercial purpose can be found under &quot;WHEN
          AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?&quot;
        </p>
        <h3>Your Rights</h3>
        <p>
          You have rights under certain US state data protection laws. However, these rights are not
          absolute, and in certain cases, we may decline your request as permitted by law. These
          rights include:
        </p>
        <ul>
          <li>Right to know whether or not we are processing your personal data</li>
          <li>Right to access your personal data</li>
          <li>Right to correct inaccuracies in your personal data</li>
          <li>Right to request the deletion of your personal data</li>
          <li>Right to obtain a copy of the personal data you previously shared with us</li>
          <li>Right to non-discrimination for exercising your rights</li>
          <li>
            Right to opt out of the processing of your personal data if it is used for targeted
            advertising (or sharing as defined under California&apos;s privacy law), the sale of
            personal data, or profiling in furtherance of decisions that produce legal or similarly
            significant effects (&quot;profiling&quot;)
          </li>
        </ul>
        <p>Depending upon the state where you live, you may also have the following rights:</p>
        <ul>
          <li>
            Right to access the categories of personal data being processed (as permitted by
            applicable law, including the privacy law in Minnesota)
          </li>
          <li>
            Right to obtain a list of the categories of third parties to which we have disclosed
            personal data (as permitted by applicable law, including the privacy law in California,
            Delaware, and Maryland)
          </li>
          <li>
            Right to obtain a list of specific third parties to which we have disclosed personal
            data (as permitted by applicable law, including the privacy law in Minnesota and Oregon)
          </li>
          <li>
            Right to obtain a list of third parties to which we have sold personal data (as
            permitted by applicable law, including the privacy law in Connecticut)
          </li>
          <li>
            Right to review, understand, question, and depending on where you live, correct how
            personal data has been profiled (as permitted by applicable law, including the privacy
            law in Connecticut and Minnesota)
          </li>
          <li>
            Right to limit use and disclosure of sensitive personal data (as permitted by applicable
            law, including the privacy law in California)
          </li>
          <li>
            Right to opt out of the collection of sensitive data and personal data collected through
            the operation of a voice or facial recognition feature (as permitted by applicable law,
            including the privacy law in Florida)
          </li>
        </ul>
        <h3>How to Exercise Your Rights</h3>
        <p>
          To exercise these rights, you can contact us by emailing us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, or by referring to the contact
          details at the bottom of this document.
        </p>
        <p>
          Under certain US state data protection laws, you can designate an authorized agent to make
          a request on your behalf. We may deny a request from an authorized agent that does not
          submit proof that they have been validly authorized to act on your behalf in accordance
          with applicable laws.
        </p>
        <h3>Request Verification</h3>
        <p>
          Upon receiving your request, we will need to verify your identity to determine you are the
          same person about whom we have the information in our system. We will only use personal
          information provided in your request to verify your identity or authority to make the
          request. However, if we cannot verify your identity from the information already
          maintained by us, we may request that you provide additional information for the purposes
          of verifying your identity and for security or fraud-prevention purposes.
        </p>
        <p>
          If you submit the request through an authorized agent, we may need to collect additional
          information to verify your identity before processing your request and the agent will need
          to provide a written and signed permission from you to submit such request on your behalf.
        </p>
        <h3>Appeals</h3>
        <p>
          Under certain US state data protection laws, if we decline to take action regarding your
          request, you may appeal our decision by emailing us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We will inform you in writing of
          any action taken or not taken in response to the appeal, including a written explanation
          of the reasons for the decisions. If your appeal is denied, you may submit a complaint to
          your state attorney general.
        </p>
        <h3>California &quot;Shine The Light&quot; Law</h3>
        <p>
          California Civil Code Section 1798.83, also known as the &quot;Shine The Light&quot; law,
          permits our users who are California residents to request and obtain from us, once a year
          and free of charge, information about categories of personal information (if any) we
          disclosed to third parties for direct marketing purposes and the names and addresses of
          all third parties with which we shared personal information in the immediately preceding
          calendar year. If you are a California resident and would like to make such a request,
          please submit your request in writing to us by using the contact details provided in the
          section &quot;HOW CAN YOU CONTACT US ABOUT THIS NOTICE?&quot;
        </p>
      </>
    ),
  },
  {
    id: "updates",
    title: "DO WE MAKE UPDATES TO THIS NOTICE?",
    body: (
      <>
        <p>
          <em>In Short:</em> Yes, we will update this notice as necessary to stay compliant with
          relevant laws.
        </p>
        <p>
          We may update this Privacy Notice from time to time. The updated version will be indicated
          by an updated &quot;Last updated&quot; date at the top of this Privacy Notice. If we make
          material changes to this Privacy Notice, we may notify you either by prominently posting a
          notice of such changes or by directly sending you a notification. We encourage you to
          review this Privacy Notice frequently to be informed of how we are protecting your
          information.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "HOW CAN YOU CONTACT US ABOUT THIS NOTICE?",
    body: (
      <>
        <p>
          If you have questions or comments about this notice, you may email us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. See also our{" "}
          <Link to="/terms">Terms of Service</Link>.
        </p>
      </>
    ),
  },
  {
    id: "review",
    title: "HOW CAN YOU REVIEW, UPDATE, OR DELETE THE DATA WE COLLECT FROM YOU?",
    body: (
      <>
        <p>
          Based on the applicable laws of your state of residence in the US, you may have the right
          to request access to the personal information we collect from you, details about how we
          have processed it, correct inaccuracies, or delete your personal information. You may also
          have the right to withdraw your consent to our processing of your personal information.
          These rights may be limited in some circumstances by applicable law. You can review,
          update, or delete your account from your account settings at any time. To request to
          review, update, or delete your personal information otherwise, please contact us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </>
    ),
  },
];

const SUMMARY_TERM = "font-medium text-text";

/** A pointer from the summary to its section, in the summary's own words. */
function More({ to, children }: { to: string; children: string }) {
  return <Link to={`#${to}`}>{children}</Link>;
}

export default function PrivacyPage() {
  return (
    <LegalBody>
      <LegalDoc
        title="Privacy Policy"
        updated="2026-11-11"
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
            <div className="my-8">
              {/* Recova's summary card: p-6, its heading a mono label inside. */}
              <section className={CARD} aria-labelledby="privacy-summary">
                <div className="cap-panel-body">
                  <h2
                    id="privacy-summary"
                    className="m-0 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary"
                  >
                    Summary of key points
                  </h2>
                  <p className="m-0 text-copy leading-relaxed text-text-secondary">
                    This summary provides key points from our Privacy Notice, but you can find out
                    more details about any of these topics by clicking the link following each key
                    point or by using our table of contents below to find the section you are
                    looking for.
                  </p>
                  <ul className="m-0 flex list-none flex-col gap-3 p-0 text-copy leading-relaxed text-text-secondary">
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
