/**
 * Bound on `sender_name`, in a CLIENT-SAFE module on purpose. The build catches this structurally
 * ("Server-only module referenced by client") and it caught this constant.
 */
export const SENDER_NAME_MAX_LENGTH = 80;
