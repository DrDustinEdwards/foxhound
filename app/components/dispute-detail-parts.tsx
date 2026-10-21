// Parts of the dispute detail page (routes/app/disputes/detail.tsx split): the
// approve button, the accept control, field rows and the evidence file forms.

import { DISPUTE_EVIDENCE_ALLOWED_TYPES, DISPUTE_EVIDENCE_MAX_FILES } from "~/lib/constants";
import { useEffect, useId, useRef, useState } from "react";
import { Form, useFetcher } from "react-router";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";
import { ACCEPT_CONFIRM_LINE, UNSAVED_APPROVE_LINE } from "~/lib/disputes/detail";
import {
  EVIDENCE_DELETE_FORM_ID,
  EVIDENCE_FILE_MESSAGES,
  EVIDENCE_FILE_REMOVE_CONFIRM,
  EVIDENCE_FILES_LIMITS_LINE,
  EVIDENCE_FILES_UNAVAILABLE_LINE,
  EVIDENCE_UPLOAD_FORM_ID,
  evidenceFileHref,
  fileNameFromPath,
  precheckEvidenceFile,
  type EvidenceFileOutcome,
} from "~/lib/disputes/evidence-files";
import { formatDateShort } from "~/lib/date-format";
import type { action } from "~/routes/app/disputes/detail";

/**
 * The Approve button (J77 review). Approve submits the SAVED draft, so while
 * the page holds unsaved edits it is held back, focusable, with the reason in
 * visible text beside it, never a silent drop of the merchant's edits.
 */
