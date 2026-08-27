import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // these tests share auction rooms
  use: { baseURL: "http://127.0.0.1:3000", trace: "retain-on-failure" },
  webServer: [
    {
      command: "npx wrangler dev --port 8787",
      cwd: "../../packages/room-do",
      url: "http://127.0.0.1:8787/lobby/rooms",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "npm run dev -- --port 3000",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        ROOMS_BASE_URL: "http://127.0.0.1:8787",
        NEXT_PUBLIC_ROOMS_BASE_URL: "http://127.0.0.1:8787",
        AUTH_SECRET: "e2e-not-a-real-secret",
      },
    },
  ],
});
