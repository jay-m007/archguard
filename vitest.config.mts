import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000, // the action tests spawn git many times, which is slow on Windows
    include: ["packages/*/test/**/*.test.ts", "action/test/**/*.test.ts"],
  },
});