export function ApproveButton({ label, approving, dirty }: { label: string; approving: boolean; dirty: boolean }) {
  const held = approving || dirty;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        className="cap-btn"
        data-variant="primary"
        aria-disabled={held ? true : undefined}
        aria-describedby={dirty ? "dispute_approve_unsaved" : undefined}
        onClick={(e) => {
          if (held) e.preventDefault();
        }}
      >
        {approving ? "Submitting…" : label}
      </button>
      {dirty ? (
        <span id="dispute_approve_unsaved" className="text-label text-text-secondary">
          {UNSAVED_APPROVE_LINE}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Recova's Accept (DisputeActionBar.tsx): "Accept dispute", then in its place
 * the line, "Yes, accept" and "Cancel". The first button posts a harmless
 * intent so the confirmation also works without script; with script it opens
 * in place. Focus follows the swap so a keyboard user is never left on a button
 * that has gone: opening lands on Cancel (never on "Yes, accept", so a second
 * Enter cannot concede the dispute), and Cancel returns to "Accept dispute".
 */
export function AcceptControl({
  open,
  accepting,
  returnFocus,
  onOpen,
  onCancel,
}: {
  open: boolean;
  accepting: boolean;
  returnFocus: boolean;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const lineId = useId();
  if (!open) {
    return (
      <Form method="post">
        <input type="hidden" name="intent" value="accept_confirm" />
        <button
          type="submit"
          className="cap-btn"
          autoFocus={returnFocus}
          onClick={(e) => {
            e.preventDefault();
            onOpen();
          }}
        >
          Accept dispute
        </button>
      </Form>
    );
  }
  return (
    <Form method="post" className="flex flex-wrap items-center gap-2" aria-label="Accept this dispute">
      <input type="hidden" name="intent" value="accept" />
      <span id={lineId} className="text-label text-text-secondary">
        {ACCEPT_CONFIRM_LINE}
      </span>
      <button
        type="submit"
        className="cap-btn"
        data-variant="danger"
        data-size="sm"
        aria-describedby={lineId}
        aria-disabled={accepting ? true : undefined}
        onClick={(e) => {
          if (accepting) e.preventDefault();
        }}
      >
        {accepting ? "Accepting…" : "Yes, accept"}
      </button>
      <button
        type="button"
        className="cap-btn"
        data-variant="quiet"
        data-size="sm"
        aria-describedby={lineId}
        autoFocus
        onClick={onCancel}
      >
        Cancel
      </button>
    </Form>
  );
}

/** Recova's Row (formatters.tsx): the label in a 140px column, the value
 *  beside it. Multi-line evidence keeps its line breaks. */
export function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <dt className="w-[140px] shrink-0 text-text-tertiary">{label}</dt>
      <dd className="m-0 flex-1 whitespace-pre-line text-text">{value}</dd>
    </div>
  );
}

/** The fetcher keys the evidence file section and its forms share (J07). */
const UPLOAD_FETCHER_KEY = "dispute-evidence-upload";
const DELETE_FETCHER_KEY = "dispute-evidence-delete";

/**
 * The upload and remove forms (J07), rendered after the draft form because
 * forms cannot nest. The section's file input and Remove file buttons belong
 * to them through the form attribute, so they sit where Recova shows them.
 */
export function EvidenceFileForms() {
  const upload = useFetcher<typeof action>({ key: UPLOAD_FETCHER_KEY });
  const remove = useFetcher<typeof action>({ key: DELETE_FETCHER_KEY });
  return (
    <>
      <upload.Form id={EVIDENCE_UPLOAD_FORM_ID} method="post" encType="multipart/form-data" hidden>
        <input type="hidden" name="intent" value="upload_file" />
      </upload.Form>
      <remove.Form id={EVIDENCE_DELETE_FORM_ID} method="post" hidden>
        <input type="hidden" name="intent" value="delete_file" />
      </remove.Form>
    </>
  );
}

/**
 * Recova's DisputeFileUploads (1286eb21): the title with the limits line, an
 * "Upload file" control while fewer than five files are on the dispute, the
 * files by name and date with "Remove file", or "No files uploaded.". Choosing
 * a file uploads it at once, as Recova's onChange did, after Recova's own
 * checks; without script the Upload button beside it posts the same form.
 * Read-only once approved or submitted, and in the demo. With no bucket bound,
 * the upload control's place says so.
 */
export function EvidenceFiles({
  disputeId,
  files,
  editable,
  available,
}: {
  disputeId: string;
  files: { id: string; fieldValue: string; createdAt: Date }[];
  editable: boolean;
  available: boolean;
}) {
  const upload = useFetcher<typeof action>({ key: UPLOAD_FETCHER_KEY });
  const remove = useFetcher<typeof action>({ key: DELETE_FETCHER_KEY });
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [precheck, setPrecheck] = useState<EvidenceFileOutcome | null>(null);
  const uploading = upload.state !== "idle";
  const canChange = editable && available;

  // A finished upload clears the chosen file, as Recova's did.
  const uploadDone = upload.state === "idle" && upload.data !== undefined;
  useEffect(() => {
    if (uploadDone && inputRef.current) inputRef.current.value = "";
  }, [uploadDone, upload.data]);

  const resultError = (d: unknown) =>
    d && typeof d === "object" && "fileOutcome" in d && "error" in d ? String((d as { error: unknown }).error) : null;
  const error = precheck ? EVIDENCE_FILE_MESSAGES[precheck] : (resultError(upload.data) ?? resultError(remove.data));

  let control: React.ReactNode = null;
  if (editable && !available) {
    control = <span className="text-micro text-text-subtle">{EVIDENCE_FILES_UNAVAILABLE_LINE}</span>;
  } else if (canChange && files.length < DISPUTE_EVIDENCE_MAX_FILES) {
    control = (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex rounded-md has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-(--ring) has-[:focus-visible]:outline-solid">
          <label htmlFor={inputId} className="cap-btn" data-size="sm" aria-disabled={uploading ? true : undefined}>
            {uploading ? "Uploading…" : "Upload file"}
          </label>
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          name="file"
          accept={DISPUTE_EVIDENCE_ALLOWED_TYPES.join(",")}
          form={EVIDENCE_UPLOAD_FORM_ID}
          className="sr-only"
          disabled={uploading}
          onChange={(e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            const refused = precheckEvidenceFile(file, files.length);
            setPrecheck(refused);
            if (refused) return;
            if (input.form) void upload.submit(input.form, { method: "post", encType: "multipart/form-data" });
          }}
        />
        <noscript>
          <button type="submit" form={EVIDENCE_UPLOAD_FORM_ID} className="cap-btn" data-size="sm">
            Upload
          </button>
        </noscript>
      </span>
    );
  }

  return (
    <Panel title="Evidence files" description={EVIDENCE_FILES_LIMITS_LINE} actions={control}>
      <div className="text-label">
        <div role="status" className="text-micro">
          {error ? <Status tone="crit">{error}</Status> : null}
        </div>
        {files.length === 0 ? (
          <p className="m-0 text-micro text-text-subtle">No files uploaded.</p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {files.map((f) => {
              const name = fileNameFromPath(f.fieldValue);
              return (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-3 border-b border-border-sub py-1.5 last:border-b-0"
                >
                  {available ? (
                    <a
                      href={evidenceFileHref(disputeId, f.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-label text-brand-text hover:opacity-80"
                    >
                      {name}
                    </a>
                  ) : (
                    <span className="text-label text-text">{name}</span>
                  )}
                  <span className="flex items-center gap-3">
                    <span className="text-micro text-text-subtle">{formatDateShort(f.createdAt)}</span>
                    {canChange ? (
                      <button
                        type="submit"
                        form={EVIDENCE_DELETE_FORM_ID}
                        name="evidence_id"
                        value={f.id}
                        className="cap-btn"
                        data-variant="quiet"
                        data-size="sm"
                        aria-label={`Remove file ${name}`}
                        onClick={(e) => {
                          setPrecheck(null);
                          if (!window.confirm(EVIDENCE_FILE_REMOVE_CONFIRM)) e.preventDefault();
                        }}
                      >
                        Remove file
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
