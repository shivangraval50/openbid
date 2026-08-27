import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // these tests share auction rooms
  // The installed default reporter in CI is "dot" (Playwright detects
  // `process.env.CI` and switches away from "list"), which never writes
  // `apps/web/playwright-report/`. The CI job's `upload-artifact@v4` step
  // uploads that exact path on failure, so without an explicit "html"
  // reporter here it silently uploads nothing -- and `upload-artifact@v4`
  // defaults to warning rather than failing when its glob matches zero
  // files, so that would never even show up as a CI error. "list" is kept
  // alongside "html" for readable terminal output on every run, local or
  // CI, not just on failure.
  reporter: [["list"], ["html", { open: "never" }]],
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
