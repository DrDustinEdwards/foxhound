import { eq } from "drizzle-orm";

import { accounts, type Db } from "~/db";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";

import { isProductKey, resolveProductFromPath, type ProductKey } from "./manifest";

export interface NavContext {
  /** The product to highlight in the switcher and to source primary links
   *  from: the URL's own product on a product page, or the account's
   *  last-visited product (context fallback) on a platform/admin page. */
  activeProductKey: ProductKey;
  /** True on settings/billing/help/admin: pages that aren't themselves a
   *  product, so the primary link row has nothing product-specific to show. */
  isPlatformPage: boolean;
  intelligenceEntitled: boolean;
}

/**
 * Resolves nav context ONCE per app-shell request (task Part 2 rule 1: zero
 * extra DB queries in the nav component itself). On a product page this is a
 * single write (persisting last_visited_product, no read needed since the
 * product is already known from the URL) plus the entitlement check; on a
 * platform page it's a single read (the fallback context) plus the same
 * entitlement check. Never both.
 */
export async function resolveNavContext(db: Db, accountId: string, pathname: string): Promise<NavContext> {
  const currentProduct = resolveProductFromPath(pathname);

  const [lastVisitedProduct, intelligenceEntitled] = await Promise.all([
    currentProduct
      ? Promise.resolve(null)
      : db
          .select({ lastVisitedProduct: accounts.lastVisitedProduct })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1)
          .then((rows) => rows[0]?.lastVisitedProduct ?? null),
    isIntelligenceEntitled(db, accountId),
  ]);

  if (currentProduct) {
    await db.update(accounts).set({ lastVisitedProduct: currentProduct }).where(eq(accounts.id, accountId));
  }

  const activeProductKey: ProductKey =
    currentProduct ?? (isProductKey(lastVisitedProduct) ? lastVisitedProduct : "dashboard");

  return { activeProductKey, isPlatformPage: currentProduct === null, intelligenceEntitled };
}
