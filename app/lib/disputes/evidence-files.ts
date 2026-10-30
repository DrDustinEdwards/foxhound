import {
  DISPUTE_EVIDENCE_ALLOWED_TYPES,
  DISPUTE_EVIDENCE_MAX_FILES,
  DISPUTE_EVIDENCE_MAX_SIZE_BYTES,
  type DisputeEvidenceFileType,
} from "~/lib/constants";

// Merchant evidence files, the client-safe half: no database, no bucket.
// Recova is the spec, read whole: components/disputes/DisputeFileUploads.tsx
// (1286eb21), hooks/useDisputeActions.ts (b650cd6d), app/api/disputes/
// upload-evidence/route.ts (7acca2a9), delete-evidence/route.ts (06a2cd1a),
// evidence-url/route.ts (57ccef71) and submit/route.ts (6c21ef74). The bucket
// work is evidence-files.server.ts.

/** The dispute_evidence.field_name a stored file is recorded under, as
 *  Recova's. Its field_value is the object key in the EVIDENCE bucket. */
export const EVIDENCE_FILE_FIELD = "file_upload";

/** The id the upload form carries, so the file input inside the draft form's
 *  markup can belong to it through the `form` attribute (forms cannot nest). */
export const EVIDENCE_UPLOAD_FORM_ID = "dispute-evidence-upload";
/** The same for the Remove file buttons. */
export const EVIDENCE_DELETE_FORM_ID = "dispute-evidence-delete";

/** Recova's limits line, from the constants: "JPG, PNG, or PDF. 5 MB max. 5
 *  files max per dispute." */
export const EVIDENCE_FILES_LIMITS_LINE = `JPG, PNG, or PDF. ${DISPUTE_EVIDENCE_MAX_SIZE_BYTES / (1024 * 1024)} MB max. ${DISPUTE_EVIDENCE_MAX_FILES} files max per dispute.`;

/** In the upload control's place while the EVIDENCE bucket is not bound. Not
 *  Recova's: Recova always had its bucket. Copy about an unbuilt feature says
 *  not built, never "cannot". */
export const EVIDENCE_FILES_UNAVAILABLE_LINE = "File uploads are not available yet.";

/** Recova's Remove file confirmation (useDisputeActions.ts). */
export const EVIDENCE_FILE_REMOVE_CONFIRM = "Remove this file?";

/** Every named outcome of the file paths. A route answers one of these, never
 *  a bare failure (RULES.md 3.16's rule for send paths, applied here). */
export type EvidenceFileOutcome =
  | "uploaded"
  | "deleted"
  | "uploads_unavailable"
  | "evidence_locked"
  | "file_required"
  | "file_type_not_allowed"
  | "file_too_large"
  | "max_files_exceeded"
  | "upload_failed"
  | "delete_failed"
  | "not_saved"
  | "not_found";

/** What the merchant reads for each outcome. Recova's own lines where it had
 *  them (useDisputeActions.ts); Recova printed its server codes raw
 *  ("file_type_not_allowed"), a raw value shown to a merchant, which is not
 *  copied. */
export const EVIDENCE_FILE_MESSAGES: Record<EvidenceFileOutcome, string> = {
  uploaded: "",
  deleted: "",
  uploads_unavailable: EVIDENCE_FILES_UNAVAILABLE_LINE,
  evidence_locked: "This dispute's evidence is locked: it has been approved or submitted.",
  file_required: "Choose a file to upload.",
  file_type_not_allowed: "Only JPG, PNG, or PDF files are allowed.",
  file_too_large: `Files must be ${DISPUTE_EVIDENCE_MAX_SIZE_BYTES / (1024 * 1024)} MB or smaller.`,
  max_files_exceeded: `Maximum ${DISPUTE_EVIDENCE_MAX_FILES} files per dispute.`,
  upload_failed: "Upload failed.",
  delete_failed: "Could not remove the file.",
  not_saved: "This dispute changed, so nothing was saved. Reload to see the current evidence.",
  not_found: "That file was not found.",
};

