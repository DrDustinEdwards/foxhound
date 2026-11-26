import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import {
  DISPUTE_FEE_CAP_CENTS,
  INVOICE_DAYS_UNTIL_DUE,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import type { LegalSection } from "capsomer/react/legal-doc";

export const TERMS_USE: LegalSection[] = [
  {
    id: "services",
    title: "OUR SERVICES",
    body: (
      <>
        <p>
          The information provided when using the Services is not intended for distribution to or
          use by any person or entity in any jurisdiction or country where such distribution or use
          would be contrary to law or regulation or which would subject us to any registration
          requirement within such jurisdiction or country. Accordingly, those persons who choose to
          access the Services from other locations do so on their own initiative and are solely
          responsible for compliance with local laws, if and to the extent local laws are
          applicable.
        </p>
        <p>
          The Services are not tailored to comply with industry-specific regulations (Health
          Insurance Portability and Accountability Act (HIPAA), Federal Information Security
          Management Act (FISMA), etc.), so if your interactions would be subjected to such laws,
          you may not use the Services. You may not use the Services in a way that would violate the
          Gramm-Leach-Bliley Act (GLBA).
        </p>
      </>
    ),
  },
  {
    id: "ip",
    title: "INTELLECTUAL PROPERTY RIGHTS",
    body: (
      <>
        <h3>Our intellectual property</h3>
        <p>
          We are the owner or the licensee of all intellectual property rights in our Services,
          including all source code, databases, functionality, software, website designs, audio,
          video, text, photographs, and graphics in the Services (collectively, the
          &quot;Content&quot;), as well as the trademarks, service marks, and logos contained
          therein (the &quot;Marks&quot;).
        </p>
        <p>
          Our Content and Marks are protected by copyright and trademark laws (and various other
          intellectual property rights and unfair competition laws) and treaties in the United
          States and around the world.
        </p>
        <p>
          The Content and Marks are provided in or through the Services &quot;AS IS&quot; for your
          internal business purpose only.
        </p>
        <h3>Your use of our Services</h3>
        <p>
          Subject to your compliance with these Legal Terms, including the &quot;PROHIBITED
          ACTIVITIES&quot; section below, we grant you a non-exclusive, non-transferable, revocable
          license to access the Services and download or print a copy of any portion of the Content
          to which you have properly gained access, solely for your internal business purpose.
        </p>
        <p>
          Except as set out in this section or elsewhere in our Legal Terms, no part of the Services
          and no Content or Marks may be copied, reproduced, aggregated, republished, uploaded,
          posted, publicly displayed, encoded, translated, transmitted, distributed, sold, licensed,
          or otherwise exploited for any commercial purpose whatsoever, without our express prior
          written permission.
        </p>
        <p>
          If you wish to make any use of the Services, Content, or Marks other than as set out in
          this section or elsewhere in our Legal Terms, please address your request to:{" "}
          {SUPPORT_EMAIL}. If we ever grant you the permission to post, reproduce, or publicly
          display any part of our Services or Content, you must identify us as the owners or
          licensors of the Services, Content, or Marks and ensure that any copyright or proprietary
          notice appears or is visible on posting, reproducing, or displaying our Content.
        </p>
        <p>
          We reserve all rights not expressly granted to you in and to the Services, Content, and
          Marks.
        </p>
        <p>
          Any breach of these Intellectual Property Rights will constitute a material breach of our
          Legal Terms and your right to use our Services will terminate immediately.
        </p>
        <h3>Your submissions</h3>
        <p>
          Submissions: By directly sending us any question, comment, suggestion, idea, feedback, or
          other information about the Services (&quot;Submissions&quot;), you agree to assign to us
          all intellectual property rights in such Submission. You agree that we shall own this
          Submission and be entitled to its unrestricted use and dissemination for any lawful
          purpose, commercial or otherwise, without acknowledgment or compensation to you.
        </p>
        <p>
          You are responsible for what you post or upload: By sending us Submissions through any
          part of the Services you: (a) confirm that you have read and agree with our PROHIBITED
          ACTIVITIES and will not post, send, publish, upload, or transmit through the Services any
          Submission that is illegal, harassing, hateful, harmful, defamatory, obscene, bullying,
          abusive, discriminatory, threatening to any person or group, sexually explicit, false,
          inaccurate, deceitful, or misleading; (b) to the extent permissible by applicable law,
          waive any and all moral rights to any such Submission; (c) warrant that any such
          Submission is original to you or that you have the necessary rights and licenses to submit
          such Submissions; and (d) warrant and represent that your Submissions do not constitute
          confidential information.
        </p>
        <p>
          You are solely responsible for your Submissions and you expressly agree to reimburse us
          for any and all losses that we may suffer because of your breach of (a) this section, (b)
          any third party&apos;s intellectual property rights, or (c) applicable law.
        </p>
      </>
    ),
  },
  {
    id: "user-representations",
    title: "USER REPRESENTATIONS",
    body: (
      <>
        <p>
          By using the Services, you represent and warrant that: (1) all registration information
          you submit will be true, accurate, current, and complete; (2) you will maintain the
          accuracy of such information and promptly update such registration information as
          necessary; (3) you have the legal capacity and you agree to comply with these Legal Terms;
          (4) you are not a minor in the jurisdiction in which you reside; (5) you will not access
          the Services through automated or non-human means, whether through a bot, script or
          otherwise, except through the Foxhound MCP endpoint with an API key issued to your
          account, as the API terms below set out; (6) you will not use the Services for any illegal
          or unauthorized purpose; and (7) your use of the Services will not violate any applicable
          law or regulation.
        </p>
        <p>
          If you provide any information that is untrue, inaccurate, not current, or incomplete, we
          have the right to suspend or terminate your account and refuse any and all current or
          future use of the Services (or any portion thereof).
        </p>
        <h3>API terms</h3>
        <p>
          Foxhound publishes a Model Context Protocol endpoint so that an AI agent you choose can
          read and manage your own account on your behalf. Access requires an API key you generate
          inside your account. Keys are scoped to the single account that issued them, they can be
          revoked at any time from the same page, and rate limits apply.
        </p>
        <p>
          Some actions are never available to an API key, whatever the key or the agent: submitting
          dispute evidence, connecting a Stripe account, disconnecting a Stripe account, and
          anything that records an outcome or bills. Those require a signed-in person, and the
          endpoint exposes no tool for them.
        </p>
        <p>
          You are responsible for everything done under your keys, including actions taken by an
          agent you have given a key to, exactly as you are responsible for actions taken by a
          person you have given access to. Revoke a key you no longer control.
        </p>
      </>
    ),
  },
  {
    id: "registration",
    title: "USER REGISTRATION",
    body: (
      <>
        <p>
          You may be required to register to use the Services. You agree to keep the ways you sign
          in (your email inbox, your passkeys, and any Google or Apple account you sign in with)
          secure, and will be responsible for all use of your account.
        </p>
      </>
    ),
  },
  {
    id: "purchases",
    title: "PURCHASES AND PAYMENT",
    body: (
      <>
        <p>We accept the following forms of payment:</p>
        <ul>
          <li>Visa</li>
          <li>Mastercard</li>
          <li>American Express</li>
          <li>Discover</li>
        </ul>
        <p>
          You agree to provide current, complete, and accurate purchase and account information for
          all purchases made via the Services. You further agree to promptly update account and
          payment information, including email address, payment method, and payment card expiration
          date, so that we can complete your transactions and contact you as needed. Sales tax will
          be added to the price of purchases as deemed required by us. Each invoice is in the
          currency of the payments and disputes it bills, so results in more than one currency are
          invoiced separately, one invoice per currency.
        </p>
        <p>
          You agree to pay all charges at the prices then in effect. If you have a payment method on
          file, you authorize us to charge it for each invoice at the monthly billing run. If you do
          not, we email you the invoice and it is due within {INVOICE_DAYS_UNTIL_DUE} days. We
          reserve the right to correct any errors or mistakes in pricing, even if we have already
          requested or received payment.
        </p>
        <p>We reserve the right to refuse any order placed through the Services.</p>
      </>
    ),
  },
  {
    id: "subscriptions",
    title: "FEES, CREDITS AND CANCELLATION",
    body: (
      <>
        <h3>Fees</h3>
        <p>
          Recovery and Disputes are billed as a percentage of outcomes: {RECOVERY_FEE_PERCENT}% of
          payments recovered by Foxhound, and {DISPUTE_FEE_PERCENT}% of disputes won by Foxhound,
          invoiced at the start of the following month. A payment counts as recovered by Foxhound
          only when a Foxhound retry, a click in a Foxhound email, or a card update through a
          Foxhound link came before it; recoveries Stripe&apos;s own tools would have produced are
          shown to you for free and never billed. A recovery is billed only once you have held the
          money for {RECOVERY_MATURITY_DAYS} days. A dispute is billed only when Foxhound drafted
          and submitted its evidence, and the fee on one dispute is capped at{" "}
          {formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")}, converted at Stripe&apos;s rate on the
          day the dispute resolves. Intelligence and Audit are free with no billing. You will be
          charged only for results that became billable in the prior billing period. There is no
          subscription and no fixed charge: a month with no billable result has no invoice.
        </p>
        <h3>Credits</h3>
        <p>
          If a payment we charged a recovery fee on is later refunded or charged back, we credit
          that fee in full, or the refunded share of it for a partial refund. If a dispute we
          charged a fee on is later reversed against you, we credit that fee. Credits are issued
          against the invoice that carried the fee. Apart from these credits, fees are
          non-refundable.
        </p>
        <h3>Cancellation</h3>
        <p>
          You can stop at any time by disconnecting your Stripe account in Settings, or by canceling
          your account in Settings and My account. Either takes effect immediately. Fees on results
          earned before you stopped still invoice once they become billable. If you have any
          questions or are unsatisfied with our Services, please email us at {SUPPORT_EMAIL}.
        </p>
        <h3>Fee Changes</h3>
        <p>
          We may, from time to time, make changes to our fees and will communicate any fee changes
          to you in accordance with applicable law.
        </p>
      </>
    ),
  },
  {
    id: "prohibited",
    title: "PROHIBITED ACTIVITIES",
    body: (
      <>
        <p>
          You may not access or use the Services for any purpose other than that for which we make
          the Services available. As a user of the Services, you agree not to:
        </p>
        <ul>
          <li>
            Systematically retrieve data or other content from the Services to create or compile,
            directly or indirectly, a collection, compilation, database, or directory without
            written permission from us.
          </li>
          <li>
            Trick, defraud, or mislead us and other users, especially in any attempt to learn
            sensitive account information such as user passwords.
          </li>
          <li>
            Circumvent, disable, or otherwise interfere with security-related features of the
            Services.
          </li>
          <li>Disparage, tarnish, or otherwise harm, in our opinion, us and/or the Services.</li>
          <li>
            Use any information obtained from the Services in order to harass, abuse, or harm
            another person.
          </li>
          <li>
            Make improper use of our support services or submit false reports of abuse or
            misconduct.
          </li>
          <li>
            Use the Services in a manner inconsistent with any applicable laws or regulations.
          </li>
          <li>Engage in unauthorized framing of or linking to the Services.</li>
          <li>
            Upload or transmit (or attempt to upload or to transmit) viruses, Trojan horses, or
            other material that interferes with any party&apos;s uninterrupted use and enjoyment of
            the Services.
          </li>
          <li>
            Engage in any automated use of the system, such as using scripts to send comments or
            messages, or using any data mining, robots, or similar data gathering and extraction
            tools, other than the Foxhound MCP endpoint used with an API key issued to your account.
          </li>
          <li>Delete the copyright or other proprietary rights notice from any Content.</li>
          <li>Attempt to impersonate another user or person.</li>
          <li>
            Interfere with, disrupt, or create an undue burden on the Services or the networks or
            services connected to the Services.
          </li>
          <li>
            Harass, annoy, intimidate, or threaten any of our employees or agents engaged in
            providing any portion of the Services to you.
          </li>
          <li>
            Attempt to bypass any measures of the Services designed to prevent or restrict access to
            the Services.
          </li>
          <li>
            Copy or adapt the Services&apos; software, including its HTML, JavaScript, or other
            code.
          </li>
          <li>Use the Services as part of any effort to compete with us.</li>
        </ul>
      </>
    ),
  },
];
