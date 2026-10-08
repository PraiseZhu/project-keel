import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // e2e runs real git fixtures (~3.5s alone); the 5s default times out under full parallel load.
    testTimeout: 20_000,
  },
});
