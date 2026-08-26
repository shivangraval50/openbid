import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Cloudflare's vitest-pool-workers docs: "Using WebSockets with
        // Durable Objects is not supported with per-file storage isolation."
        // https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#websockets
        //
        // `isolatedStorage: false` removes storage isolation for the whole
        // run, not just within one test file — every test file in this
        // package shares the same underlying DO storage unless a room id
        // collides. `singleWorker: true` keeps test files from running in
        // parallel against that shared storage, and every room id in
        // test/room.test.ts is suffixed with crypto.randomUUID() so a future
        // test file can never collide with this one either.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
