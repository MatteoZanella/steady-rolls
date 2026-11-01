import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.mjs"],
    environment: "happy-dom",
    setupFiles: ["tests/helpers/foundry.mjs"],
    restoreMocks: true
  }
});
