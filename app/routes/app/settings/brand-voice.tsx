import { useState } from "react";
import { data, useNavigation } from "react-router";

import { Alert } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildCategoryVoicesUpdate } from "~/lib/settings/persist.server";
import { getPrimaryBrandVoices } from "~/lib/settings/queries.server";
import {
  BRAND_VOICE_PRESETS,
  CATEGORY_VOICE_ROWS,
  CUSTOM_PRESET,
  presetForStoredVoice,
  submittedVoice,
  voiceFieldName,
  type CategoryVoiceKey,
} from "~/lib/settings/brand-voice-presets";

import type { Route } from "./+types/brand-voice";

// S31, /settings/brand-voice. Legacy: brand-voice/page.tsx (blob 81435702,
// 1,308 bytes), brand-voice/BrandVoiceForm.tsx (blob 8dd126bf, 2,372 bytes),
// components/BrandVoiceSection.tsx (blob 9f4de70c, 4,362 bytes).
//
// THE ENGINE SHIPPED FIRST THIS SESSION and this is the surface that fills it:
// resolveBrandVoice now takes the decline category and reads these four
// columns, so a field here changes the voice of a real email. Ruled parity by
// 337 binding 6.
//
// LEGACY'S URL, not a card on /settings. Legacy gives this its own page and the
// general brand_voice is NOT on it: that field belongs to a different form and
// stays where Foxhound already has it. Same route precedent as S30, S33, S28
// and S29; PLATFORM_LINKS carries it until S25 ships legacy's sub-nav.
//
// FOUR FIELDS, NOT SIX. Foxhound's DECLINE_CATEGORIES has `revoked` and
// `unknown` as well, and legacy has no column for either: its resolver's
// default arm sends them to the general voice. Rendering a field for them would
// be inventing a column.
//
// NO BOUND ON ANY FIELD, which is legacy: no maxLength, no pattern, no
// required. An empty selection stores NULL and reads back as "Same as main
// voice".
//
// DIVERGENCE, class (a): legacy's write path is the shared /settings/update
// handler (row S38, unbuilt). This is the route's own action, exactly S30's
// divergence 1.

export function meta() {
  return [{ title: "Brand voice - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const voices = await getPrimaryBrandVoices(getDb(env), auth.membership.accountId);
  return {
    connectionId: voices?.id ?? null,
    stored: {
      soft: voices?.soft ?? null,
      expired: voices?.expired ?? null,
      network: voices?.network ?? null,
      fraud: voices?.fraud ?? null,
    },
  };
}

interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const form = await request.formData();

  const connectionId = String(form.get("connectionId") ?? "").trim();
  if (!connectionId) {
    return data<ActionResult>(
      { ok: false, error: "Connect Stripe before setting a brand voice." },
      { status: 400 },
    );
  }

  // FOUR NAMED FIELDS. A form posting `voice_revoked`, `brand_voice` or any
  // other column name contributes nothing: the input is built by naming each
  // key, and the writer names each column.
  const read = (key: CategoryVoiceKey): string | null => {
    const raw = String(form.get(voiceFieldName(key)) ?? "").trim();
    return raw.length > 0 ? raw : null;
  };

  await buildCategoryVoicesUpdate(db, auth.membership.accountId, connectionId, {
    soft: read("soft"),
    expired: read("expired"),
    network: read("network"),
    fraud: read("fraud"),
  });
  return data<ActionResult>({ ok: true });
}

function CategoryVoice({
  row,
  stored,
}: {
  row: (typeof CATEGORY_VOICE_ROWS)[number];
  stored: string | null;
}) {
  const initial = presetForStoredVoice(stored);
  const [preset, setPreset] = useState(initial.preset);
  const [custom, setCustom] = useState(initial.custom);

  return (
    <div className="flex flex-col gap-2.5 border-b border-border py-5 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${row.dotClass}`} />
        <span>
          <span className="block text-label font-medium text-text">{row.label}</span>
          <span className="block text-micro text-text-subtle">{row.description}</span>
        </span>
      </div>

      {/* One hidden field per category carries what actually saves: the
          textarea when Custom is chosen, the preset otherwise. Legacy's
          resolvedVoice, same shape. */}
      <input type="hidden" name={voiceFieldName(row.key)} value={submittedVoice(preset, custom)} />

      <select
        aria-label={`Brand voice preset for ${row.label}`}
        value={preset}
        onChange={(e) => setPreset(e.target.value)}
        className="rounded-md border border-border bg-surface px-3 py-2 text-label text-text focus-visible:border-amber"
      >
        <option value="">Same as main voice</option>
        {BRAND_VOICE_PRESETS.map((p) => (
          <option key={p} value={p}>
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </option>
        ))}
        <option value={CUSTOM_PRESET}>Custom...</option>
      </select>

      {preset === CUSTOM_PRESET ? (
        <textarea
          aria-label={`Custom brand voice for ${row.label}`}
          rows={2}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="e.g. warm and empathetic, like a helpful friend. Never pushy, always understanding."
          className="rounded-md border border-border bg-surface px-3 py-2 text-label text-text placeholder:text-text-subtle focus-visible:border-amber"
        />
      ) : null}
    </div>
  );
}

export default function BrandVoiceSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { connectionId, stored } = loaderData;
  const result = actionData as ActionResult | undefined;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
      <header>
        <h1 className="text-h2 text-text">Brand voice</h1>
        <p className="mt-1 text-label text-text-tertiary">
          Set a different tone for each failure category. The AI uses the matching voice when
          writing recovery emails.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-5">
        {result?.ok ? <Alert tone="success">Saved.</Alert> : null}
        {result && !result.ok && result.error ? <Alert tone="error">{result.error}</Alert> : null}

        <DemoGuardedForm method="post" className="flex flex-col gap-0">
          <input type="hidden" name="connectionId" value={connectionId ?? ""} />
          {CATEGORY_VOICE_ROWS.map((row) => (
            <CategoryVoice key={row.key} row={row} stored={stored[row.key]} />
          ))}
          <div className="pt-5">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-amber px-4 py-2 text-label font-semibold text-on-amber transition-opacity duration-500 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Saving..." : "Save"}
            </button>
          </div>
        </DemoGuardedForm>
      </section>
    </div>
  );
}
