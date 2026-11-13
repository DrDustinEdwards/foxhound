import type { ComponentProps } from "react";
import { SettingsLayout } from "capsomer/react/settings-row";
import { routerLink } from "~/lib/router-link";

// A settings page: Capsomer's SettingsLayout (the page head, and the phone's link back to the
// settings list) with its links drawn by the router. The CSS every settings page reads is loaded
// once by the settings layout (app/layouts/settings.tsx).
export function SettingsPage(props: Omit<ComponentProps<typeof SettingsLayout>, "renderLink">) {
  return <SettingsLayout renderLink={routerLink} {...props} />;
}
