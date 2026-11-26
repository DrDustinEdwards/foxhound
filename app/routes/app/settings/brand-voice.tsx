import { capitalize } from "@drdustinedwards/site-helpers/text";
import { useId, useState } from "react";
import { data, useNavigation } from "react-router";
import { SaveBar } from "capsomer/react/save-bar";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import "capsomer/select.css";

import { DemoForm } from "~/lib/demo/use-demo-guard";
import { SettingsLayout } from "capsomer/react/settings-row";
import { routerRenderLink } from "capsomer/react/link";
import { getDb } from "~/db";
import { accountScope } from "~/lib/auth/context";
import { applyBrandVoice } from "~/lib/settings/apply-sender-voice.server";
import { getPrimaryBrandVoices } from "~/lib/settings/queries.server";
import {
  MAX_VOICE_SAMPLES,
  readVoiceSamples,
  VOICE_SAMPLE_MAX_CHARS,
  voiceSampleFieldName,
} from "~/lib/recovery/voice-samples";
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
import { noindexMeta } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /settings/brand-voice: the phone-only back link, the title and its line, one card that opens with its own line and holds the four categories (dot, label and help, then the preset picker, then the custom box when Custom is chosen), then the right-aligned "Save changes" with "Saved" or "Failed to save. Please try again." beside it.
// FOUR FIELDS AND NO GENERAL ONE: the action never names `general`, and applyBrandVoice leaves an absent key as it is, so `brand_voice` is left alone on this save. DECLINE_CATEGORIES also has `revoked` and `unknown`, which have no column (the resolver's default arm sends them to the general voice), so no field is rendered for them.
// NO BOUND ON ANY FIELD: no maxLength, no pattern, no required. An empty selection stores NULL and reads back as "Same as main voice".
// SAMPLE EMAILS: a second card where the merchant pastes up to five emails they wrote themselves, which recovery and win-back drafts are written from (app/lib/recovery/voice-samples.ts). It posts with the same Save changes. Each box is cut at VOICE_SAMPLE_MAX_CHARS, so it carries a maxLength, unlike the voice fields above.

export const meta = noindexMeta("Brand voice - Foxhound");

export async function loader({ context }: Route.LoaderArgs) {
  const { env, auth } = accountScope(context);
  const voices = await getPrimaryBrandVoices(getDb(env), auth.membership.accountId);
  return {
    connectionId: voices?.id ?? null,
    stored: {
      soft: voices?.soft ?? null,
      expired: voices?.expired ?? null,
      network: voices?.network ?? null,
      fraud: voices?.fraud ?? null,
    },
    samples: readVoiceSamples(voices?.samples),
  };
}

interface ActionResult {
  ok: boolean;
  /** The apply layer's own refusal, when it refused rather than threw. */
  error?: string;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, auth } = accountScope(context);
  const form = await readForm(request, BODY_MAX_BYTES);

  // FOUR NAMED FIELDS, read here and validated nowhere here. A form posting `voice_revoked`, `brandVoice` or any other column name contributes nothing: the input is built by naming each key, and `applyBrandVoice` names each column. `general` is never named, so the main voice is left as it is.
  const read = (key: CategoryVoiceKey): string => String(form.get(voiceFieldName(key)) ?? "");

  // A refusal (no connection, or one on another account) says its own sentence rather than "Saved". A write that throws says the SaveBar failure line on this page instead of an error page.
  let result: Awaited<ReturnType<typeof applyBrandVoice>>;
  try {
    result = await applyBrandVoice(getDb(env), auth.membership.accountId, {
      connectionId: form.get("connectionId"),
      soft: read("soft"),
      expired: read("expired"),
      network: read("network"),
      fraud: read("fraud"),
      samples: Array.from({ length: MAX_VOICE_SAMPLES }, (_, i) =>
        String(form.get(voiceSampleFieldName(i)) ?? ""),
      ),
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
  ...BRAND_VOICE_PRESETS.map((p) => ({ value: p, label: capitalize(p) })),
  { value: CUSTOM_PRESET, label: "Custom..." },
];

/** One of the four rows: the dot with the label and its help, the preset picker, and the custom box when Custom is chosen. The picker is Capsomer's Select, named with an aria-label and described by the help line; the box is a cap-input textarea with an aria-label. */
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
    <div className={first ? "fh-voice-first" : "fh-voice-row"}>
      <div className="fh-voice-head">
        <span aria-hidden="true" className="fh-voice-dot" data-tone={row.dot}></span>
        <div>
          <div className="fh-small fh-medium fh-text">{row.label}</div>
          <div id={helpId} className="fh-voice-help fh-tiny fh-faint">
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
        <div className="fh-voice-control">
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
  const { connectionId, stored, samples } = loaderData;
  const result = actionData as ActionResult | undefined;
  const saving = useNavigation().state === "submitting";

  return (
    <SettingsLayout renderLink={routerRenderLink} title="Brand voice">
      <DemoForm method="post">
        <input type="hidden" name="connectionId" value={connectionId ?? ""} />
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div>
              {CATEGORY_VOICE_ROWS.map((row, i) => (
                <CategoryVoice key={row.key} row={row} stored={stored[row.key]} first={i === 0} />
              ))}
            </div>
          </div>
        </section>

        <div className="fh-voice-preview">
          <Panel
            title="Sample emails"
            meta="Two to five you wrote yourself. Leave out card numbers and anything private: the AI reads them."
          >
            <div className="fh-voice-rows">
              {Array.from({ length: MAX_VOICE_SAMPLES }, (_, i) => (
                <textarea
                  key={i}
                  className="cap-input"
                  name={voiceSampleFieldName(i)}
                  aria-label={`Sample email ${i + 1}`}
                  rows={i < 2 ? 6 : 3}
                  maxLength={VOICE_SAMPLE_MAX_CHARS}
                  defaultValue={samples[i] ?? ""}
                  placeholder={
                    i === 0 ? "Hi Sam, thanks for sticking with us this year..." : undefined
                  }
                />
              ))}
            </div>
          </Panel>
        </div>

        <SaveBar
          pending={saving}
          saved={result?.ok === true}
          error={
            result?.ok === false ? (result.error ?? "Failed to save. Please try again.") : null
          }
        />
      </DemoForm>
    </SettingsLayout>
  );
}
