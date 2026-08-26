// This package's relative specifiers are deliberately extensionless
// (`"./types"`, not `"./types.js"`), unlike every sibling package in this
// repo (`room-do`'s `./ratelimit.js`, `protocol`/`charts`'s own internal
// `.js`-suffixed imports). That convention exists so plain Node ESM --
// which requires an exact extension match, but which Node's native
// TypeScript "type stripping" specifically special-cases to also accept a
// `.js` specifier resolving to a same-named `.ts` file -- can import these
// packages' `.ts` source directly with no bundler in front of it.
//
// `auction-core` is the one package in the repo whose runtime exports (not
// just types) are actually pulled into a Turbopack bundle: `apps/web`
// transpiles it via `next.config.mjs`'s `transpilePackages`, and `LiveRoom`
// imports real functions from it (`minimumBid`, and `reduce` transitively
// via `@openbid/store`) rather than only types. Turbopack's resolver does
// not implement Node's `.js`-to-`.ts` accommodation for relative imports
// inside a transpiled package, and fails with "the module has no exports
// at all" on the `.js`-suffixed form. Every other consumer here (vitest's
// esbuild/vite-node, and wrangler/Miniflare's esbuild for `room-do`) can
// resolve either style, so this package's specifiers were changed to the
// one style every consumer -- including Turbopack -- agrees on. The
// consequence: `auction-core` can no longer be `import()`ed directly by
// plain Node against its raw source (`ERR_MODULE_NOT_FOUND` on `./types`)
// the way its siblings still can. Nothing in this repo's own tooling does
// that today (every consumer already goes through a bundler or Miniflare),
// so this is an accepted, intentional divergence, not an oversight.
export * from "./types";
export * from "./validate";
export * from "./reduce";
export * from "./close";
