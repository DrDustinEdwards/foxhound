import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// The Stripe write list is one constant (app/lib/marketing/trust-copy.ts). A page that retypes a clause of it can fall behind the
// code, as the refund once did, so no other file under app/ may contain one.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

it("states the Stripe write list only in trust-copy.ts", () => {
  const retyped = sources("app").filter(
    (path) =>
      !path.endsWith("trust-copy.ts") &&
      /closing a dispute at Stripe|opening a Stripe checkout when/i.test(readFileSync(path, "utf8")),
  );
  expect(retyped).toEqual([]);
});
