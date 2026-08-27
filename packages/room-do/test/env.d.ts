import type { RoomDO, RoomEnv } from "../src/RoomDO.js";
import type { LobbyDO } from "../src/LobbyDO.js";

// `cloudflare:test`'s `env` export is typed as `ProvidedEnv`, an empty
// interface by default. Augmenting it here is what gives `env.ROOMS` and
// `env.LOBBY` (the bindings declared in wrangler.toml) a real type in the
// test files that drive `alarm()` directly via `runInDurableObject` — and,
// specifically, what makes the resulting stub's type param `RoomDO` (or
// `LobbyDO`) rather than `undefined`, which is what `runInDurableObject`
// needs to hand back a real instance instead of `unknown`.
declare module "cloudflare:test" {
  interface ProvidedEnv extends RoomEnv {
    ROOMS: DurableObjectNamespace<RoomDO>;
    LOBBY: DurableObjectNamespace<LobbyDO>;
  }
}
