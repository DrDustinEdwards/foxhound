// The admin's type-to-confirm form body (the brake and staged changes): the
// phrase in a Capsomer Field's label, then the submit button.

import type { ReactNode } from "react";
import { Field } from "capsomer/react/field";

export function ConfirmPhraseField({
  phrase,
  help,
  children,
}: {
  phrase: string;
  help?: ReactNode;
  /** The submit button. */
  children: ReactNode;
}) {
  return (
    <div className="cap-stack">
      <Field
        label={
          <>
            Type <span className="font-mono">{phrase}</span> to confirm
          </>
        }
        help={help}
        size="short"
      >
        <input
          name="confirm"
          type="text"
          className="cap-input font-mono"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder={phrase}
        />
      </Field>
      <div>{children}</div>
    </div>
  );
}
