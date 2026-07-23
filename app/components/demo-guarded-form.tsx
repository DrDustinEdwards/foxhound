import { useState, type ComponentProps } from "react";
import { Form, useRouteLoaderData } from "react-router";

import type { loader as appShellLoader } from "~/layouts/app-shell";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/session";

import { Alert } from "./auth-ui";

// TASK-foxhound-demo-inline-refusal.md: the ONE shared interception every
// mutating control in the app shell routes through, so a demo visitor who
// clicks Approve, Save, or any of the six payment manual actions stays
// exactly where they are instead of being ejected onto a bare error page.
//
// Client-side only, and deliberately NOT the security boundary: it reads
// isDemo off the app-shell layout's own loader data (useRouteLoaderData,
// zero new query - the layout already computes this on every request) and,
// when true, prevents the submit from ever leaving the browser. A visitor
// with JS disabled, or a hand-crafted POST, still reaches the server, where
// appShellMiddleware's demoBlocksMethod/throw data(...) (app/lib/auth/
// guards.ts) refuses it exactly as before - untouched by this component.
// This component only improves what happens when that guard is NOT
// bypassed: the common case of an actual visitor clicking an actual button.
export function DemoGuardedForm({ children, onSubmit, ...formProps }: ComponentProps<typeof Form>) {
  const shell = useRouteLoaderData<typeof appShellLoader>("app-shell");
  const isDemo = Boolean(shell?.isDemo);
  const [refused, setRefused] = useState(false);

  return (
    <Form
      {...formProps}
      onSubmit={(event) => {
        if (isDemo) {
          event.preventDefault();
          setRefused(true);
          return;
        }
        onSubmit?.(event);
      }}
    >
      {children}
      {refused ? <Alert tone="neutral">{DEMO_READ_ONLY_MESSAGE}</Alert> : null}
    </Form>
  );
}
