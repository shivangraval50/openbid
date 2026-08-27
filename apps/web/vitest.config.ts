import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Mirrors tsconfig.json's "@/*" path mapping so server actions and
  // components that import via the "@/..." alias (the Next.js convention
  // used throughout this app) resolve the same way under vitest as they
  // do under `next build`.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Playwright owns `e2e/**` (its own `*.spec.ts` files, run via
    // `npm run e2e`, never vitest); without this, vitest's default
    // `*.spec.ts` include pattern picks them up too and its Node-based
    // runner then imports `@playwright/test`, which refuses to construct a
    // `test()` outside the Playwright runner.
    exclude: [...defaultExclude, "e2e/**"],
  },
});
