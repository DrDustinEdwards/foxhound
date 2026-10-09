import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // A StrykerJS sandbox (stryker.config.mjs) is a full copy of the repo, tests
    // included; an interrupted run leaves it behind.
    exclude: [...configDefaults.exclude, ".stryker-tmp/**"],
  },
  resolve: {
    // Mirror the tsconfig `~/*` -> ./app/* alias so tests can import app modules.
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
});
