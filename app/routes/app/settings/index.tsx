import { and, eq, isNull } from "drizzle-orm";
import { data, Form, useNavigation } from "react-router";

import { Alert, Field, Submit } from "~/components/auth-ui";
import { accounts, getDb, stripeConnections } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatCentsAsDollars, parseDollarsToCents } from "~/lib/settings/dollars";
import {
  buildAccountProfileUpdate,
  buildBrandVoiceUpdate,
  buildEmailSettingsUpdate,
  buildIntelligenceContextUpdate,
  buildNotificationSettingsUpdate,
} from "~/lib/settings/persist.server";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Settings - Foxhound" }];
}

async function loadConnection(env: Env, accountId: string) {
  const db = getDb(env);
  const rows = await db
    .select({ id: stripeConnections.id, brandVoice: stripeConnections.brandVoice })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt)))
    .orderBy(stripeConnections.connectedAt)
    .limit(1);
  return rows[0] ?? null;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);

  const [accountRows, connection] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
    loadConnection(env, accountId),
  ]);
  const account = accountRows[0];
  if (!account) throw new Response("Not Found", { status: 404 });

  return { account, connection };
}

type ActionResult = { action: string; ok: boolean; error?: string };

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  const str = (name: string) => {
    const v = form.get(name);
    const trimmed = typeof v === "string" ? v.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const bool = (name: string) => form.get(name) === "on";

  switch (intent) {
    case "profile": {
      const name = str("name");
      if (!name) {
        return data({ action: intent, ok: false, error: "Account name is required." }, { status: 400 });
      }
      await buildAccountProfileUpdate(db, accountId, { name });
      return data({ action: intent, ok: true });
    }
    case "email": {
      await buildEmailSettingsUpdate(db, accountId, {
        notificationEmail: str("notificationEmail"),
        digestEmail: str("digestEmail"),
      });
      return data({ action: intent, ok: true });
    }
    case "notifications": {
      await buildNotificationSettingsUpdate(db, accountId, {
        digestEnabled: bool("digestEnabled"),
        slackNotificationsEnabled: bool("slackNotificationsEnabled"),
        slackWebhookUrl: str("slackWebhookUrl"),
        recoveryNotificationsEnabled: bool("recoveryNotificationsEnabled"),
        sequenceCompleteNotificationsEnabled: bool("sequenceCompleteNotificationsEnabled"),
        winbackNotificationsEnabled: bool("winbackNotificationsEnabled"),
        expiringCardNotificationsEnabled: bool("expiringCardNotificationsEnabled"),
      });
      return data({ action: intent, ok: true });
    }
    case "intelligence-context": {
      await buildIntelligenceContextUpdate(db, accountId, {
        merchantIndustry: str("merchantIndustry"),
        primaryCustomerType: str("primaryCustomerType"),
        merchantMrrSelfReportedCents: parseDollarsToCents(String(form.get("merchantMrrSelfReported") ?? "")),
      });
      return data({ action: intent, ok: true });
    }
    case "brand-voice": {
      const connectionId = String(form.get("connectionId") ?? "");
      if (!connectionId) {
        return data(
          { action: intent, ok: false, error: "Connect Stripe before setting a brand voice." },
          { status: 400 },
        );
      }
      await buildBrandVoiceUpdate(db, connectionId, str("brandVoice"));
      return data({ action: intent, ok: true });
    }
    default:
      return data({ action: intent, ok: false, error: "Unknown settings action." }, { status: 400 });
  }
}

function SettingsCard({
  title,
  description,
  action,
  result,
  children,
}: {
  title: string;
  description?: string;
  action: string;
  result?: ActionResult;
  children: React.ReactNode;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <h2 className="text-label font-semibold text-text">{title}</h2>
      {description ? (
        <p className="mt-1 text-label text-text-tertiary">{description}</p>
      ) : null}
      <Form method="post" className="mt-4 flex flex-col gap-3">
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
      </Form>
    </section>
  );
}

