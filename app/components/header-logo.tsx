import type { HeaderLogo } from "capsomer/react/site-header";

import { Wordmark } from "./wordmark";

/** The header's link home: the one Wordmark, in the always-dark chrome's colors. */
export function headerLogo(href = "/"): HeaderLogo {
  return {
    href,
    label: "Foxhound home",
    wordmark: (
      <span aria-hidden>
        <Wordmark tone="chrome" />
      </span>
    ),
  };
}
