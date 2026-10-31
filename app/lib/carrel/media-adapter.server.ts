import {
  LARGE_MEDIA_BYTES,
  MediaInUseError,
  NotFoundError,
  RefusedError,
  VersionConflictError,
  kindOf,
  orientationOf,
  prepareUpload,
  transformFocus,
  mediaRev,
  mediaVersion,
  turnsSize,
  type MediaAdapter,
  type MediaItem,
  type MediaLens,
  type MediaResize,
  type MediaTransformOp,
  type MediaUse,
} from "@dustinedwards/site-api";
import { writeFocus, type R2BucketLike } from "@dustinedwards/site-api/r2";
import { editImage, type EditFormat } from "@dustinedwards/site-runtime/image";

import type { Db } from "~/db";
import { EXTENSIONS, mediaUrl } from "~/lib/media/images";
import {
  historyOf,
  removeFile,
  revisionBytes,
  storeFile,
  swapBytes,
} from "~/lib/media/library.server";
import {
  allMediaRows,
  mediaChangeCursor,
  mediaChangedSince,
  mediaRow,
  mediaRowByHash,
  mediaRowsByKey,
  writeMediaAtRev,
  type MediaFields,
  type MediaRow,
  type MediaWrite,
} from "~/lib/media/store.server";
import { suggestFor } from "~/lib/media/suggest.server";
import { mediaUses } from "~/lib/media/usage.server";

// Carrel's media group (site-api v0.13) over the blog's media library: the R2
// bucket MEDIA and the index tables of migration 0059. Carrel is the only
// writer; nothing here touches a merchant table, Stripe, or a money path.
//
// Every one of site-api's v0.13 media ideas is offered: list and search,
// upload, alt, tags, trash and restore, delete, focal point, caption, replace,
// duplicates, usage, filters, import, credit and license, turns and mirrors,
// byte history and revert, the change log, shrinking at upload and in place,
// embedded metadata, and suggestions. Every new set of bytes (an upload, a
// replace, a shrink) goes through site-api's prepareUpload: the location taken
// out, the shrink, the size and the embedded metadata. Not `replaceKeepsSize`: a post's picture
// is sized from the index row each time the post renders (markdown.server.ts),
// not from its address, so new bytes of another size are honest here.
//
// A file's version is `r<rev>`, and every write lands on the version it names in
// one statement (writeMediaAtRev), so a stale write is a 409, never a lost
// update.

/** The pictures a post can show. No SVG (it can carry script) and nothing that is not a picture. */
const LIMITS = { maxBytes: 20 * 1024 * 1024, types: Object.keys(EXTENSIONS) };

const LENSES: readonly MediaLens[] = [
  "unattached",
  "no-alt",
  "large",
  "duplicates",
  "license-expired",
  "oversized",
];

/** What an upload shrinks to unless it says `resize=no`: wide enough for any screen the 680 px column is shown on at 3x. */
const RESIZE: MediaResize = { maxEdge: 2560, quality: 85 };

/** A turn or a mirror re-encodes a lossy picture, so it is kept at a high quality. */
const TRANSFORM_QUALITY = 92;

/** Pictures the Images binding re-encodes in their own type. A GIF may be animated, and a turn would keep one frame. */
const REENCODED = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

const TRANSFORMS: Record<
  MediaTransformOp,
  { rotate?: 90 | 180 | 270; flip?: "h" | "v" }
> = {
  "rotate-90": { rotate: 90 },
  "rotate-180": { rotate: 180 },
  "rotate-270": { rotate: 270 },
  "flip-h": { flip: "h" },
  "flip-v": { flip: "v" },
};

const iso = (at: Date | null) => (at ? at.toISOString() : null);

function itemOf(row: MediaRow, usedCount?: number): MediaItem {
  const url = mediaUrl(row.key);
  return {
    id: row.key,
    url,
    filename: row.filename,
    contentType: row.contentType,
    bytes: row.bytes,
    width: row.width && row.width > 0 ? row.width : null,
    height: row.height && row.height > 0 ? row.height : null,
    alt: row.alt,
    uploadedAt: iso(row.uploadedAt),
    deletable: true,
    version: mediaVersion(row.rev),
    tags: row.tags,
    trashedAt: iso(row.trashedAt),
    focus: row.focus,
    caption: row.caption,
    ...(usedCount === undefined ? {} : { usedCount }),
    placeholder: null,
    color: null,
    credit: row.credit,
    license: row.license,
    sourceUrl: row.sourceUrl,
    licenseExpires: row.licenseExpires,
    takenAt: row.takenAt,
    downloadUrl: url,
  };
}

