import { resolveProductFromPath, type ProductKey } from "./manifest";

export interface NavContext {
  /** The product to highlight in the switcher and to source primary links from: the URL's own product on a product
   *  page, the console ("dashboard") on a platform or admin page. */
  activeProductKey: ProductKey;
  /** True on settings/billing/help/admin: pages that aren't themselves a
   *  product, so the primary link row has nothing product-specific to show. */
  isPlatformPage: boolean;
}

/** The app shell's nav context, from the path alone. Pure: no database read. */
export function resolveNavContext(pathname: string): NavContext {
  const currentProduct = resolveProductFromPath(pathname);
  return {
    activeProductKey: currentProduct ?? "dashboard",
    isPlatformPage: currentProduct === null,
  };
}