function Checkbox({ label, name, defaultChecked }: { label: string; name: string; defaultChecked: boolean }) {
  return (
    <label className="flex items-center gap-2 text-label text-text">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-border accent-amber"
      />
      {label}
    </label>
  );
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { account, connection } = loaderData;
  const result = actionData as ActionResult | undefined;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <h1 className="text-title font-medium text-text">Settings</h1>

      <SettingsCard title="Account" action="profile" result={result}>
        <Field label="Account name" name="name" required defaultValue={account.name ?? ""} />
      </SettingsCard>

      <SettingsCard
        title="Brand voice"
        description="Dunning emails are written in this voice, not Foxhound's. Leave blank for a neutral default tone."
        action="brand-voice"
        result={result}
      >
        <input type="hidden" name="connectionId" value={connection?.id ?? ""} />
        {connection ? (
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
              Voice description
            </span>
            <textarea
              name="brandVoice"
              rows={3}
              defaultValue={connection.brandVoice ?? ""}
              placeholder="Warm, plain, and direct; a real person from the business writing a short note"
              className="rounded-md border border-border bg-surface px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-amber"
            />
          </label>
        ) : (
          <p className="text-label text-text-tertiary">
            Connect Stripe before setting a brand voice.
          </p>
        )}
      </SettingsCard>

      <SettingsCard
        title="Email"
        description="Where Foxhound sends account notifications and the weekly digest."
        action="email"
        result={result}
      >
        <Field
          label="Notification email"
          name="notificationEmail"
          type="email"
          required={false}
          defaultValue={account.notificationEmail ?? ""}
        />
        <Field
          label="Digest email"
          name="digestEmail"
          type="email"
          required={false}
          defaultValue={account.digestEmail ?? ""}
        />
      </SettingsCard>

      <SettingsCard title="Notifications" action="notifications" result={result}>
        <Checkbox
          label="Weekly digest"
          name="digestEnabled"
          defaultChecked={Boolean(account.digestEnabled)}
        />
        <Checkbox
          label="Recovery notifications"
          name="recoveryNotificationsEnabled"
          defaultChecked={Boolean(account.recoveryNotificationsEnabled)}
        />
        <Checkbox
          label="Sequence complete notifications"
          name="sequenceCompleteNotificationsEnabled"
          defaultChecked={Boolean(account.sequenceCompleteNotificationsEnabled)}
        />
        <Checkbox
          label="Win-back notifications"
          name="winbackNotificationsEnabled"
          defaultChecked={Boolean(account.winbackNotificationsEnabled)}
        />
        <Checkbox
          label="Expiring card notifications"
          name="expiringCardNotificationsEnabled"
          defaultChecked={Boolean(account.expiringCardNotificationsEnabled)}
        />
        <Checkbox
          label="Slack notifications"
          name="slackNotificationsEnabled"
          defaultChecked={Boolean(account.slackNotificationsEnabled)}
        />
        <Field
          label="Slack webhook URL"
          name="slackWebhookUrl"
          required={false}
          defaultValue={account.slackWebhookUrl ?? ""}
        />
      </SettingsCard>

      <SettingsCard
        title="Intelligence context"
        description="Optional. These help score risk more accurately once Intelligence scoring is available; they do not change anything today."
        action="intelligence-context"
        result={result}
      >
        <Field
          label="Industry"
          name="merchantIndustry"
          required={false}
          defaultValue={account.merchantIndustry ?? ""}
        />
        <Field
          label="Primary customer type"
          name="primaryCustomerType"
          required={false}
          defaultValue={account.primaryCustomerType ?? ""}
        />
        <Field
          label="Self-reported monthly recurring revenue (USD)"
          name="merchantMrrSelfReported"
          required={false}
          defaultValue={formatCentsAsDollars(account.merchantMrrSelfReported)}
        />
      </SettingsCard>
    </div>
  );
}
