import { More } from "~/components/legal-page";
import { RETENTION_ENGAGEMENT_DAYS } from "~/lib/constants";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import type { LegalSection } from "capsomer/react/legal-doc";

export const PRIVACY_US_RESIDENTS: LegalSection[] = [
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
          <li>
            Category G: Geolocation data (device location): YES (only the city, region, and country
            of a sign-in)
          </li>
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
          <li>
            Category K: Inferences drawn from collected personal information: YES, customer health
            scores, risk bands, and suggested next steps
          </li>
          <li>Category L: Sensitive personal Information: NO</li>
        </ul>
        <p>
          We will use and retain the collected personal information as needed to provide the
          Services or for:
        </p>
        <ul>
          <li>Categories A, B, G, and K - As long as the user has an account with us</li>
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
];
