import { useNavigation } from "react-router";

import { Alert, Submit } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";

// The settings section's house card, extracted from the old /settings index
// when session 59 split that page into legacy's hub plus sub-pages (336
// binding 2). Every sub-page that posts to its own route action uses it, so the
// save affordance and the saved/error treatment stay identical across them.

export type ActionResult = {
  action: string;
  ok: boolean;
  error?: string;
  warning?: string;
};

export function SettingsCard({
  title,
  description,
  action,
  result,
  submittable = true,
  children,
}: {
  title: string;
  description?: string;
  action: string;
  result?: ActionResult;
  submittable?: boolean;
  children: React.ReactNode;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <h2 className="text-label font-semibold text-text">{title}</h2>
      {description ? (
        <p className="mt-1 text-label text-text-tertiary">{description}</p>
      ) : null}
      {submittable ? (
        <DemoGuardedForm method="post" className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="_action" value={action} />
          {result?.action === action && result.ok ? (
            <Alert tone="success">Saved.</Alert>
          ) : null}
          {result?.action === action && !result.ok && result.error ? (
            <Alert tone="error">{result.error}</Alert>
          ) : null}
          {children}
          <div>
            <Submit disabled={busy}>{busy ? "Saving..." : "Save"}</Submit>
          </div>
        </DemoGuardedForm>
      ) : (
        <div className="mt-4 flex flex-col gap-3">{children}</div>
      )}
    </section>
  );
}
