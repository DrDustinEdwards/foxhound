import { NotFoundError, RefusedError, sha256Hex, toArrayBuffer, type PreparedUpload } from "@dustinedwards/site-api";
import { replaceObject, type R2BucketLike } from "@dustinedwards/site-api/r2";

import type { Db } from "~/db";
import { slugify } from "@drdustinedwards/site-helpers/slug";

import { EXTENSIONS, UPLOAD_KEY } from "./images";
import {
  addRevision,
  deleteMediaRowAtRev,
  deleteRevisionsOf,
  insertMediaRow,
  keepRevision,
  mediaRow,
  revisionsOf,
  writeMediaAtRev,
  type MediaFields,
  type MediaRow,
} from "./store.server";

// The media library's bytes: the one place an object in MEDIA is written or
// removed, and its index row and byte history with it. A file's current bytes
// are the object at its key; every earlier set is copied to
// `revisions/<key>/<revision id>` before it is overwritten, a key the public
// route never serves (UPLOAD_KEY), so a turn, a replace or a shrink can be taken
// back. Deleting a file removes its object, its copies and its rows.

export type RevisionReason = "upload" | "import" | "replace" | "transform" | "resize" | "revert";

type MediaEnv = Pick<Env, "MEDIA">;

/** The binding's `put` takes a wider `onlyIf` than the helpers' narrow interface names; the shapes they use agree. */
const bucketOf = (env: MediaEnv) => env.MEDIA as unknown as R2BucketLike;

const copyKeyOf = (key: string, revision: number) => `revisions/${key}/${revision}`;

/** `<year>/<month>/<name>-<first 8 of the hash>.<ext>`, a few more hash characters on a clash. */
async function freshKey(db: Db, filename: string, sha256: string, contentType: string): Promise<string> {
  const now = new Date();
  const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const name = slugify(filename.replace(/\.[^.]*$/, ""), { max: 60 }) || "picture";
  for (const length of [8, 12, 16, 64]) {
    const key = `${month}/${name}-${sha256.slice(0, length)}.${EXTENSIONS[contentType]}`;
    if (!UPLOAD_KEY.test(key)) throw new RefusedError(`${filename} cannot be stored under a library address.`);
    if (!(await mediaRow(db, key))) return key;
  }
  throw new RefusedError("A file with these bytes is already stored under every address this upload could take.");
}

/**
 * Stores an upload site-api's prepareUpload made ready as a new file: the
 * object first, then its row and its revisions. Where it shrank the picture,
 * the bytes before the shrink are kept as the file's first revision, so the
 * shrink can be reverted. The upload's revision carries the hash of the bytes
 * as sent, which is what Carrel asks findByHash about.
 */
export async function storeFile(
  env: MediaEnv,
  db: Db,
  prepared: PreparedUpload,
  input: { reason: "upload" | "import"; fields: MediaFields },
): Promise<MediaRow> {
  const { bytes, contentType, filename, width, height, sha256, placeholder, color, original, resizedFrom } = prepared;
  if (!width || !height) throw new RefusedError(`${filename} could not be read as a picture.`);
  const key = await freshKey(db, filename, sha256, contentType);
  await env.MEDIA.put(key, toArrayBuffer(bytes), { httpMetadata: { contentType } });
  const at = new Date();
  await insertMediaRow(db, {
    ...input.fields,
    key,
    filename: filename.slice(0, 300),
    contentType,
    bytes: bytes.byteLength,
    width,
    height,
    sha256,
    placeholder,
    color,
    uploadedAt: at,
  });
  const sent = { at, mediaKey: key, reason: input.reason, sha256: prepared.uploadSha256 };
  if (original && resizedFrom) {
    const first = await addRevision(db, { ...sent, bytes: original.byteLength, width: resizedFrom.width, height: resizedFrom.height });
    const copyKey = copyKeyOf(key, first);
    await env.MEDIA.put(copyKey, toArrayBuffer(original), { httpMetadata: { contentType } });
    await keepRevision(db, first, copyKey);
    await addRevision(db, { ...sent, bytes: bytes.byteLength, width, height, reason: "resize", sha256 });
  } else {
    await addRevision(db, { ...sent, bytes: bytes.byteLength, width, height });
  }
  const row = await mediaRow(db, key);
  if (!row) throw new Error(`${key} was stored, but its index row cannot be read`);
  return row;
}

