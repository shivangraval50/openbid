# openbid

A live multi-user auction where the server is the only authority on price. Many
browsers bid on the same lot over WebSockets; one Cloudflare Durable Object per
room decides every bid, and clients reconcile their optimistic guesses against
what it says.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript (strict) · Cloudflare
Durable Objects with SQLite storage · Neon Postgres · Zustand · Zod · Playwright

---

## The hard part

Concurrent bids on one item need a **total order**. Two people bidding 600 at the
same instant is not a race the UI can settle — someone has to be first, and
everyone has to agree who.

openbid puts one Durable Object in charge of each room, and gets the ordering
from where the code runs rather than from a lock:

- A Durable Object is a **single instance with a single thread**. For a given
  room id there is exactly one `RoomDO` in the world (`env.ROOMS.idFromName(roomId)`,
  [`packages/room-do/src/index.ts`](packages/room-do/src/index.ts)), and the
  runtime delivers messages to it one at a time.
- The decide-and-commit path is **synchronous end to end**. In the `bid` case of
  [`RoomDO.webSocketMessage`](packages/room-do/src/RoomDO.ts), there is no `await`
  between reading state, calling `validateBid`, appending the event, and
  broadcasting it. The first `await` comes two lines later, re-arming the expiry
  alarm.

So bid ordering is serialised **by construction**. The second of two simultaneous
bids cannot observe stale state, because it does not start running until the
first has already appended its event and broadcast it. There is no distributed
lock, no compare-and-swap, no transaction retry loop.

Being precise about the limits of that claim: it is not "Durable Objects make
concurrency go away." A DO *does* yield at every `await`, and a handler that
awaited in the middle of a decision would be right back to needing its own care.
The guarantee here comes from that specific section having no yield point in it —
which is a property worth keeping, and is the reason the auction rules are pure
functions with no I/O to await in the first place.

`validateBid` is called from exactly one non-test place in the repo
(`RoomDO.ts:340`). The lobby Durable Object caches prices for the room list and
never evaluates a rule; Postgres only ever sees auctions that have already ended.

## Architecture

```
        browsers (many)                    Cloudflare Worker                  Neon Postgres
 ┌──────────────────────────┐      ┌──────────────────────────────┐      ┌──────────────────┐
 │ Next.js App Router       │      │ router  (src/index.ts)       │      │ completed_       │
 │  (Vercel)                │      │   │                          │      │ auctions         │
 │                          │      │   │                          │      │  · starting/     │
 │  RoomPage (server)  ─────┼─HTTP─┼──►├─ RoomDO "ming-vase"      │      │    winning price │
 │   GET /rooms/:id/snapshot│      │   │   · SQLite event log     │      │  · bid_log jsonb │
 │                          │      │   │   · hibernatable WS      │      └──────────────────┘
 │  LiveRoom (client)       │      │   │   · alarm = the clock    │              ▲
 │   Zustand store  ◄───────┼─ WS ─┼──►│   · sole authority       │──────────────┘
 │    · optimistic layer    │      │   │                          │   on settle, via an
 │    · server-corrected    │      │   ├─ RoomDO "other-lot"      │   outbox table in the
 │      clock               │      │   │                          │   DO, retried on the
 │                          │      │   └─ LobbyDO (singleton)     │   next alarm until it
 │  /replay/:id  ───────────┼──────┼───┐   · room registry        │   lands
 │  /leaderboard ───────────┼──────┼─┐ │   · cached prices        │
 └──────────────────────────┘      └─┼─┼──────────────────────────┘
                                     │ │
                                     └─┴─────────── SQL (read-only) ─────────────►
```

### One bid, click to broadcast

1. **Click.** `BidForm` validates locally against the current minimum, then
   `LiveRoom` calls `placeOptimisticBid(amount)`. The store mints a
   client-generated `clientSeq`, pushes `{clientSeq, amount}` onto `pending`, and
   the displayed price jumps immediately — `selectDisplayPrice` takes
   `max(server price, best pending)`.
2. **Send.** `{ t: "bid", clientSeq, amount }` goes over the socket, Zod-typed by
   [`@openbid/protocol`](packages/protocol/src/index.ts).
3. **Decide.** The room's DO takes a token from that connection's rate-limit
   bucket (10 per 10s, stored in the socket's serialized attachment so it
   survives hibernation), then calls `validateBid(state, cmd)`. That returns
   *either* a rejection reason *or* an event — it never mutates anything.
