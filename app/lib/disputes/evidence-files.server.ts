import { and, count, eq, exists, notExists, notInArray, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { disputeApprovals, disputeEvidence, disputes } from "~/db";
import { DISPUTE_EVIDENCE_MAX_FILES, DISPUTE_EVIDENCE_MAX_SIZE_BYTES } from "~/lib/constants";
import { SUBMITTED_OR_RESOLVED } from "~/lib/disputes/approval";
import {
  EVIDENCE_FILE_FIELD,
  STRIPE_FILE_SLOTS,
  bytesMatchType,
  evidenceObjectKey,
  evidenceObjectName,
  fileNameFromPath,
  isEvidenceFileType,
  type EvidenceFileOutcome,
  type EvidenceFileUpload,
} from "~/lib/disputes/evidence-files";

// Merchant evidence files on R2 (J07), the bucket half. Recova is the spec:
// lib/r2.ts (3997617f) and app/api/disputes/upload-evidence (7acca2a9),
// delete-evidence (06a2cd1a), evidence-url (57ccef71) and submit (6c21ef74),
// read whole. Recova reached a private bucket over the S3 API with a key pair;
// Foxhound uses the Worker's own R2 binding, EVIDENCE, so there is no key and
// no signed URL: the Worker serves the file itself after the account check.
//
// The binding is Dustin's to create (capsid/conventions.md 1.4). Until it
// exists, `bucket` is undefined and every path answers uploads_unavailable;
// a submission goes ahead without files.
//
// Every read and write is scoped by account AND dispute, and the writes carry
// their guards inside the statement (RULES.md 3.9): no file is added or removed
// once an approval exists or the dispute is submitted or resolved, because the
// approval's evidence hash covers the file rows; an upload past the fifth file
// matches nothing. None of this is a money write: a file is evidence the
// merchant attaches, and billing keys only off submitted_at and the outcome.

/** The bucket slice this module uses, so tests can pass a fake. */
export type EvidenceBucket = Pick<R2Bucket, "put" | "get" | "delete">;

function changedRows(result: unknown): number {
  const r = result as { meta?: { changes?: unknown }; changes?: unknown } | null;
  const n = r?.meta?.changes ?? r?.changes;
  return typeof n === "number" ? n : 0;
}

/** True while the evidence may still change: no approval row for the dispute,
 *  and the dispute is not submitted or resolved. Joined into each write. */
function evidenceOpen(db: Db, accountId: string, disputeId: string) {
  return and(
    eq(disputes.id, disputeId),
    eq(disputes.accountId, accountId),
    notInArray(disputes.state, [...SUBMITTED_OR_RESOLVED]),
    notExists(
      db
        .select({ one: sql`1` })
        .from(disputeApprovals)
        .where(and(eq(disputeApprovals.disputeId, disputeId), eq(disputeApprovals.accountId, accountId))),
    ),
  );
}

function fileRowsOf(accountId: string, disputeId: string) {
  return and(
    eq(disputeEvidence.disputeId, disputeId),
    eq(disputeEvidence.accountId, accountId),
    eq(disputeEvidence.fieldName, EVIDENCE_FILE_FIELD),
  );
}

export interface UploadEvidenceFileInput {
  accountId: string;
  disputeId: string;
  file: FormDataEntryValue | null;
  now: Date;
}

/**
 * Recova's upload-evidence: check the type and size, check the count, write
 * the object, record the row. The caller has already read the dispute under
 * the account (a foreign dispute is a 404 before this) and refused a locked
 * one; the insert repeats both checks inside the statement.
 */
export async function uploadEvidenceFile(
  db: Db,
  bucket: EvidenceBucket | undefined,
  input: UploadEvidenceFileInput,
): Promise<EvidenceFileOutcome> {
  if (!bucket) return "uploads_unavailable";
  const { file } = input;
  if (!(file instanceof File) || file.size === 0) return "file_required";
  if (!isEvidenceFileType(file.type)) return "file_type_not_allowed";
  if (file.size > DISPUTE_EVIDENCE_MAX_SIZE_BYTES) return "file_too_large";

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytesMatchType(bytes, file.type)) return "file_type_not_allowed";

  const [existing] = await db.select({ n: count() }).from(disputeEvidence).where(fileRowsOf(input.accountId, input.disputeId));
  if ((existing?.n ?? 0) >= DISPUTE_EVIDENCE_MAX_FILES) return "max_files_exceeded";

  const key = evidenceObjectKey(
    input.accountId,
    input.disputeId,
    evidenceObjectName(crypto.randomUUID(), file.name, file.type),
  );
  try {
    await bucket.put(key, bytes, { httpMetadata: { contentType: file.type } });
  } catch (err) {
    console.error("dispute evidence upload failed", err);
    return "upload_failed";
  }

  const underLimit = sql`(${db
    .select({ n: count() })
    .from(disputeEvidence)
    .where(fileRowsOf(input.accountId, input.disputeId))}) < ${DISPUTE_EVIDENCE_MAX_FILES}`;
  let written = 0;
  try {
    const result = await db.insert(disputeEvidence).select(
      db
        .select({
          id: sql<string>`${crypto.randomUUID()}`.as("id"),
          disputeId: disputes.id,
          accountId: disputes.accountId,
          fieldName: sql<string>`${EVIDENCE_FILE_FIELD}`.as("field_name"),
          fieldValue: sql<string>`${key}`.as("field_value"),
          createdAt: sql<Date>`${input.now.getTime()}`.as("created_at"),
        })
        .from(disputes)
        .where(and(evidenceOpen(db, input.accountId, input.disputeId), underLimit)),
    );
    written = changedRows(result);
  } catch (err) {
    console.error("dispute evidence row insert failed", err);
    await bucket.delete(key).catch(() => {});
    return "upload_failed";
  }
  if (written === 0) {
    // The dispute changed between the checks above and the insert (an
    // approval, a submission, or another upload took the last place). The
    // object goes, so nothing is left that no row names.
    await bucket.delete(key).catch(() => {});
    return "not_saved";
  }
  return "uploaded";
}

