import { and, count, eq, exists, notExists, notInArray, sql, type SQL } from "drizzle-orm";

import type { Db } from "~/db";
import { changedRows, disputeApprovals, disputeEvidence, disputes } from "~/db";
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

// Merchant evidence files on R2, the bucket half.
//
// None of this is a money write: a file is evidence the merchant attaches, and
// billing keys only off submitted_at and the outcome.

/** The bucket slice this module uses, so tests can pass a fake. */
export type EvidenceBucket = Pick<R2Bucket, "put" | "get" | "delete">;

/**
 * The type an object was stored with, or a download for anything outside the
 * allowed set.
 */
function storedContentType(object: { httpMetadata?: { contentType?: string } }): string {
  const declared = object.httpMetadata?.contentType ?? "";
  return isEvidenceFileType(declared) ? declared : "application/octet-stream";
}

/**
 * True while the evidence may still change: no approval row for the dispute,
 * and the dispute is not submitted or resolved. Joined into each write.
 */
function evidenceOpen(db: Db, accountId: string, disputeId: string) {
  return and(
    eq(disputes.id, disputeId),
    eq(disputes.accountId, accountId),
    notInArray(disputes.state, [...SUBMITTED_OR_RESOLVED]),
    notExists(
      db
        .select({ one: sql`1` })
        .from(disputeApprovals)
        .where(
          and(eq(disputeApprovals.disputeId, disputeId), eq(disputeApprovals.accountId, accountId)),
        ),
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

/**
 * An evidence row inserted from the disputes row, so `guard` (the caller's conditions on the dispute,
 * evaluated at write time) decides whether it lands.
 */
export function buildEvidenceInsert(
  db: Db,
  row: { fieldName: string; fieldValue: string; now: Date },
  guard: SQL | undefined,
) {
  return db.insert(disputeEvidence).select(
    db
      .select({
        id: sql<string>`${crypto.randomUUID()}`.as("id"),
        disputeId: disputes.id,
        accountId: disputes.accountId,
        fieldName: sql<string>`${row.fieldName}`.as("field_name"),
        fieldValue: sql<string>`${row.fieldValue}`.as("field_value"),
        createdAt: sql<Date>`${row.now.getTime()}`.as("created_at"),
      })
      .from(disputes)
      .where(guard),
  );
}

/** One uploaded file's row for the account's dispute, or undefined. */
async function findFileRow(
  db: Db,
  input: { accountId: string; disputeId: string; evidenceId: string },
) {
  const [row] = await db
    .select({ id: disputeEvidence.id, key: disputeEvidence.fieldValue })
    .from(disputeEvidence)
    .where(
      and(eq(disputeEvidence.id, input.evidenceId), fileRowsOf(input.accountId, input.disputeId)),
    )
    .limit(1);
  return row;
}

export interface UploadEvidenceFileInput {
  accountId: string;
  disputeId: string;
  file: FormDataEntryValue | null;
  now: Date;
}

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

  const [existing] = await db
    .select({ n: count() })
    .from(disputeEvidence)
    .where(fileRowsOf(input.accountId, input.disputeId));
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
    const result = await buildEvidenceInsert(
      db,
      { fieldName: EVIDENCE_FILE_FIELD, fieldValue: key, now: input.now },
      and(evidenceOpen(db, input.accountId, input.disputeId), underLimit),
    );
    written = changedRows(result);
  } catch (err) {
    console.error("dispute evidence row insert failed", err);
    await bucket.delete(key).catch(() => {});
    return "upload_failed";
  }
  if (written === 0) {
    // The dispute changed between the checks above and the insert (an approval,
    // a submission, or another upload took the last place). The object goes, so
    // nothing is left that no row names.
    await bucket.delete(key).catch(() => {});
    return "not_saved";
  }
  return "uploaded";
}

export async function deleteEvidenceFile(
  db: Db,
  bucket: EvidenceBucket | undefined,
  input: { accountId: string; disputeId: string; evidenceId: string },
): Promise<EvidenceFileOutcome> {
  if (!bucket) return "uploads_unavailable";
  const row = await findFileRow(db, input);
  if (!row) return "not_found";

  const result = await db.delete(disputeEvidence).where(
    and(
      eq(disputeEvidence.id, row.id),
      fileRowsOf(input.accountId, input.disputeId),
      exists(
        db
          .select({ one: sql`1` })
          .from(disputes)
          .where(evidenceOpen(db, input.accountId, input.disputeId)),
      ),
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

export async function readEvidenceFile(
  db: Db,
  bucket: EvidenceBucket | undefined,
  input: { accountId: string; disputeId: string; evidenceId: string },
): Promise<EvidenceFileRead> {
  if (!bucket) return { outcome: "uploads_unavailable" };
  const row = await findFileRow(db, input);
  if (!row) return { outcome: "not_found" };
  const object = await bucket.get(row.key);
  if (!object) return { outcome: "not_found" };
  return {
    outcome: "ok",
    body: (object as { body?: ReadableStream | null }).body ?? null,
    contentType: storedContentType(object),
    name: fileNameFromPath(row.key),
  };
}

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
  for (const [slot, key] of keys.slice(0, STRIPE_FILE_SLOTS.length).entries()) {
    try {
      const object = await bucket.get(key);
      if (!object) {
        console.error("dispute evidence file missing from the bucket", { key });
        continue;
      }
      files.push({
        name: fileNameFromPath(key),
        contentType: storedContentType(object),
        bytes: new Uint8Array(await object.arrayBuffer()),
        slot,
      });
    } catch (err) {
      console.error("dispute evidence file read failed", { key }, err);
    }
  }
  return files;
}
