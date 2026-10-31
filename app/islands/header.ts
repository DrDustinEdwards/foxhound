import { enhance as enhanceHeader } from "capsomer/behavior/site-header";
import { enhance as enhanceTheme } from "capsomer/behavior/theme-switch";

import type { Theme } from "../lib/theme";
import { rememberServerTheme, type ThemeSave, watchThemeChoice } from "../lib/theme-memory";

// An island (devkit ./islands): the site header (components/header.tsx) on a page that does not hydrate.
// The server drew the header with Capsomer's React SiteHeader, which marks its parts data-cap-ready
// because React wires them; here Capsomer's behavior modules wire the same markup instead: the phone's
// menu sheet, any panel, each icon's tip, and the theme button. The theme is kept as useThemeMemory keeps
// it: the button's browser memory set to the server's answer first, every switch saved to the cookie
// (or, signed in, the account).
export default function start(el: HTMLElement, props: { theme: Theme; save: ThemeSave; prefKey: string }): void {
  rememberServerTheme(props.theme, props.prefKey);
  const header = el.querySelector<HTMLElement>("[data-cap='site-header']");
  const button = el.querySelector<HTMLElement>("[data-cap='theme-switch']");
  if (button) {
    // The React button carries its memory's key as a prop; the behavior module reads it from here.
    button.dataset.capPref = props.prefKey;
    delete button.dataset.capReady;
    enhanceTheme(document);
  }
  if (header) {
    delete header.dataset.capReady;
    enhanceHeader(document);
  }
  watchThemeChoice({ current: props.theme }, props.save);
}
