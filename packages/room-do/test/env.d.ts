import type { RoomDO, RoomEnv } from "../src/RoomDO.js";

// `cloudflare:test`'s `env` export is typed as `ProvidedEnv`, an empty
// interface by default. Augmenting it here is what gives `env.ROOMS` (the
// binding declared in wrangler.toml) a real type in the test files that
// drive `alarm()` directly via `runInDurableObject` — and, specifically,
// what makes the resulting stub's type param `RoomDO` rather than
// `undefined`, which is what `runInDurableObject` needs to hand back a
// `RoomDO` instance instead of `unknown`.
declare module "cloudflare:test" {
  interface ProvidedEnv extends RoomEnv {
    ROOMS: DurableObjectNamespace<RoomDO>;
  }
}
