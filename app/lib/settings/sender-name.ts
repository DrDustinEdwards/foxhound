/**
 * Bound on `sender_name`, in a CLIENT-SAFE module on purpose.
 *
 * It lives here rather than in persist.server.ts because the settings form
 * renders `maxLength={SENDER_NAME_MAX_LENGTH}` in the component, and importing
 * it from a `.server` module drags drizzle and the table objects into that
 * route's client chunk. The build catches this structurally ("Server-only
 * module referenced by client") and it caught this constant. Same split as
 * app/lib/settings/audit-settings.ts.
 *
 * LEGACY HAS NO BOUND: `EmailSection.tsx` renders a bare `type="text"` with no
 * maxLength and no pattern, and `settings/update/route.ts` writes
 * `formData.get('sender_name')?.toString() || null` with no validation at all.
 * 80 is this session's brief, recorded as an ADDITION rather than a port.
 *
 * It is not arbitrary: this value becomes the display name of an RFC 5322 From
 * header on every recovery email. `fromDisplayName` in app/lib/email/send.ts
 * already strips quotes and CR/LF, so header INJECTION is handled without a
 * length rule; the bound is about a display name mail clients truncate anyway,
 * not about safety.
 */
export const SENDER_NAME_MAX_LENGTH = 80;
