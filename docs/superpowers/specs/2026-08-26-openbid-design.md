# openbid — Design

**Date:** 2026-08-26
**Status:** Approved, pre-implementation
**Program context:** Project 1 of 3 in a front-end-forward portfolio program (`openbid`, then `diffsync`, then `rag-console`). Repo names are placeholders.

## Why this project exists

Of 22 public repos, 19 are Python/C++/OCaml systems work; none demonstrate the Next.js App Router, server components, TypeScript-end-to-end, real-time front-end state management, or automated front-end testing that 2026 front-end hiring screens for. `openbid` is the first of three projects closing that gap.

It is also deliberately first in build order despite being the least complex of the three: it exercises every layer of the shared stack (Vercel, Cloudflare Durable Objects, Neon, Auth.js, Vitest/RTL, Playwright, GitHub Actions, portfolio entry) on the simplest problem. Discovering a platform integration failure here costs days; discovering it mid-CRDT in `diffsync` costs weeks.

## Goals

- A live, multi-user English ascending-price auction a stranger can play in under 60 seconds from a portfolio link.
- Optimistic client bids reconciled against authoritative server state, with visible, correct rollback under contention.
- A server-authoritative auction clock that feels right (drift-corrected), including an anti-snipe extension rule.
- Deterministic replay of any completed auction, driven by the same reducer as the live game.
- A test suite whose headline case is two users bidding in the same instant.

## Non-goals

- **Prediction-market mode.** The originating idea offered "auction *or* prediction market"; this spec is auction-only. A probability-series market is a different state machine and would dilute both.
- Real money, real payments, or any custody of funds.
- Multiple sequential lots per room. One room = one lot. The leaderboard aggregates across completed rooms instead, ranking signed-in participants by auctions won, tie-broken by total budget surplus (starting budget minus winning price, summed across wins).
- Mobile-native apps. Responsive web only.
- Horizontal scale beyond free-tier limits. This is a portfolio artifact, and the honest framing is that a single DO per room is the correct design at this scale, not a compromise.

## Stack and hosting

Chosen to be genuinely $0 at portfolio traffic. Free-tier reality verified 2026-08-26.

| Layer | Choice | Notes |
|---|---|---|
| Web app | Next.js (App Router) + TypeScript on Vercel Hobby | Server components + server actions |
| Real-time authority | Cloudflare Workers + Durable Objects (SQLite-backed) | Workers Free plan supports SQLite-backed DOs; free-plan users are not charged for SQLite storage after the Jan 2026 billing change. KV-backed DOs are paid-only — must use SQLite backing. |
| Archive / leaderboard | Neon Postgres free tier | Completed auctions only |
| Auth | Auth.js + GitHub OAuth | Free, no vendor tier to age out of |
| Client state | Zustand | Optimistic layer lives here |
| Charts | Hand-rolled canvas over D3 scales | No chart library; Recharts re-renders SVG per tick and stutters under a live feed |
| Unit / component tests | Vitest + React Testing Library | |
| E2E | Playwright | Multi-browser-context tests; Cypress cannot drive two independent users |
| CI | GitHub Actions | Free on public repos |

**Rejected:** Fly.io and Railway (no ongoing free tier as of 2026 — Fly's $5 allowance is gone for new orgs, Railway's ended 2023). Render's free tier spins down after 15 min with 30–60 s cold starts, which breaks the click-a-link demo. A managed realtime SDK (Liveblocks/Ably) was rejected because it would hand off the one hard part.

## Architecture

One Durable Object per auction room is the sole authority for that room. Because a DO is single-threaded, bid ordering is serialized by construction — no distributed locking and no optimistic-concurrency retry loop. This is the project's central design claim and should survive interview questioning.

Neon holds only completed auctions. Postgres being unavailable therefore cannot corrupt a live auction.

### Components

One repository, npm workspaces, with each component below as a workspace under `packages/` except `web`, which is the Next.js app at `apps/web`. Nothing is published to a registry; workspaces exist for boundary enforcement and independent testing, not distribution. `npm` is the package manager (`pnpm` is not installed on the development machine).

Each component is independently understandable and testable.

- **`protocol`** — Zod schemas for every WebSocket message, imported by both client and DO. Single source of truth for the wire contract; a schema change fails the build on both sides.
- **`auction-core`** — pure `(state, event) => state` reducer plus validation rules. Zero I/O, zero platform imports. Driven by either the live socket or an archived bid log, which is what makes replay nearly free and proves the state machine is pure.
- **`room-do`** — the Durable Object. Owns WebSocket connections, alarms, and the SQLite bid log. Deliberately thin: it validates nothing itself, delegating every rule to `auction-core`.
- **`web`** — Next.js app. Server components render the shell, room list, and opening snapshot; client components own the live surface.
- **`store`** — Zustand store plus optimistic reconciliation.
- **`charts`** — canvas price-over-time series and an RTT/latency indicator.

### Data flow