4. **Commit.** The event is appended to the DO's SQLite `events` table, which
   assigns the authoritative `serverSeq`. `reduce` folds it into cached state.
5. **Broadcast, then ack.** The `delta` goes to *every* socket in the room
   including the bidder's own, and only then does the bidder get
   `{ t: "ack", clientSeq, seq }`. That order matters: it means the
   authoritative price has always landed before the optimistic one is cleared,
   so there is no frame where the bidder's own winning bid appears to vanish.
   (That was a real bug, fixed in `5b86961`.)
6. **Losers.** Anyone whose bid lost gets `{ t: "reject", clientSeq, reason }`.
   The store drops *only* that `clientSeq` from `pending`, so sibling optimistic
   bids survive, and the price falls back to the server's.

Steps 3–5 are the synchronous section described above.

## Optimistic UI, and how it reconciles

The client shows your bid before the server has seen it, and is always prepared
to be wrong.

| | client-generated | server-generated |
|---|---|---|
| identifier | `clientSeq` (monotonic per session) | `serverSeq` (SQLite `AUTOINCREMENT`) |
| meaning | "this is my Nth attempt" | "this is the Nth thing that really happened" |
| used for | matching acks/rejects to pending bids | ordering, replay, resume position |

- **Accepted** → the `delta` arrives and `reduce`s into `server`; the `ack`
  removes the entry from `pending`. The optimistic value stops mattering because
  the real one has overtaken it.
- **Rejected** → `pending` loses that one entry and the displayed price
  immediately reverts to the server's. The reason (`TOO_LOW`,
  `INSUFFICIENT_BUDGET`, `RATE_LIMITED`, `AUCTION_CLOSED`) is surfaced as copy in
  the form.
- **`lastSeenSeq` only ever advances from a `delta`, never from an `ack`.** An
  ack is not evidence you applied the event. Advancing on acks is what caused the
  bug in step 5; the reasoning is written out in
  [`packages/store/src/index.ts`](packages/store/src/index.ts).
- **Reconnect** sends `{ t: "hello", lastSeenSeq }` and the DO replays exactly
  the gap — or sends a fresh snapshot instead if you are more than 500 events
  behind. Backoff is `min(30s, 500ms · 2^attempt)`.
- **The clock is the server's.** Client code never calls `Date.now()` for auction
  timing. A ping/pong every 5s (and immediately on connect) measures the offset
  as `serverTime + rtt/2 − clientRecv`, and countdowns render against
  `Date.now() + offset`.

## Event sourcing: decide and apply are different functions

[`@openbid/auction-core`](packages/auction-core/src) is pure — no I/O, no
platform imports, no clock reads. It splits the two halves of a state machine
that are usually mashed together:

```ts
// decide: current state + a command -> a rejection, or an event. Chooses.
validateBid(state, cmd): { ok: true; event } | { ok: false; reason }

// apply: current state + an event -> next state. Trusts, and never rejects.
reduce(state, event): AuctionState
```

Why the split earns its keep:

- **The live path** validates, then applies.
- **Replay** only applies. `/replay/[id]` reads the archived `bid_log` out of
  Postgres and folds it through the *same* `reduce`, which makes replay a pure
  fold — `events.slice(0, n).reduce((s, e) => reduce(s, e), initialState(config))`.
  Scrubbing to position *n* is just that fold with a different *n*; there is no
  undo logic and no second implementation of the rules to drift out of sync.
- **The determinism test is not circular.** If one function both decided and
  applied, "replay produces the same state" would be comparing a fold to itself.
  Because replay never calls `validateBid`, a replay test genuinely exercises a
  different code path than the one that wrote the log.
- Time-dependence lives entirely on the decide side. `reduce` reads no clock, so
  a fold is reproducible years later.

The DO holds no separate mutable copy of the auction: `RoomDO.state()` rebuilds
from the event log on demand, which is why eviction and hibernation need no extra
bookkeeping.

## What else is in here

- **The clock is server-owned.** A DO alarm — not a client timer — closes the
  auction. Anti-snipe: a bid landing within 10s of the deadline moves the
  deadline to 15s *after that bid*, and re-arms the alarm. If an alarm fires
  early because an extension landed under it, it re-arms instead of closing.
- **Settlement survives Postgres being down.** On close, the record goes into an
  `outbox` table inside the DO's own SQLite and is drained on the next alarm,
  retried until it lands. The insert is `ON CONFLICT (room_id) DO NOTHING`, so
  blind retries can't duplicate a row.
