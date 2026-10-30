// What a picture says about itself (site-api v0.13.0, mediaEmbedded): who made it, its copyright, its description
// and when it was taken, read from a JPEG's or a WebP's EXIF and a PNG's text chunks at upload. Only these four are
// read; nothing else in the metadata (a camera's location, its serial number) is kept or passed on. The upload fills
// each only where the editor left it empty. The same reader dustinedwards.info runs (app/lib/media/embedded.server.ts
// there); no shared package exports one yet.

export type EmbeddedFields = {
  credit?: string;
  license?: string;
  caption?: string;
  /** With an offset where the file names one, local time where not (the contract's takenAt). */
  takenAt?: string;
};

const TAGS = { description: 0x010e, artist: 0x013b, copyright: 0x8298, exifIfd: 0x8769, taken: 0x9003, offset: 0x9011 } as const;

/** The four fields, from whichever metadata the file's type carries; {} for none or for anything unreadable. */
export function readEmbedded(bytes: Uint8Array, contentType: string): EmbeddedFields {
  try {
    if (contentType === "image/jpeg") return fromTiff(jpegExif(bytes));
    if (contentType === "image/webp") return fromTiff(webpExif(bytes));
    if (contentType === "image/png") return fromPngText(bytes);
  } catch {
    // A malformed block is no metadata, never a refused upload.
  }
  return {};
}

const text = (value: string | undefined, max: number) => {
  // EXIF pads with NUL, and a copyright may hold "photographer\0editor": the first part is the one that names.
  const first = value?.split("\u0000")[0]?.trim();
  return first ? first.slice(0, max) : undefined;
};

/** The TIFF block inside a JPEG's APP1 "Exif" segment, or null. */
function jpegExif(b: Uint8Array): Uint8Array | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1]!;
    // Start of scan: the metadata segments are all before it.
    if (marker === 0xda) return null;
    const length = (b[at + 2]! << 8) | b[at + 3]!;
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(at + 4, at + 10)) === "Exif\u0000\u0000") {
      return b.subarray(at + 10, at + 2 + length);
    }
    at += 2 + length;
  }
  return null;
}

/** The TIFF block in a WebP's EXIF chunk, or null. */
function webpExif(b: Uint8Array): Uint8Array | null {
  let at = 12;
  while (at + 8 <= b.length) {
    const fourcc = String.fromCharCode(...b.subarray(at, at + 4));
    const size = b[at + 4]! | (b[at + 5]! << 8) | (b[at + 6]! << 16) | (b[at + 7]! << 24);
    if (fourcc === "EXIF") {
      const data = b.subarray(at + 8, at + 8 + size);
      // Some writers keep the JPEG segment's "Exif\0\0" in front of the TIFF header.
      return String.fromCharCode(...data.subarray(0, 4)) === "Exif" ? data.subarray(6) : data;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** IFD0's artist, copyright and description, and the EXIF IFD's original date and its offset. */
function fromTiff(tiff: Uint8Array | null): EmbeddedFields {
  if (!tiff || tiff.length < 8) return {};
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return {};
  if (view.getUint16(2, little) !== 42) return {};

  const ifd = (start: number) => {
    const entries = new Map<number, { type: number; count: number; at: number }>();
    if (start + 2 > tiff.length) return entries;
    const n = view.getUint16(start, little);
    for (let i = 0; i < n; i++) {
      const at = start + 2 + i * 12;
      if (at + 12 > tiff.length) break;
      entries.set(view.getUint16(at, little), { type: view.getUint16(at + 2, little), count: view.getUint32(at + 4, little), at: at + 8 });
    }
    return entries;
  };
  const ascii = (entry: { type: number; count: number; at: number } | undefined) => {
    if (!entry || entry.type !== 2 || entry.count === 0) return undefined;
    const from = entry.count <= 4 ? entry.at : view.getUint32(entry.at, little);
    if (from + entry.count > tiff.length) return undefined;
    return new TextDecoder().decode(tiff.subarray(from, from + entry.count));
  };

  const first = ifd(view.getUint32(4, little));
  const pointer = first.get(TAGS.exifIfd);
  const exif = pointer ? ifd(view.getUint32(pointer.at, little)) : new Map();
  const fields: EmbeddedFields = {};
  const credit = text(ascii(first.get(TAGS.artist)), 300);
  const license = text(ascii(first.get(TAGS.copyright)), 300);
  const caption = text(ascii(first.get(TAGS.description)), 2000);
  const takenAt = exifDate(text(ascii(exif.get(TAGS.taken)), 40), text(ascii(exif.get(TAGS.offset)), 10));
  if (credit) fields.credit = credit;
  if (license) fields.license = license;
  if (caption) fields.caption = caption;
  if (takenAt) fields.takenAt = takenAt;
  return fields;
}

/** EXIF's "YYYY:MM:DD HH:MM:SS" and its "+HH:MM", as an ISO date and time; undefined for a placeholder or a bad date. */
function exifDate(value: string | undefined, offset: string | undefined): string | undefined {
  const m = value && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m) return undefined;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  // A camera with no clock writes zeros, which parse to no date.
  if (Number.isNaN(Date.parse(`${local}Z`)) || m[1] === "0000") return undefined;
  return offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? `${local}${offset}` : local;
}

/** A PNG's tEXt and uncompressed iTXt chunks: Author, Copyright, Description and Creation Time. */
function fromPngText(b: Uint8Array): EmbeddedFields {
  const found: Record<string, string> = {};
  let at = 8;
  while (at + 8 <= b.length) {
    const length = ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    const data = b.subarray(at + 8, at + 8 + length);
    if (type === "IDAT" || type === "IEND") break;
    const nul = data.indexOf(0);
    if (nul > 0 && type === "tEXt") {
      found[new TextDecoder("latin1").decode(data.subarray(0, nul))] = new TextDecoder("latin1").decode(data.subarray(nul + 1));
    } else if (nul > 0 && type === "iTXt" && data[nul + 1] === 0) {
      // Keyword, compression flag and method, language tag, translated keyword, then the text.
      const lang = data.indexOf(0, nul + 3);
      const translated = lang === -1 ? -1 : data.indexOf(0, lang + 1);
      if (translated !== -1) found[new TextDecoder().decode(data.subarray(0, nul))] = new TextDecoder().decode(data.subarray(translated + 1));
    }
    at += 12 + length;
  }
  const fields: EmbeddedFields = {};
  const credit = text(found.Author, 300);
  const license = text(found.Copyright, 300);
  const caption = text(found.Description, 2000);
  const created = found["Creation Time"] ? Date.parse(found["Creation Time"]) : Number.NaN;
  if (credit) fields.credit = credit;
  if (license) fields.license = license;
  if (caption) fields.caption = caption;
  if (!Number.isNaN(created)) fields.takenAt = new Date(created).toISOString();
  return fields;
}
