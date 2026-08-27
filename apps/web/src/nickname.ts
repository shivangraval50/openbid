// Deliberately a leaf module with NO other imports -- `proxy.ts` needs
// `generateGuestNickname` but must NOT pull in `identity.ts`'s import of
// `./auth`, because that drags `next-auth` into Proxy's module graph.
// (That import chain resolves fine under `next build`/`next dev`'s
// bundler, but broke vitest's plain Node-style resolution of
// `next/server` from deep inside `next-auth/lib/env.js` -- a real,
// observed failure, not a hypothetical one.) `identity.ts` re-exports
// this for the public `generateGuestNickname` surface the brief
// specifies there.

// The brief's original generator drew from a 6x6 word pool (36 possible
// names) with no discriminator. Nicknames are load-bearing here, not
// decorative: PriceLadder names the current leader by nickname, the
// settlement line names the winner by nickname, and the leaderboard
// GROUPs by winner_nickname. By the birthday bound
// (P ~ 1 - exp(-n(n-1)/2N)), a 36-name pool passes 50% collision
// probability at n=8 guests -- an ordinary demo size -- which would make
// two different bidders indistinguishable in the room and merge their
// wins into one leaderboard row.
//
// Fix: keep the two readable words (so a human can still say the name
// out loud) and append a short random discriminator, e.g. "brisk-otter-
// 7f3" (the brief's own suggested shape). With the 6x6 word pool and a
// 3-character base-36 suffix, the space is 6 * 6 * 36^3 = 1,679,616
// combinations. At n=20 concurrent guests:
//   P(collision) ~= n(n-1) / (2N) = 190 / 1,679,616 ~= 1.13e-4 (~1 in 8,840)
// -- versus ~99.98% at the same n with the original 36-name pool.
const ADJECTIVES = ["brisk", "calm", "keen", "quiet", "swift", "wry"] as const;
const NOUNS = ["otter", "heron", "marten", "kestrel", "vole", "ibex"] as const;
const DISCRIMINATOR_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz".split("");
const DISCRIMINATOR_LENGTH = 3;

// `pool[index]` is `T | undefined` under `noUncheckedIndexedAccess` even
// though `index` is always in range for a non-empty pool -- TypeScript
// can't see that a generic `readonly T[]` is non-empty. The runtime
// guard below is genuinely unreachable for the two callers (both fixed,
// non-empty arrays), but narrows the type honestly instead of asserting
// past the checker.
function pick<T>(pool: readonly T[], rand: () => number): T {
  const index = Math.floor(rand() * pool.length) % pool.length;
  const value = pool[index];
  if (value === undefined) throw new Error("pick() called with an empty pool");
  return value;
}

function discriminator(rand: () => number): string {
  let out = "";
  for (let i = 0; i < DISCRIMINATOR_LENGTH; i++) {
    out += pick(DISCRIMINATOR_CHARS, rand);
  }
  return out;
}

export function generateGuestNickname(rand: () => number = Math.random): string {
  const adjective = pick(ADJECTIVES, rand);
  const noun = pick(NOUNS, rand);
  const suffix = discriminator(rand);
  return `${adjective}-${noun}-${suffix}`;
}