/** The HTTP status each outcome answers with. */
export const EVIDENCE_FILE_STATUS: Record<EvidenceFileOutcome, number> = {
  uploaded: 200,
  deleted: 200,
  uploads_unavailable: 503,
  evidence_locked: 409,
  file_required: 400,
  file_type_not_allowed: 400,
  file_too_large: 400,
  max_files_exceeded: 400,
  upload_failed: 500,
  delete_failed: 500,
  not_saved: 409,
  not_found: 404,
};

export function isEvidenceFileType(type: string): type is DisputeEvidenceFileType {
  return (DISPUTE_EVIDENCE_ALLOWED_TYPES as readonly string[]).includes(type);
}

/** Recova's fileNameFromPath (formatters.tsx): the last part of the key. */
export function fileNameFromPath(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Recova's client-side checks before an upload, in its order: type, size,
 * count. The server repeats every one; this only saves the merchant a round
 * trip. Null when the file may go.
 */
export function precheckEvidenceFile(
  file: { type: string; size: number },
  filesSoFar: number,
): EvidenceFileOutcome | null {
  if (!isEvidenceFileType(file.type)) return "file_type_not_allowed";
  if (file.size > DISPUTE_EVIDENCE_MAX_SIZE_BYTES) return "file_too_large";
  if (filesSoFar >= DISPUTE_EVIDENCE_MAX_FILES) return "max_files_exceeded";
  return null;
}

/**
 * Whether the file's first bytes are the type it declares. Recova trusted the
 * browser's declared type; Foxhound serves these files from its own origin and
 * sends them to Stripe, so a file that only claims to be a PNG is refused as
 * the wrong type. JPEG starts FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A, PDF
 * "%PDF-".
 */
export function bytesMatchType(head: Uint8Array, type: DisputeEvidenceFileType): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => head[i] === b);
  if (type === "image/jpeg") return starts([0xff, 0xd8, 0xff]);
  if (type === "image/png") return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
}

const TYPE_EXTENSION: Record<DisputeEvidenceFileType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

/**
 * Recova's safe name: the uploaded name's extension, lower-cased and stripped
 * to letters and digits, after a fresh UUID. A name with no usable extension
 * takes the type's.
 */
export function evidenceObjectName(uuid: string, originalName: string, type: DisputeEvidenceFileType): string {
  const parts = originalName.split(".");
  const ext = parts.length > 1 ? (parts.pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) : "";
  return `${uuid}.${ext || TYPE_EXTENSION[type]}`;
}

/** Recova's key layout, `${accountId}/${disputeId}/${safeName}`, kept so its
 *  objects can be copied across at cutover under the same keys. */
export function evidenceObjectKey(accountId: string, disputeId: string, name: string): string {
  return `${accountId}/${disputeId}/${name}`;
}

/** The account-scoped view link the section's file names open. */
export function evidenceFileHref(disputeId: string, evidenceId: string): string {
  return `/disputes/${encodeURIComponent(disputeId)}/files/${encodeURIComponent(evidenceId)}`;
}

/**
 * Stripe's single-file evidence slots, in Recova's priority order
 * (submit/route.ts FILE_SLOTS). The merchant's files fill them in the order
 * the page lists them; past five there is no slot, and the upload limit is
 * five.
 */
export const STRIPE_FILE_SLOTS = [
  "receipt",
  "service_documentation",
  "shipping_documentation",
  "customer_communication",
  "uncategorized_file",
] as const;

/** One file read from the bucket for the submission. */
export interface EvidenceFileUpload {
  name: string;
  contentType: string;
  bytes: Uint8Array;
  /** Its index in STRIPE_FILE_SLOTS: the file's place in the page's list, kept
   *  when an earlier file could not be read, as Recova's slot i stayed file i's.
   *  Absent, the file's place in the array is used. */
  slot?: number;
}