1. Client requests a room page. A server component reads the room's current snapshot and SSRs it, so first paint shows real state.
2. Client opens a WebSocket to the room's DO, carrying `lastSeenSeq` (0 on first connect, or the last seq it processed on reconnect).
3. DO replays events since `lastSeenSeq` from its SQLite log. If the gap exceeds 500 events, it sends a full snapshot instead.
4. Live deltas stream thereafter, each carrying a monotonic per-room `serverSeq`.
5. A local bid applies to the UI immediately under a client-generated `clientSeq`. The server echo carries that `clientSeq` alongside the authoritative `serverSeq`; reconciliation rolls back any optimistic entry the server rejected.

## Auction rules

- **Format:** English ascending-price, single lot per room.
- **Room parameters:** item name, starting price, minimum increment, initial duration, anti-snipe window, anti-snipe extension.
- **Participant budget:** each participant receives a fixed starting budget on joining a room, so `INSUFFICIENT_BUDGET` is a real rejection path rather than a decorative one.
- **Anti-snipe:** a valid bid landing inside the anti-snipe window extends the clock by the extension amount. Core, not optional — it is the rule that makes the clock state machine worth testing.
- **Settlement:** at clock expiry the DO computes the winner, writes a settlement record plus the full bid log to Neon, and marks the room closed.

## Access model

Guest access is permitted: an unauthenticated visitor receives a generated nickname and can bid in any room. GitHub sign-in adds exactly one thing — a persistent identity that accrues leaderboard results across sessions. There is no room type that requires authentication.

*Stated assumption:* requiring OAuth before a stranger can place a single bid would defeat the 60-second-demo goal that justifies the project. If persistent identity for all bidding is preferred, this is the one decision to revisit.

## Clock handling

The server owns the clock; the client never trusts its own. On connect and periodically thereafter the client measures round-trip time and derives a server-time offset, then renders a smoothed countdown against that offset. Clock transitions (`going`, `gone`) are driven by DO alarms, not by client timers — the client's countdown is presentation only.

## Error handling

| Condition | Behavior |
|---|---|
| Rejected bid | Typed reason surfaced inline at the bid form: `TOO_LOW`, `AUCTION_CLOSED`, `RATE_LIMITED`, `INSUFFICIENT_BUDGET`. Optimistic entry rolled back. No generic toast. |
| WebSocket disconnect | Exponential-backoff reconnect, resuming from `lastSeenSeq`. UI shows a degraded-connection state rather than stale-looking live data. |
| Sequence gap too large | DO sends a full snapshot; client discards local optimistic state and rebases. |
| DO eviction mid-auction | Rehydrate state from the SQLite bid log on next access; re-arm the expiry alarm. |
| Neon unavailable at settlement | Settlement record queued in DO storage, retried on an alarm. Auction integrity does not depend on Postgres. |
| Abusive bid rate | Per-connection rate limit (10 bids / 10 s). Protects the free tier and is an honest anti-abuse answer. |

## Testing strategy

- **`auction-core` property tests** — for any interleaving of valid bids, the recorded highest bid equals the maximum submitted; anti-snipe extension invariants hold; budget can never go negative.
- **`auction-core` unit tests** — one per rejection reason and one per clock transition.
- **RTL** — bid form, price ladder, countdown, connection-state banner, and every rejection state.
- **Playwright, multi-context (headline test)** — two browser contexts submit bids in the same instant; exactly one wins and both UIs converge on identical final state.
- **Playwright reconnect test** — kill and restore a socket mid-auction; the client rebases without losing or duplicating bids.
- **Replay determinism test** — feeding an archived bid log through `auction-core` yields a final state equal to the recorded settlement.

CI runs typecheck, lint, unit, RTL, and headless Playwright on every pull request. The worker deploys via `wrangler` on merge to `main`; the web app deploys via Vercel's GitHub integration.

## Local development

`wrangler dev` (Miniflare) hosts the DO locally; `next dev` hosts the web app; a Neon development branch backs the archive. No Docker requirement.

## LLM integration

An LLM-driven bot opponent with a configurable personality, plus post-auction commentary, routed through the shared `LlmProvider` port: an `@anthropic-ai/sdk` adapter targeting `claude-opus-5` for development, and a free-tier provider adapter selected by environment variable for the public deploy. Both adapters are held to the same contract tests, so the swap is proven rather than asserted.

The bot bids through the same validated path as a human — no privileged entry point.

**Sequencing:** this is the final task, not an early one. The AI angle is the weakest of the three projects; its main value here is giving the free-tier adapter a second consumer before `rag-console` depends on it heavily.

## Portfolio integration

The portfolio at `~/Downloads/portfolio-site/portfolio-site` is a Vite + React 18 + Tailwind app deployed to the Vercel project `portfolio-site` and is **currently not under version control**. Before any entry is added: `git init`, push to a `portfolio-site` GitHub repo, and connect the Vercel project to it.

The existing embedded demos (`MonkeyRepl`, `OrderBookViz`) work in-page because they are pure in-browser TypeScript ports. `openbid` is server-backed and cannot be embedded that way. Its entry is a new numbered section containing a short looping screen capture, a "Try it live" link to the deployed app, and a repo link. Iframing a live real-time app into the portfolio page is explicitly rejected as slow and fragile.

## Out of scope for this spec

`diffsync` and `rag-console` each get their own design and implementation-plan cycle. The only shared artifact this spec commits to is the `LlmProvider` port, which `openbid` is the first to consume.
