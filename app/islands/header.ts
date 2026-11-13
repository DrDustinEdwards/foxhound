import { enhance as enhanceHeader } from "capsomer/behavior/site-header";
import { enhance as enhanceTheme } from "capsomer/behavior/theme-switch";

// An island (devkit ./islands): the site header (components/header.tsx) on a page that does not hydrate.
// Capsomer's SiteHeader wrote it with hydrate={false}, so its behavior modules wire the same markup here:
// the phone's menu sheet, any panel, each icon's tip, and the theme button, which carries its browser key
// and Foxhound's cookie (data-cap-pref, data-cap-cookie). Only a signed-out visitor sees such a page, so
// there is no account to save to.
export default function start(): void {
  enhanceTheme(document);
  enhanceHeader(document);
}