- **Neon holds only completed auctions.** A live room list can't be a Postgres
  table when Postgres never sees live rooms, so `LobbyDO` is the registry.
- **Identity.** Guests can bid without signing in — `proxy.ts` assigns a
  nickname cookie on first request. GitHub sign-in (Auth.js, JWT sessions, no
  database adapter) only adds a persistent leaderboard identity. Signed-in names
  use GitHub's unique `login`, not the free-text display name, so two people
  called "Alex" don't merge on the leaderboard.
- **Leaderboard** ranks by wins, tie-broken by lowest total overpay above the
  starting price. That is deliberately *not* the spec's original "budget
  surplus": the archive stores starting and winning price, not each room's
  budget, so surplus isn't computable from what's actually stored.
- **Commentary.** When a room settles it asks `/api/bot` for a one-line
  summary, behind a provider port with Anthropic and Gemini adapters. Every
  failure renders nothing at all.

## Running it locally

Node 22 and npm (there is no pnpm here).

```bash
npm install
cp apps/web/.env.example apps/web/.env.local   # set AUTH_SECRET to any string
```

Two processes, two terminals:

```bash
# terminal 1 — the Worker + Durable Objects, locally on :8787
npx wrangler dev --config packages/room-do/wrangler.toml

# terminal 2 — the Next.js app on :3000
npm run dev --workspace @openbid/web
```

Open <http://localhost:3000>, create a lot, then open the room URL in a second
browser profile (or an incognito window — a separate cookie jar means a separate
guest identity) and race a bid.

Every credential except `AUTH_SECRET` is optional, and each missing one degrades
one feature rather than breaking the app:

| unset | what stops working |
|---|---|
| `DATABASE_URL` | settlement stays queued in the DO's outbox; leaderboard and replay come up empty |
| `AUTH_GITHUB_ID` / `_SECRET` | GitHub sign-in; guest bidding is unaffected |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | post-settlement commentary renders nothing |

Bidding, ordering, the countdown, anti-snipe, reconnect and the price chart all
work with none of them set.

## Tests

```bash
npm test                                     # 335 tests, 38 files
npm run typecheck                            # apps/web + shared packages
npm run typecheck --workspace @openbid/room-do   # workers-types needs its own pass
npm run e2e                                  # 3 Playwright tests, 2 spec files
```

`npm test` is one vitest run over four different kinds of test:

- **Unit** across the packages, including 26 on the store's reconciliation rules
  and 37 on the wire contract.
- **Property-based** (`fast-check`) on the auction rules — 8 properties covering
  bid ordering, budget, and clock invariants.
- **Durable Object integration** — 49 tests in `packages/room-do`, run inside real
  `workerd` via `@cloudflare/vitest-pool-workers`, not against a mock. These
  drive actual WebSockets, fire real alarms, and assert on the DO's own SQLite.
- **Component** on the React surface with Testing Library, including SSR-markup
  assertions via `renderToStaticMarkup`.

### What the two-browser race test actually proves

[`apps/web/e2e/simultaneous-bid.spec.ts`](apps/web/e2e/simultaneous-bid.spec.ts)
opens two separate browser contexts — separate cookie jars, so two genuinely
distinct bidders — against a real `wrangler dev` Worker, and clicks both "place
bid" buttons for the **same amount** in one `Promise.all`. It then asserts:

1. Exactly one of the two shows the server's own rejection copy. This is checked
   against that exact string, not "any alert is visible", because `BidForm` also
   renders an alert for its own local `amount < minimum` check — which fires with
   no network round trip at all. Only the server's copy proves the *DO*
   adjudicated the pair rather than one client pre-empting itself.
2. Neither page still has an unconfirmed optimistic price (`pending` count 0).
3. **Both** pages, including the winner's, display the same final number.

Point 3 is there because a converge check that only looked at the loser would
have passed while a real bug was live: the DO acked before broadcasting, the
store advanced `lastSeenSeq` on the ack, and the winner's own client then
discarded its own winning delta as a duplicate.

Being straight about what it does *not* prove: the harness cannot force two
independent browser contexts to reach the DO in the same tick every time. When a
bidder's client pre-empts itself locally, that attempt is *inconclusive*, and the
test retries with a fresh pair (up to five times) rather than passing. A retry is
only taken when no server-adjudicated outcome was reached at all — never when the
"wrong" side won — so it can't launder a genuine failure to serialise. If all
five attempts pre-empt locally, the test fails loudly.

## Limitations

