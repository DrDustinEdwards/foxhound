import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    // Mirror the tsconfig `~/*` -> ./app/* alias so tests can import app modules.
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
});
