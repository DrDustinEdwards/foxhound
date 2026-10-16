// The dispute product description's limit, client-safe so the S32 page's
// textarea and the writer in apply.server.ts read one number (J06). Stripe's
// dispute evidence text fields take up to 20,000 characters.
export const DISPUTE_PRODUCT_DESCRIPTION_MAX_LENGTH = 20_000;
