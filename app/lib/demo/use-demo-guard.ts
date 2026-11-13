import { createElement, useMemo, type ComponentProps } from "react";
import { Form, useRouteLoaderData } from "react-router";
import "capsomer/banner.css";
import "capsomer/read-only-form.css";
import { ReadOnlyForm, type FormComponent } from "capsomer/react/read-only-form";

import type { loader as appShellLoader } from "~/layouts/app-shell";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";

// The same form, keeping the scroll position after its post (React Router's preventScrollReset),
// for a form that saves as it is changed.
const KeepScrollForm: FormComponent = (props) =>
  createElement(Form, { ...props, preventScrollReset: true });

// The props every mutating form in the app shell gives Capsomer's ReadOnlyForm, so a demo
// visitor who presses Save, Approve or any payment action stays where they are and reads why
// nothing was sent. Pages use DemoForm (below); a part that draws its own form uses these props.
//
// It reads isDemo off the app-shell layout's own loader data (no new query) and is not the
// security boundary: a post without script, or by hand, still reaches appShellMiddleware's
// demoBlocksMethod (app/lib/auth/guards.ts), which refuses it with a 405 as before.
export function useDemoGuard({ keepScroll = false }: { keepScroll?: boolean } = {}) {
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  return {
    form: keepScroll ? KeepScrollForm : Form,
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
      function DemoConfirmForm(props: ComponentProps<FormComponent>) {
        return createElement(ReadOnlyForm, { ...props, form: Form, readOnly, message });
      },
    [readOnly, message],
  );
}

// A mutating form in the app shell, read-only for a demo visitor: <DemoForm method="post">.
// `keepScroll` keeps the scroll position after its post, for a form that saves as it is changed.
export function DemoForm({
  keepScroll,
  ...props
}: Omit<ComponentProps<typeof ReadOnlyForm>, "form" | "readOnly" | "message"> & {
  keepScroll?: boolean;
}) {
  return createElement(ReadOnlyForm, { ...useDemoGuard({ keepScroll }), ...props });
}
