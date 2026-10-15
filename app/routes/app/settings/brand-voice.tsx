import { useId, useState } from "react";
import { data, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { Select } from "capsomer/react/select";
import { Status } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/select.css";
import "capsomer/status.css";
// Capsomer's tokens and the teal family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/features does.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { applyBrandVoice } from "~/lib/settings/apply.server";
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

// S31, /settings/brand-voice.
//
// LEGACY IS THE SPEC, read whole:
//   settings/brand-voice/page.tsx            blob 81435702  1,308 bytes
//   settings/brand-voice/BrandVoiceForm.tsx  blob 8dd126bf  2,372 bytes
//   settings/components/BrandVoiceSection.tsx blob 9f4de70c 4,362 bytes
//   settings/SaveBar.tsx                     blob f1d6eb23    830 bytes
//
// J36 (job_36eb888192d0) rebuilt the page from Capsomer 0.9.0's parts under
// Dustin's Q10 and Q11 answers of 2026-10-14: PageHead, a Panel's card,
// Select, a cap-input textarea, Button and Status, teal throughout. Recova
// stays the spec for what is here and in what order: the phone-only back
// link, the title and its line, one card that opens with its own line and
// holds the four categories (dot, label and help, then the preset picker, then
// the custom box when Custom is chosen), then SaveBar's right-aligned "Save
// changes" with "Saved" or "Failed to save. Please try again." beside it.
//
// FOUR FIELDS AND NO GENERAL ONE. Recova's page posts the four category hidden
// inputs and connection_id, nothing else (BrandVoiceSection.tsx lines 63 to
// 66), so its update route leaves `brand_voice` alone on this save. Session 59
// added a general voice box here on a misreading of that file; J36 took it out
// under RULES.md 1.2 and 1.3 (a control Recova never had is an addition). The
// action therefore never names `general`, and applyBrandVoice leaves an absent
// key as it is.
//
// Foxhound's DECLINE_CATEGORIES has `revoked` and `unknown` as well, and legacy
// has no column for either: its resolver's default arm sends them to the
// general voice. Rendering a field for them would be inventing a column.
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
  /** The apply layer's own refusal, when it refused rather than threw. */
  error?: string;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const form = await request.formData();

  // FOUR NAMED FIELDS, read here and validated nowhere here. A form posting
  // `voice_revoked`, `brandVoice` or any other column name contributes
  // nothing: the input is built by naming each key, and `applyBrandVoice`
  // names each column. `general` is never named, so the main voice is left as
  // it is, which is what Recova's update route does with this form's post.
  const read = (key: CategoryVoiceKey): string => String(form.get(voiceFieldName(key)) ?? "");

  // A refusal (no connection, or one on another account) says its own
  // sentence: Recova said "Saved" when it matched no connection, which was not
  // true. A write that throws says Recova's SaveBar line on this page instead
  // of an error page.
  let result: Awaited<ReturnType<typeof applyBrandVoice>>;
  try {
    result = await applyBrandVoice(getDb(env), auth.membership.accountId, {
      connectionId: form.get("connectionId"),
      soft: read("soft"),
      expired: read("expired"),
      network: read("network"),
      fraud: read("fraud"),
    });
  } catch (err) {
    console.error("brand voice write failed:", err);
    return data<ActionResult>({ ok: false }, { status: 500 });
  }
  if (!result.ok) {
    return data<ActionResult>({ ok: false, error: result.error }, { status: 400 });
  }
  return data<ActionResult>({ ok: true });
}

const PRESET_OPTIONS = [
  { value: "", label: "Same as main voice" },
  ...BRAND_VOICE_PRESETS.map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) })),
  { value: CUSTOM_PRESET, label: "Custom..." },
];

/** One of BrandVoiceSection's four rows: the dot with the label and its help,
 *  the preset picker, and the custom box when Custom is chosen. The picker is
 *  Capsomer's Select, named with Recova's aria-label and described by the help
 *  line; the box is a cap-input textarea with Recova's aria-label. */
function CategoryVoice({
  row,
  stored,
  first,
}: {
  row: (typeof CATEGORY_VOICE_ROWS)[number];
  stored: string | null;
  first: boolean;
}) {
  const initial = presetForStoredVoice(stored);
  const [preset, setPreset] = useState(initial.preset);
  const [custom, setCustom] = useState(initial.custom);
  const helpId = `${useId()}-help`;

  return (
    <div className={first ? "pb-5" : "border-t border-border-sub py-5 last:pb-0"}>
      <div className="mb-2.5 flex items-center gap-2">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${row.dotClass}`}></span>
        <div>
          <div className="text-label font-medium text-text">{row.label}</div>
          <div id={helpId} className="mt-px text-micro text-text-subtle">
            {row.description}
          </div>
        </div>
      </div>

      {/* One hidden field per category carries what actually saves: the
          textarea when Custom is chosen, the preset otherwise. Legacy's
          resolvedVoice, same shape. */}
      <input type="hidden" name={voiceFieldName(row.key)} value={submittedVoice(preset, custom)} />

      <Select
        aria-label={`Brand voice preset for ${row.label}`}
        aria-describedby={helpId}
        value={preset}
        onChange={(e) => setPreset(e.target.value)}
        options={PRESET_OPTIONS}
      />

      {preset === CUSTOM_PRESET ? (
        <div className="mt-2.5">
          <textarea
            className="cap-input"
            aria-label={`Custom brand voice for ${row.label}`}
            rows={2}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. warm and empathetic, like a helpful friend. Never pushy, always understanding."
          />
        </div>
      ) : null}
    </div>
  );
}

export default function BrandVoiceSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { connectionId, stored } = loaderData;
  const result = actionData as ActionResult | undefined;
  const saving = useNavigation().state === "submitting";

  return (
    <>
      <SettingsBackLink />
      {/* Legacy's PageHeader leaves 32px under the head (mb-8); the wrapper
          keeps that space without styling Capsomer's head. */}
      <div className="mb-8">
        <PageHead
          title="Brand voice"
          lead="Set a different tone for each failure category. The AI uses the matching voice when writing recovery emails."
        />
      </div>

      <DemoGuardedForm method="post">
        <input type="hidden" name="connectionId" value={connectionId ?? ""} />
        <section className="cap-panel">
          <div className="cap-panel-body">
            <p className="mb-5 text-micro text-text-subtle">
              Set a different tone for each failure category. The AI will use the matching voice when
              writing recovery emails.
            </p>
            {CATEGORY_VOICE_ROWS.map((row, i) => (
              <CategoryVoice key={row.key} row={row} stored={stored[row.key]} first={i === 0} />
            ))}
          </div>
        </section>

        {/* Recova's SaveBar: right-aligned, the result beside the button. */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <p role="status" className="text-label">
            {result?.ok === true ? <Status tone="ok">Saved</Status> : null}
            {result?.ok === false ? (
              <Status tone="crit">{result.error ?? "Failed to save. Please try again."}</Status>
            ) : null}
          </p>
          <Button type="submit" variant="primary" pending={saving}>
            Save changes
          </Button>
        </div>
      </DemoGuardedForm>
    </>
  );
}
