import { Link } from "capsomer/react/link";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import type { LegalSection } from "capsomer/react/legal-doc";

export const PRIVACY_CLOSING: LegalSection[] = [
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
