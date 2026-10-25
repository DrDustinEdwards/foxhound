import type { HeaderLogo } from "capsomer/react/site-header";

/** The wordmark: `fo x hound` in DM Mono, the x in amber. Its
 *  look is app.css (.fh-wordmark), so this module carries no CSS of its own. */
export function headerLogo(href = "/"): HeaderLogo {
  return {
    href,
    label: "Foxhound home",
    wordmark: (
      <span className="fh-wordmark" aria-hidden>
        fo<span className="fh-wordmark-x">x</span>hound
      </span>
    ),
  };
}
