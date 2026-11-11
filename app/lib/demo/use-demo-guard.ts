import { createElement, useMemo, type FormHTMLAttributes } from "react";
import { useRouteLoaderData } from "react-router";
import "capsomer/banner.css";
import "capsomer/read-only-form.css";
import { ReadOnlyForm, type FormComponent } from "capsomer/react/read-only-form";

import type { loader as appShellLoader } from "~/layouts/app-shell";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import { routerForm } from "~/lib/router-link";

// The same form, keeping the scroll position after its post (React Router's preventScrollReset),
// for a form that saves as it is changed.
const KeepScrollForm: FormComponent = (props: FormHTMLAttributes<HTMLFormElement>) =>
  createElement(routerForm, {
    ...props,
    preventScrollReset: true,
  } as FormHTMLAttributes<HTMLFormElement>);

// The props every mutating form in the app shell gives Capsomer's ReadOnlyForm, so a demo
// visitor who presses Save, Approve or any payment action stays where they are and reads why
// nothing was sent: <ReadOnlyForm {...useDemoGuard()} method="post">.
//
// It reads isDemo off the app-shell layout's own loader data (no new query) and is not the
// security boundary: a post without script, or by hand, still reaches appShellMiddleware's
// demoBlocksMethod (app/lib/auth/guards.ts), which refuses it with a 405 as before.
export function useDemoGuard({ keepScroll = false }: { keepScroll?: boolean } = {}) {
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  return {
    form: keepScroll ? KeepScrollForm : routerForm,
    readOnly: Boolean(shell?.isDemo),
    message: DEMO_READ_ONLY_MESSAGE,
  };
}

// The same guard as a form element for a part that draws its own form (InlineConfirm's
// `form`), as its doc says: "the form is the app's (form={Form}, or the read-only form for a
// demo)". Made once per read-only state, so the part's form keeps its identity across renders.
export function useDemoConfirmForm(): FormComponent {
  const { readOnly, message } = useDemoGuard();
  return useMemo<FormComponent>(
    () =>
      function DemoConfirmForm(props: FormHTMLAttributes<HTMLFormElement>) {
        return createElement(ReadOnlyForm, { ...props, form: routerForm, readOnly, message });
      },
    [readOnly, message],
  );
}
