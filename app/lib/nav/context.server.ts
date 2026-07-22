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

/** Narrower than the full Cloudflare ExecutionContext: only the one method
 *  this module needs, which keeps it trivially mockable in tests. */
type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Resolves nav context ONCE per app-shell request (task Part 2 rule 1: zero
 * extra DB queries in the nav component itself). Always reads
 * last_visited_product alongside the entitlement check (nav assessment F-1:
 * this used to be read-on-platform-page-only, write-on-product-page-only;
 * that meant a blind write on EVERY product-page GET, which both violated
 * the demo read-only invariant - a demo visitor's browsing bled
 * last_visited_product across concurrent demo visitors - and was unbounded
 * write amplification for a value that rarely changes). The one added read
 * is the price of eliminating that.
 *
 * Writes only when ALL of: the page has a current product, it differs from
 * the stored value, and the caller is not the demo account. The write is
 * deferred via waitUntil (not awaited) so it never adds to navigation
 * latency; callers pass ctx.waitUntil directly (foxhound-nav-assessment.md
 * F-1, TASK-foxhound-nav-loader-write.md).
 */
export async function resolveNavContext(
  db: Db,
  accountId: string,
  pathname: string,
  isDemo: boolean,
  waitUntil: WaitUntil,
): Promise<NavContext> {
  const currentProduct = resolveProductFromPath(pathname);

  const [lastVisitedProduct, intelligenceEntitled] = await Promise.all([
    db
      .select({ lastVisitedProduct: accounts.lastVisitedProduct })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
      .then((rows) => rows[0]?.lastVisitedProduct ?? null),
    isIntelligenceEntitled(db, accountId),
  ]);

  if (currentProduct && currentProduct !== lastVisitedProduct && !isDemo) {
    waitUntil(
      Promise.resolve(
        db.update(accounts).set({ lastVisitedProduct: currentProduct }).where(eq(accounts.id, accountId)),
      ),
    );
  }

  const activeProductKey: ProductKey =
    currentProduct ?? (isProductKey(lastVisitedProduct) ? lastVisitedProduct : "dashboard");

  return { activeProductKey, isPlatformPage: currentProduct === null, intelligenceEntitled };
}
