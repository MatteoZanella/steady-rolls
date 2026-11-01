import { defineConfig } from "vitest/config";

/** Tests of the built package in dist/ (npm run build first). */
export default defineConfig({
  test: {
    include: ["tests/dist/*.test.mjs"],
    environment: "node",
    setupFiles: ["tests/helpers/foundry.mjs"],
    restoreMocks: true
  }
});
