import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Cloudflare's vitest-pool-workers docs: "Using WebSockets with Durable
        // Objects is not supported with per-file storage isolation." Every test
        // in test/room.test.ts uses its own room id, so sharing storage within
        // this file is safe.
        // https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#websockets
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