/**
 * Puts new bytes under a file's key as its newest revision, the current ones
 * copied first. The caller has already claimed the version (writeMediaAtRev at
 * the version the editor loaded), so a stale writer never reaches here.
 * `fields` are index columns that follow the bytes (the focal point).
 */
export async function swapBytes(
  env: MediaEnv,
  db: Db,
  row: MediaRow,
  next: { bytes: Uint8Array; contentType: string; width: number | null; height: number | null; reason: RevisionReason },
  fields: MediaFields = {},
): Promise<MediaRow> {
  const current = await env.MEDIA.get(row.key);
  if (!current) throw new NotFoundError("No such media.");
  const [latest] = await revisionsOf(db, row.key);
  const revision =
    latest?.id ??
    (await addRevision(db, { mediaKey: row.key, at: row.uploadedAt, bytes: row.bytes, width: row.width, height: row.height, reason: "upload", sha256: row.sha256 }));
  const copyKey = copyKeyOf(row.key, revision);
  await env.MEDIA.put(copyKey, await current.arrayBuffer(), { httpMetadata: current.httpMetadata });
  await keepRevision(db, revision, copyKey);

  await replaceObject(bucketOf(env), row.key, { bytes: next.bytes, contentType: next.contentType });
  const sha256 = await sha256Hex(next.bytes);
  await addRevision(db, { mediaKey: row.key, at: new Date(), bytes: next.bytes.byteLength, width: next.width, height: next.height, reason: next.reason, sha256 });
  await writeMediaAtRev(db, row.key, { bytes: next.bytes.byteLength, width: next.width, height: next.height, sha256, ...fields });
  const after = await mediaRow(db, row.key);
  if (!after) throw new Error(`${row.key} was rewritten, but its index row cannot be read`);
  return after;
}

/** The history as the contract answers it, newest first, exactly one current. */
export async function historyOf(db: Db, row: MediaRow) {
  const revisions = await revisionsOf(db, row.key);
  return revisions.map((r, n) => ({
    rev: String(r.id),
    at: r.at.toISOString(),
    bytes: r.bytes,
    width: r.width && r.width > 0 ? r.width : null,
    height: r.height && r.height > 0 ? r.height : null,
    reason: r.reason as RevisionReason,
    current: n === 0,
  }));
}

/** The bytes an earlier revision kept, or null for one this file never had or whose copy is gone. */
export async function revisionBytes(env: MediaEnv, db: Db, key: string, rev: string) {
  const revision = (await revisionsOf(db, key)).find((r) => String(r.id) === rev);
  if (!revision?.copyKey) return null;
  const kept = await env.MEDIA.get(revision.copyKey);
  if (!kept) return null;
  return { revision, bytes: new Uint8Array(await kept.arrayBuffer()) };
}

/**
 * Deletes a file for good: its row first, and only at the version the
 * reference check saw, then its object, the copies of its earlier bytes and
 * their rows. False when the row moved in between, so nothing was deleted.
 */
export async function removeFile(env: MediaEnv, db: Db, row: MediaRow): Promise<boolean> {
  const revisions = await revisionsOf(db, row.key);
  if (!(await deleteMediaRowAtRev(db, row.key, row.rev))) return false;
  const copies = revisions.flatMap((r) => (r.copyKey ? [r.copyKey] : []));
  await env.MEDIA.delete([row.key, ...copies]);
  await deleteRevisionsOf(db, row.key);
  return true;
}
