// ============================================================================
// The blog's media library (global, no account: editorial pictures only)
// ============================================================================
//
// What Carrel uploads for blog posts (app/lib/carrel/media-adapter.server.ts).
// The bytes live in the MEDIA R2 bucket under the same key; this is the index
// site-api's media group answers from: its standard tables (MEDIA_LIBRARY_SQL,
// migration 0080), written only by its d1MediaStore. The Drizzle tables are
// site-api's own (./drizzle, held to that SQL in its test), for the blog's reads
// and for drizzle-kit. No merchant data is ever stored here: the only writer is
// Carrel's site-api mount, and merchant dispute evidence stays in its own
// EVIDENCE bucket and tables.
export { media, mediaChanges, mediaRevisions } from "@dustinedwards/site-api/drizzle";
