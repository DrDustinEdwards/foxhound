// Parts of the dispute detail page (routes/app/disputes/detail.tsx split): the
// approve button, field rows and the evidence file forms.

import { formatDate } from "capsomer/behavior/time";
import {
  DISPUTE_EVIDENCE_ALLOWED_TYPES,
  DISPUTE_EVIDENCE_MAX_FILES,
  DISPUTE_EVIDENCE_MAX_SIZE_BYTES,
} from "~/lib/constants";
import { useFetcher } from "react-router";
import { Panel } from "capsomer/react/panel";
import { FileAttach } from "capsomer/react/file-attach";
import "capsomer/file-attach.css";
import { UNSAVED_APPROVE_LINE } from "~/lib/disputes/detail";
import {
  EVIDENCE_DELETE_FORM_ID,
  EVIDENCE_FILE_REMOVE_CONFIRM,
  EVIDENCE_FILES_LIMITS_LINE,
  EVIDENCE_FILES_UNAVAILABLE_LINE,
  EVIDENCE_UPLOAD_FORM_ID,
  evidenceFileHref,
  fileNameFromPath,
} from "~/lib/disputes/evidence-files";
import { confirmSubmit } from "capsomer/behavior/confirm-dialog";
import type { action } from "~/routes/app/disputes/detail";

/**
 * The Approve button. Approve submits the SAVED draft, so while
 * the page holds unsaved edits it is held back, focusable, with the reason in
 * visible text beside it, never a silent drop of the merchant's edits.
 */
export function ApproveButton({
  label,
  approving,
  dirty,
}: {
  label: string;
  approving: boolean;
  dirty: boolean;
}) {
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

/** The fetcher keys the evidence file section and its forms share. */
const UPLOAD_FETCHER_KEY = "dispute-evidence-upload";
const DELETE_FETCHER_KEY = "dispute-evidence-delete";

/**
 * The upload and remove forms, rendered after the draft form because
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
 * Recova's DisputeFileUploads (1286eb21) on Capsomer's FileAttach: the title
 * with the limits line, an "Upload file" control while fewer than five files
 * are on the dispute, the files by name and date with "Remove file", or "No
 * files uploaded.". Choosing a file uploads it at once, as Recova's onChange
 * did, after the part's checks; without script its Upload button posts the same
 * form. Read-only once approved or submitted, and in the demo: no control and
 * no Remove file. With no bucket bound, the upload control's place says so.
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
  const canChange = editable && available;

  const resultError = (d: unknown) =>
    d && typeof d === "object" && "fileOutcome" in d && "error" in d
      ? String((d as { error: unknown }).error)
      : null;

  return (
    <Panel title="Evidence files" description={EVIDENCE_FILES_LIMITS_LINE}>
      <FileAttach
        files={files.map((f) => ({
          id: f.id,
          name: fileNameFromPath(f.fieldValue),
          href: available ? evidenceFileHref(disputeId, f.id) : undefined,
          meta: formatDate(f.createdAt, { style: "medium" }) ?? "",
        }))}
        form={EVIDENCE_UPLOAD_FORM_ID}
        accept={DISPUTE_EVIDENCE_ALLOWED_TYPES.join(",")}
        maxBytes={DISPUTE_EVIDENCE_MAX_SIZE_BYTES}
        // A locked dispute takes no more files, so the list holds what it has.
        maxFiles={canChange ? DISPUTE_EVIDENCE_MAX_FILES : files.length}
        pending={upload.state !== "idle"}
        onFiles={(_chosen, input) => {
          if (input.form)
            void upload.submit(input.form, { method: "post", encType: "multipart/form-data" });
        }}
        error={resultError(upload.data) ?? resultError(remove.data)}
        unavailable={editable && !available ? EVIDENCE_FILES_UNAVAILABLE_LINE : undefined}
        renderRemove={
          canChange
            ? (f) => (
                <button
                  type="submit"
                  form={EVIDENCE_DELETE_FORM_ID}
                  name="evidence_id"
                  value={f.id}
                  className="cap-btn"
                  data-variant="quiet"
                  data-size="sm"
                  aria-label={`Remove file ${f.name}`}
                  onClick={(e) =>
                    confirmSubmit(e, { title: EVIDENCE_FILE_REMOVE_CONFIRM, action: "Remove file" })
                  }
                >
                  Remove file
                </button>
              )
            : undefined
        }
      />
    </Panel>
  );
}
