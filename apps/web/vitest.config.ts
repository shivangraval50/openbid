import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
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
  test: { environment: "jsdom", globals: true },
});
