import { AwayLink } from "capsomer/react/link";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { SUBPROCESSORS } from "~/lib/marketing/trust-copy";
import type { LegalSection } from "capsomer/react/legal-doc";

export const PRIVACY_COLLECTION: LegalSection[] = [
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
        <p>
          Payment Data. You enter your card number and security code on Stripe. For a card we watch
          for a merchant, we keep the brand, last four digits and expiry month and year. You may
          find their privacy notice link(s) here:{" "}
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
          referring URLs, device name, rough location, information about how and when you use our
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
            device and application identification numbers, browser type, hardware model, Internet
            service provider and/or mobile carrier, operating system, and system configuration
            information. When you sign in, we keep the city, region, and country Cloudflare matches
            to your IP address, for the session list in your account settings. We do not collect
            precise location, such as GPS.
          </li>
          <li>
            Cookies and Analytics. The fh_theme cookie remembers your light or dark setting, and
            session cookies keep you signed in. Public pages load Cloudflare Web Analytics.
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
          details Stripe holds on the disputed charge, such as a billing address and the
          customer&apos;s IP address at purchase. From this billing history and from email opens, we
          work out a health score from 0 to 100 for each customer (below{" "}
          {HEALTH_SCORE_AT_RISK_THRESHOLD} is at risk), a risk band, and a recommended next step for
          the merchant. Fixed rules make these, not AI. We process this information on the
          merchant&apos;s behalf and on the merchant&apos;s instructions. If you are a customer of a
          merchant that uses Foxhound, the merchant&apos;s own privacy notice explains how it uses
          your information. We do not buy information about you from data brokers, marketing
          partners, or other third parties.
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
          {SUBPROCESSORS.map(({ role, name }) => (
            <li key={name}>
              {role}: {name}
            </li>
          ))}
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
          Products&quot;). The terms in this Privacy Notice govern your use of the AI Products
          within our Services.
        </p>
        <h3>Use of AI Technologies</h3>
        <p>
          We provide the AI Products through third-party service providers (&quot;AI Service
          Providers&quot;), including Anthropic. As outlined in this Privacy Notice, your input,
          output, and personal information will be shared with and processed by these AI Service
          Providers to enable your use of our AI Products. You must not use the AI Products in any
          way that violates the terms or policies of any AI Service Provider.
        </p>
        <h3>Our AI Products</h3>
        <p>Our AI Products are designed for the following functions:</p>
        <ul>
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
          Privacy Notice and our agreement with third parties.
        </p>
      </>
    ),
  },
];
