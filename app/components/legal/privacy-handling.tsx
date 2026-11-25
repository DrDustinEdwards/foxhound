import {
  RETENTION_AI_CALLS_DAYS,
  RETENTION_EMAIL_SENDS_DAYS,
  RETENTION_ENGAGEMENT_DAYS,
  RETENTION_WEBHOOK_EVENTS_DAYS,
} from "~/lib/constants";
import { STRIPE_WRITES, STRIPE_WRITES_LIMITS } from "~/lib/marketing/trust-copy";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import type { LegalSection } from "capsomer/react/legal-doc";

export const PRIVACY_HANDLING: LegalSection[] = [
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
          write. Foxhound uses the write half for these things and no others: {STRIPE_WRITES}. It{" "}
          {STRIPE_WRITES_LIMITS}. Foxhound never stores full card numbers or security codes, and
          Stripe access tokens are encrypted at rest with AES-256.
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
          <em>In Short:</em> Foxhound is for businesses. We do not knowingly collect data from
          anyone under 18. By using the Services, you represent that you are at least 18. If we
          learn that we have collected personal information from someone under 18, we will
          deactivate the account and promptly delete the data. If you become aware of any such data,
          please contact us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
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
];
