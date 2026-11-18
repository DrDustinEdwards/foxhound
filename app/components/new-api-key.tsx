import { CopyButton } from "capsomer/react/copy";
import { ButtonLink } from "capsomer/react/link";
import { SecretReveal } from "capsomer/react/secret-reveal";
import "capsomer/copy.css";
import "capsomer/secret-reveal.css";

/** The new key, shown once, in Capsomer's SecretReveal inside the card it
 *  always had, with Capsomer's CopyButton beside the Done link. */
export function NewApiKey({ rawKey }: { rawKey: string }) {
  return (
    <section className="cap-panel">
      <div className="cap-panel-body">
        <SecretReveal
          title="Your new API key"
          secret={rawKey}
          note="This key will not be shown again. Copy it now and store it somewhere safe."
          copy={
            <div className="cap-cluster" data-gap="4">
              <CopyButton text={rawKey} variant="default">
                Copy key
              </CopyButton>
              <ButtonLink to="?" variant="quiet">
                Done
              </ButtonLink>
            </div>
          }
        />
      </div>
    </section>
  );
}