Real ones, not modesty:

- **`/api/bot` rate limiting is per-instance and best-effort.** It's an
  in-process `Map` (5 requests / 60s / caller), so on serverless each warm
  instance has its own, and a cold start begins with an empty one. It stops one
  hot client hammering one instance; it is not a global cap. A durable limiter
  would need an external store, which this deliberately doesn't have.
- **Commentary can silently no-op in a busy room.** Every client in a room
  requests it independently when the auction settles, so more than five bidders
  behind one NAT will see some requests 429 and simply render nothing. Fine for
  decoration; it would not be fine for anything load-bearing.
- **Commentary is not cached.** It is requested per client, and again on every
  later visit to an already-settled room, so it costs one provider call per view
  rather than one per auction. The right fix is to store the line with the
  settlement record; that isn't done.
- **The key is a header.** On Vercel the limiter keys on
  `x-vercel-forwarded-for`, which the edge sets; off Vercel it falls back to
  `x-forwarded-for`, which any client can forge. Nothing in the code can fix that
  without a trusted-proxy boundary this app doesn't have.
- **openbid has no CSS.** Not a line. Every task in this project went into the
  ordering model, the reconciliation, and the tests; the UI is unstyled browser
  defaults. It is fully functional and completely plain.
- **Prediction-market mode is deliberately out of scope.** The original idea
  offered "auction *or* prediction market". A probability series is a different
  state machine and would have diluted both, so this is auction-only by decision,
  not by omission.
- **No bid history UI, and no "you won" indicator.** Participant ids are
  per-connection and reassigned on reconnect, so the client cannot honestly tell
  a reconnected winner that they won. Identity is by nickname only; the outcome
  line names the winner rather than addressing you.
- **The lobby list is unbounded** and never evicts closed rooms, and the DO's
  event log is never compacted. Neither matters at demo scale; both would at real
  scale.
- **A flaky test, diagnosed and fixed.** `packages/room-do/test/settlement.test.ts`'s
  outbox-payload case failed intermittently under `npm test`'s full-suite
  concurrency (expected 1 queued record, saw 0) and was reproduced on demand (1
  failure in 8 full-suite runs). Root cause: the test's own margin between
  waiting out the auction's real deadline and manually firing the DO's `alarm()`
  was only 20ms, which the round trip into the DO's isolate could occasionally
  outrun under CPU contention from sibling test projects, so `alarm()`'s
  `Date.now() >= endsAtMs` check would occasionally see the deadline as not yet
  passed and take the "re-arm" branch instead of closing. Widened the margin to
  400ms; confirmed with 30 isolated re-runs and 10 additional full-suite re-runs,
  all green.
- **`npm audit` reports 1 critical / 7 high / 3 moderate, all in dev-only
  tooling.** Every flagged package (`esbuild`, `sharp`, `undici`, `ws`, `vite`,
  `vite-node`, `vitest`, `wrangler`, `miniflare`, `@cloudflare/vitest-pool-workers`)
  is a transitive dependency of the Cloudflare Workers test/dev toolchain or the
  Vite/Vitest test runner — nothing in `dependencies` (only `devDependencies`)
  is affected, and none of it runs against untrusted input in production.
  `npm audit fix` (no `--force`) resolves nothing: `@cloudflare/vitest-pool-workers@0.12.21`
  pins exact versions of `esbuild`, `wrangler`, and `miniflare` in its own
  manifest, so npm cannot bump them independently. The only path npm offers is
  `@cloudflare/vitest-pool-workers@0.22.0`, which requires `vitest@^4.1.0` — a
  major-version bump of the test runner backing all 369 tests in this repo,
  including the Durable Object replay/settlement suite, for a toolchain that
  never processes untrusted input. Left unfixed as an accepted, documented risk
  rather than taking a forced major bump to clear a number.

## Layout

```
apps/web              Next.js App Router — lobby, room, replay, leaderboard, /api/bot
packages/auction-core  pure rules: validateBid (decide), reduce (apply), closeAuction
packages/protocol      Zod wire contract + every cross-boundary shape
packages/room-do       RoomDO (authority), LobbyDO (registry), Neon archive
packages/store         Zustand store: optimistic layer, reconciliation, clock
packages/charts        canvas price series over d3 scales
packages/llm           provider port + Anthropic/Gemini adapters
```

Deploying it is [`DEPLOY.md`](DEPLOY.md). Design notes and the implementation plan
are in [`docs/superpowers`](docs/superpowers).