/** A write's outcome as the contract's answer or error. */
function answer(write: MediaWrite): { version: string } {
  if (write.ok) return { version: mediaVersion(write.rev) };
  if (write.reason === "missing") throw new NotFoundError("No such media.");
  throw new VersionConflictError(
    mediaVersion(write.rev),
    "The file changed since it was loaded.",
  );
}

/** The longer edge over the site's shrink size. */
const oversized = (row: MediaRow) =>
  Math.max(row.width ?? 0, row.height ?? 0) > RESIZE.maxEdge;

/** The reference check, or a refusal that says it could not run: nothing is deleted on a check that failed. */
async function usesOrRefuse(db: Db): Promise<Map<string, MediaUse[]>> {
  try {
    return await mediaUses(db);
  } catch (error) {
    throw new RefusedError(
      `The reference check could not run (${error instanceof Error ? error.message : String(error)}), so this file's uses are unknown.`,
    );
  }
}

export function carrelMediaAdapter(env: Env, db: Db): MediaAdapter {
  const bucket = env.MEDIA as unknown as R2BucketLike;

  /** Moves the version first, in one statement, for a write that must change the object before the index. */
  async function claim(id: string, expectedVersion: string) {
    return answer(await writeMediaAtRev(db, id, {}, mediaRev(expectedVersion)));
  }

  async function mustHold(id: string): Promise<MediaRow> {
    const row = await mediaRow(db, id);
    if (!row) throw new NotFoundError("No such media.");
    return row;
  }

  const field = (fields: MediaFields) => async (id: string, input: { expectedVersion: string }) =>
    answer(await writeMediaAtRev(db, id, fields, mediaRev(input.expectedVersion)));

  /** The bytes prepareUpload makes of a file's own, for a replace or a shrink. */
  const prepare = (input: { bytes: Uint8Array; contentType: string; filename: string; changeId: string }, resize = false) =>
    prepareUpload(env.IMAGES, { ...input, alt: "", resize }, { resize: RESIZE });

  async function withUse(rows: MediaRow[]): Promise<MediaItem[]> {
    const uses = await mediaUses(db);
    return rows.map((row) => itemOf(row, uses.get(row.key)?.length ?? 0));
  }

  return {
    limits: LIMITS,
    lenses: LENSES,
    usage: true,
    filters: true,
    resize: RESIZE,
    readsEmbedded: true,
    // The package checks every address and each redirect before this fetch runs (importRefusal, fetchImport).
    importFetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, init)) as typeof fetch,

    async list(query) {
      // The cursor first: a change that lands while the page is read is in the next poll, not lost between them.
      const changeCursor = String(await mediaChangeCursor(db));
      const [rows, uses] = await Promise.all([allMediaRows(db), mediaUses(db)]);
      const used = (row: MediaRow) => uses.get(row.key)?.length ?? 0;
      const hashes = new Map<string, number>();
      for (const row of rows)
        hashes.set(row.sha256, (hashes.get(row.sha256) ?? 0) + 1);
      const today = new Date().toISOString().slice(0, 10);
      const lens: Record<MediaLens, (row: MediaRow) => boolean> = {
        unattached: (row) => used(row) === 0,
        "no-alt": (row) => row.alt.trim() === "",
        large: (row) => row.bytes > LARGE_MEDIA_BYTES,
        duplicates: (row) => (hashes.get(row.sha256) ?? 0) > 1,
        "license-expired": (row) =>
          Boolean(row.licenseExpires && row.licenseExpires < today),
        oversized,
      };
      const needle = query.q?.toLowerCase();
      const trashed = query.trashed === "only";
      const matching = rows
        .filter((row) =>
          trashed ? row.trashedAt !== null : row.trashedAt === null,
        )
        .filter((row) => !query.tag || row.tags.includes(query.tag))
        .filter(
          (row) =>
            !needle ||
            [row.key, row.filename ?? "", row.alt, row.caption].some((t) =>
              t.toLowerCase().includes(needle),
            ),
        )
        .filter((row) => !query.lens || lens[query.lens](row))
        .filter(
          (row) =>
            !query.orientation ||
            orientationOf(row.width, row.height) === query.orientation,
        )
        .filter((row) => !query.kind || kindOf(row.contentType) === query.kind);

      // The contract's defaults: added and size largest first, name A to Z, used most used first.
      const sort = query.sort ?? "added";
      const dir = query.dir ?? (sort === "name" ? "asc" : "desc");
      const keyOf = (row: MediaRow): number | string =>
        sort === "size"
          ? row.bytes
          : sort === "used"
            ? used(row)
            : sort === "name"
              ? (row.filename ?? row.key).toLowerCase()
              : row.uploadedAt.getTime();
      const sorted = matching
        .map((row, n) => ({ row, n }))
        .sort((a, b) => {
          const [x, y] = [keyOf(a.row), keyOf(b.row)];
          const by =
            typeof x === "number"
              ? x - (y as number)
              : x.localeCompare(y as string);
          return (dir === "asc" ? by : -by) || a.n - b.n;
        })
        .map(({ row }) => row);

      const start =
        query.cursor && /^(0|[1-9]\d{0,8})$/.test(query.cursor)
          ? Number(query.cursor)
          : 0;
      const next = start + query.limit;
      return {
        items: sorted.slice(start, next).map((row) => itemOf(row, used(row))),
        nextCursor: next < sorted.length ? String(next) : null,
        total: sorted.length,
        sorted: { sort, dir },
        changeCursor,
      };
    },

    async get(id) {
      const row = await mediaRow(db, id);
      if (!row) return null;
      const usedBy = (await usesOrRefuse(db)).get(id) ?? [];
      const twins = (await allMediaRows(db))
        .filter((r) => r.sha256 === row.sha256 && r.key !== id)
        .slice(0, 50)
        .map((r) => ({ id: r.key, filename: r.filename }));
      return { ...itemOf(row, usedBy.length), usedBy, twins };
    },

    async upload(input) {
      const prepared = await prepareUpload(env.IMAGES, input, { resize: RESIZE });
      const found = prepared.embedded;
      const embedded = (["credit", "license", "caption", "takenAt"] as const).filter((name) => found[name]);
      const row = await storeFile(env, db, prepared, {
        reason: input.sourceUrl ? "import" : "upload",
        fields: {
          alt: input.alt,
          ...Object.fromEntries(embedded.map((name) => [name, found[name]])),
          ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        },
      });
      return {
        ...itemOf(row, 0),
        ...(embedded.length > 0 ? { embedded: [...embedded] } : {}),
        ...(prepared.resizedFrom ? { resizedFrom: prepared.resizedFrom } : {}),
      };
    },

    async delete(id) {
      const row = await mustHold(id);
      const uses = (await usesOrRefuse(db)).get(id) ?? [];
      if (uses.length > 0) throw new MediaInUseError(uses);
      if (!(await removeFile(env, db, row))) {
        throw new RefusedError(
          `${id} changed while this delete was being checked. Nothing was deleted; try again.`,
        );
      }
    },

    async setAlt(id, input) {
      return field({ alt: input.alt })(id, input);
    },

    // The contract has already spelled the tags (lower case, hyphens, at most 12), and that is the site's spelling.
    async setTags(id, input) {
      return field({ tags: input.tags })(id, input);
    },

    // A trashed file keeps its object and address, so a post that uses it still shows it.
    async trash(id, input) {
      return field({ trashedAt: new Date() })(id, input);
    },

    async restore(id, input) {
      return field({ trashedAt: null })(id, input);
    },

    async setCaption(id, input) {
      return field({ caption: input.caption })(id, input);
    },

    async setCredit(id, input) {
      const { credit, license, sourceUrl, licenseExpires } = input;
      return field({ credit, license, sourceUrl, licenseExpires })(id, input);
    },

    // The object's customMetadata `focus` is what site-runtime ./image crops around; the index keeps the same point.
    async setFocus(id, input) {
      await claim(id, input.expectedVersion);
      await writeFocus(bucket, id, input.focus);
      return answer(await writeMediaAtRev(db, id, { focus: input.focus }));
    },

    async replace(id, input) {
      const prepared = await prepare(input);
      if (!prepared.width || !prepared.height)
        throw new RefusedError("The new file could not be read as a picture.");
      await claim(id, input.expectedVersion);
      const row = await swapBytes(
        env,
        db,
        await mustHold(id),
        {
          bytes: prepared.bytes,
          contentType: prepared.contentType,
          width: prepared.width,
          height: prepared.height,
          reason: "replace",
        },
        { focus: null, filename: input.filename.slice(0, 300) },
      );
      // The image route keys its cached sizes by the object's etag (site-runtime ./image), and pages
      // name the new bytes by a new versioned address (app/routes/files/media.ts).
      return { item: itemOf(row), sizesNeedPurge: false };
    },

    async findByHash(sha256) {
      const row = await mediaRowByHash(db, sha256);
      return row ? itemOf(row) : null;
    },

    async transform(id, input) {
      const row = await mustHold(id);
      if (!REENCODED.has(row.contentType)) {
        throw new RefusedError(
          `A ${row.contentType} picture is not turned here: a GIF may be animated, and a turn would keep one frame.`,
        );
      }
      if (row.rev !== mediaRev(input.expectedVersion)) throw new VersionConflictError(mediaVersion(row.rev), "The file changed since it was loaded.");
      const object = await env.MEDIA.get(id);
      if (!object) throw new NotFoundError("No such media.");
      const turned = await editImage(env.IMAGES, object.body, {
        ...TRANSFORMS[input.op],
        format: row.contentType as EditFormat,
        quality: TRANSFORM_QUALITY,
      });
      const bytes = new Uint8Array(await turned.arrayBuffer());
      const swapped = turnsSize(input.op);
      const focus = transformFocus(row.focus, input.op);
      await claim(id, input.expectedVersion);
      const after = await swapBytes(
        env,
        db,
        await mustHold(id),
        {
          bytes,
          contentType: row.contentType,
          width: swapped ? row.height : row.width,
          height: swapped ? row.width : row.height,
          reason: "transform",
        },
        { focus },
      );
      // The swap dropped the old point with the old bytes; the moved one goes back on the object for ./image.
      if (focus) await writeFocus(bucket, id, focus);
      return { item: itemOf(after), sizesNeedPurge: false };
    },

    async history(id) {
      const row = await mediaRow(db, id);
      return row ? historyOf(db, row) : null;
    },

    // The package has checked that `to` is an earlier revision; its bytes come back as a new revision.
    async revert(id, input) {
      await mustHold(id);
      const kept = await revisionBytes(env, db, id, input.to);
      if (!kept)
        throw new NotFoundError(
          "This file has no such earlier version, or its copy is gone.",
        );
      await claim(id, input.expectedVersion);
      const row = await mustHold(id);
      const after = await swapBytes(
        env,
        db,
        row,
        {
          bytes: kept.bytes,
          contentType: row.contentType,
          width: kept.revision.width,
          height: kept.revision.height,
          reason: "revert",
        },
        { focus: null },
      );
      return { item: itemOf(after), sizesNeedPurge: false };
    },

    async shrink(id, input) {
      const row = await mustHold(id);
      if (row.rev !== mediaRev(input.expectedVersion)) throw new VersionConflictError(mediaVersion(row.rev), "The file changed since it was loaded.");
      if (!REENCODED.has(row.contentType) || !oversized(row)) return { resized: false, item: itemOf(row) };
      const object = await env.MEDIA.get(id);
      if (!object) throw new NotFoundError("No such media.");
      const shrunk = await prepare(
        { bytes: new Uint8Array(await object.arrayBuffer()), contentType: row.contentType, filename: row.filename ?? id, changeId: input.changeId },
        true,
      );
      if (!shrunk.resizedFrom) return { resized: false, item: itemOf(row) };
      await claim(id, input.expectedVersion);
      const after = await swapBytes(
        env,
        db,
        await mustHold(id),
        {
          bytes: shrunk.bytes,
          contentType: row.contentType,
          width: shrunk.width,
          height: shrunk.height,
          reason: "resize",
        },
        { focus: row.focus },
      );
      if (row.focus) await writeFocus(bucket, id, row.focus);
      return { resized: true, item: itemOf(after) };
    },

    // From the change log the triggers on `media` write: every insert, update and delete of a row.
    async changes({ since, limit }) {
      const head = await mediaChangeCursor(db);
      if (!/^(0|[1-9]\d{0,15})$/.test(since) || Number(since) > head) {
        throw new RefusedError(
          "That change cursor is not this site's; reload the library.",
        );
      }
      const changed = await mediaChangedSince(db, Number(since), head, limit);
      const more = changed.length > limit;
      const taken = changed.slice(0, limit);
      const rows = new Map(
        (
          await mediaRowsByKey(
            db,
            taken.map((c) => c.key),
          )
        ).map((row) => [row.key, row]),
      );
      return {
        items: await withUse(taken.flatMap((c) => rows.get(c.key) ?? [])),
        removed: taken.filter((c) => !rows.has(c.key)).map((c) => c.key),
        cursor: String(more ? taken[limit - 1]!.seq : head),
        more,
      };
    },

    // Never applied: Carrel shows them, and an editor accepts each as an alt or a tags write.
    async suggest(id) {
      const row = await mediaRow(db, id);
      if (!row) return null;
      const object = await env.MEDIA.get(id);
      if (!object) return null;
      try {
        return await suggestFor(env, object.body, id);
      } catch (error) {
        throw new RefusedError(
          `No suggestion was made: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