/**
 * Recova's delete-evidence. Recova removed the object first and the row
 * second; here the guarded row delete goes first, so an approval that lands
 * in between can never be left attesting a file that is gone. If the object
 * delete then fails, the row is already gone and the object is logged as an
 * orphan, as Recova logged it.
 */
export async function deleteEvidenceFile(
  db: Db,
  bucket: EvidenceBucket | undefined,
  input: { accountId: string; disputeId: string; evidenceId: string },
): Promise<EvidenceFileOutcome> {
  if (!bucket) return "uploads_unavailable";
  const [row] = await db
    .select({ id: disputeEvidence.id, key: disputeEvidence.fieldValue })
    .from(disputeEvidence)
    .where(and(eq(disputeEvidence.id, input.evidenceId), fileRowsOf(input.accountId, input.disputeId)))
    .limit(1);
  if (!row) return "not_found";

  const result = await db
    .delete(disputeEvidence)
    .where(
      and(
        eq(disputeEvidence.id, row.id),
        fileRowsOf(input.accountId, input.disputeId),
        exists(db.select({ one: sql`1` }).from(disputes).where(evidenceOpen(db, input.accountId, input.disputeId))),
      ),
    );
  if (changedRows(result) === 0) return "not_saved";

  try {
    await bucket.delete(row.key);
  } catch (err) {
    console.error("dispute evidence object delete failed; orphaned object", { key: row.key }, err);
  }
  return "deleted";
}

export type EvidenceFileRead =
  | { outcome: "ok"; body: ReadableStream | null; contentType: string; name: string }
  | { outcome: "uploads_unavailable" }
  | { outcome: "not_found" };

/**
 * Recova's evidence-url, without the signed URL: the row must belong to the
 * account and this dispute, then the Worker reads the object and serves it.
 */
export async function readEvidenceFile(
  db: Db,
  bucket: EvidenceBucket | undefined,
  input: { accountId: string; disputeId: string; evidenceId: string },
): Promise<EvidenceFileRead> {
  if (!bucket) return { outcome: "uploads_unavailable" };
  const [row] = await db
    .select({ key: disputeEvidence.fieldValue })
    .from(disputeEvidence)
    .where(and(eq(disputeEvidence.id, input.evidenceId), fileRowsOf(input.accountId, input.disputeId)))
    .limit(1);
  if (!row) return { outcome: "not_found" };
  const object = await bucket.get(row.key);
  if (!object) return { outcome: "not_found" };
  const declared = object.httpMetadata?.contentType ?? "";
  return {
    outcome: "ok",
    body: (object as { body?: ReadableStream | null }).body ?? null,
    contentType: isEvidenceFileType(declared) ? declared : "application/octet-stream",
    name: fileNameFromPath(row.key),
  };
}

/**
 * The files for a submission, read from the bucket in the order the page
 * lists them (the rows' own order), up to Stripe's five slots. As Recova's
 * submit route, a file that cannot be read is logged and left out and the
 * submission goes on; with no bucket bound, none are sent.
 */
export async function readEvidenceFilesForSubmission(
  bucket: EvidenceBucket | undefined,
  rows: { fieldName: string; fieldValue: string }[],
): Promise<EvidenceFileUpload[]> {
  const keys = rows.filter((r) => r.fieldName === EVIDENCE_FILE_FIELD).map((r) => r.fieldValue);
  if (keys.length === 0) return [];
  if (!bucket) {
    console.error("dispute evidence files not sent: no EVIDENCE binding", { files: keys.length });
    return [];
  }
  const files: EvidenceFileUpload[] = [];
  for (const key of keys.slice(0, STRIPE_FILE_SLOTS.length)) {
    try {
      const object = await bucket.get(key);
      if (!object) {
        console.error("dispute evidence file missing from the bucket", { key });
        continue;
      }
      const declared = object.httpMetadata?.contentType ?? "";
      files.push({
        name: fileNameFromPath(key),
        contentType: isEvidenceFileType(declared) ? declared : "application/octet-stream",
        bytes: new Uint8Array(await object.arrayBuffer()),
      });
    } catch (err) {
      console.error("dispute evidence file read failed", { key }, err);
    }
  }
  return files;
}
