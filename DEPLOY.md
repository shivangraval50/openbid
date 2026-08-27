# Deploying openbid

A runbook, in order. Every step needs a credential or an interactive browser
login that only you can complete, so **none of this has been executed** — see
[Verification status](#verification-status) at the bottom for exactly what is
tested and what is not.

Two deploys, and they reference each other:

| | deploy | needs to know |
|---|---|---|
| **Worker** | `packages/room-do` → Cloudflare | the Neon connection string |
| **Web app** | `apps/web` → Vercel | the Worker's URL, plus Neon, GitHub OAuth, Gemini |

The Worker does not need to know the web app's URL. The web app must know the
Worker's, in **two** variables — see [step 6](#6-deploy-the-web-app-to-vercel).

---

## 0. Prerequisites

```bash
node -v          # must be 22.x  (.nvmrc pins 22)
npm ci           # never pnpm
npm test         # 398 tests should pass before you deploy anything
```

Accounts needed: Cloudflare, Neon, Vercel, GitHub, and Google AI Studio for the
free-tier Gemini key.

**On the Cloudflare plan:** the Workers *Free* plan is enough. Per
[Cloudflare's Durable Objects pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/),
"Workers Free plan: Only Durable Objects with SQLite storage backend are
available" — and this Worker uses exactly that (`new_sqlite_classes`, because
both classes use `ctx.storage.sql`). The key-value storage backend is the one
that needs a paid plan, and nothing here uses it. Free-plan daily allowances
apply. Checked against that page rather than assumed; re-check it, since vendor
plans move.

---

## 1. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser for OAuth; it cannot be scripted. Confirm it worked:

```bash
npx wrangler whoami
```

---

## 2. Create the Neon database and apply the schema

Create a project at <https://console.neon.tech>, then copy the **pooled**
connection string (it looks like
`postgresql://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/DB?sslmode=require`).

Apply the schema — it is in the repo, don't retype it:

```bash
psql "$DATABASE_URL" -f packages/room-do/schema.sql
```

No `psql`? Paste the contents of `packages/room-do/schema.sql` into Neon's SQL
Editor. Both statements are `IF NOT EXISTS`, so re-running is safe.

Verify:

```bash
psql "$DATABASE_URL" -c '\d completed_auctions'
```

You should see `room_id` (primary key), `item_name`, `starting_price`,
`winner_nickname`, `winner_persistent`, `winning_price`, `closed_at`, `bid_log`.

`winner_persistent` is what makes `/leaderboard` a *signed-in* ranking: the
query filters on it, so guest wins are archived but never ranked. Nothing has
ever been deployed from this repo, so there is no migration to run and nothing
to backfill — the first `psql -f schema.sql` picks the column up.

---

## 3. Set the Worker's secret

```bash
cd packages/room-do
npx wrangler secret put DATABASE_URL     # paste the Neon string at the prompt
```

> ### Do not add `DATABASE_URL` to `[vars]`. Ever.
>
> A plaintext `[vars]` entry **takes precedence over a Workers secret of the
> same name at deploy time**. An entry of `DATABASE_URL = ""` — the obvious
> thing to add as a placeholder so the config "documents" itself — silently
> resets the real credential to an empty string on every single
> `wrangler deploy`. Archiving then breaks in production with no error, no log
> line, and no failing test: `archiveSettlement` treats `""` and `undefined`
> identically, the settlement stays queued in the Durable Object's outbox, and
> the only symptom is that completed auctions never appear in the leaderboard or
> replay.
>
> This is why `packages/room-do/wrangler.toml` has **no `[vars]` block at all**,
> and why the reasoning is written into that file as a comment. Local
> development uses a gitignored `.dev.vars` file instead:
>
> ```bash
> echo 'DATABASE_URL=postgres://...' > packages/room-do/.dev.vars
> ```
>
> `wrangler dev` loads it automatically. `.gitignore` covers `.dev.vars*`;
> confirm with `git check-ignore -v packages/room-do/.dev.vars`.

Secrets are per-Worker and per-environment, and are not readable back. List the
names with `npx wrangler secret list`.

---

## 4. Deploy the Worker

### The migration list, and why the first deploy is the one that matters

Cloudflare Durable Object migrations are **append-only once applied**. Before
the first deploy the list can be edited freely; after it, a tag that has been
applied is fixed forever, and adding a class means a *new* block with a *new*
tag. Getting the first one wrong is painful to undo — you cannot retroactively
change which classes tag `v1` created.

Nothing has ever been deployed from this repo (`main` holds only design docs and
`wrangler whoami` reports no account), so **the first deploy must carry the
complete final list**. Derived from
[`packages/room-do/wrangler.toml`](packages/room-do/wrangler.toml), that list is
exactly one block:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDO", "LobbyDO"]
```

That is the whole list. Both — and only — Durable Object classes the Worker
exports are in it: `packages/room-do/src/index.ts` exports `RoomDO` and
`LobbyDO`, and both are bound in `wrangler.toml` as `ROOMS` and `LOBBY`. Do not
split them across two tags, and do not deploy with one class in `v1` intending
to add the other in `v2`.

`new_sqlite_classes` (not `new_classes`) is required: `RoomDO` and `LobbyDO`
both use `ctx.storage.sql`, which only exists on the SQLite storage backend.

Before deploying, confirm the file still says exactly this:

```bash
grep -c '^\[\[migrations\]\]' packages/room-do/wrangler.toml   # must print 1
grep -A2 '^\[\[migrations\]\]' packages/room-do/wrangler.toml
```

### Deploy

```bash
cd packages/room-do
npx wrangler deploy
```

Wrangler prints the applied migration and the deployed URL. **Record that URL**
— something like `https://openbid-rooms.YOUR-SUBDOMAIN.workers.dev`. It is the
value of `ROOMS_BASE_URL` and `NEXT_PUBLIC_ROOMS_BASE_URL` in step 6.

Smoke-test it before moving on:

```bash
curl https://openbid-rooms.YOUR-SUBDOMAIN.workers.dev/lobby/rooms
# expect: {"rooms":[]}
```

An empty array means the router reached `LobbyDO` and its SQLite table was
created — i.e. the migration applied. A 500 here almost always means the
migration did not run.

---

## 5. GitHub OAuth app

Sign-in is optional (guests can bid without it), but the leaderboard needs it to
have persistent identities.

At <https://github.com/settings/developers> → **New OAuth App**:

- **Homepage URL:** `https://YOUR-APP.vercel.app`
- **Authorization callback URL:**
  `https://YOUR-APP.vercel.app/api/auth/callback/github`

That callback path is fixed by Auth.js's route handler at
`apps/web/src/app/api/auth/[...nextauth]/route.ts` — the provider id is `github`,
so the path is `/api/auth/callback/github` exactly. A trailing slash or a
different provider segment will fail with a redirect-URI mismatch.

**Chicken and egg:** you don't know the Vercel domain until step 6. Either
deploy first with sign-in broken and come back, or claim the project name in
Vercel first so you know the domain. Register a **second** callback for every
preview domain you want sign-in to work on; Vercel preview URLs change per
deployment, so sign-in will not work on previews unless you also assign a stable
preview alias.

Copy the **Client ID**, then generate a **Client Secret** — it is shown once.

---

## 6. Deploy the web app to Vercel

Import the GitHub repo at <https://vercel.com/new>, then set:

| setting | value |
|---|---|
| **Root Directory** | `apps/web` |
| Framework | Next.js (auto-detected) |
| Install / Build Command | leave default first; see below if the build fails |

This is an npm-workspaces monorepo: `apps/web` depends on `@openbid/auction-core`,
`@openbid/protocol`, `@openbid/store`, `@openbid/charts` and `@openbid/llm`, all
resolved through the `workspaces` field in the **root** `package.json`, and all
listed in `apps/web/package.json` as `"*"`. Vercel's monorepo support expects
exactly this shape (unique `name` per package, dependencies stated explicitly),
so the default should work.

*Unverified — no Vercel account was available to test the build.* If it fails
with `Cannot find module '@openbid/...'`, the install did not see the workspace
root; the fix is in the project's Build & Deployment settings — enable including
source files outside the Root Directory, and/or set an explicit install command
that runs from the repository root. Do **not** "fix" it by copying packages into
`apps/web` or by switching to pnpm.

### Environment variables

Set all of these for **Production** (and Preview, if you want previews to work):

| variable | value | notes |
|---|---|---|
| `ROOMS_BASE_URL` | the step-4 Worker URL | server-side; used by SSR + Server Actions |
| `NEXT_PUBLIC_ROOMS_BASE_URL` | **the same** step-4 Worker URL | inlined into the client bundle; the WebSocket URL is derived from it (`http`→`ws`) |
| `DATABASE_URL` | the step-2 Neon string | same value as the Worker's secret |
| `AUTH_SECRET` | `openssl rand -base64 32` | any high-entropy string; changing it invalidates all sessions |
| `AUTH_GITHUB_ID` | step-5 Client ID | |
| `AUTH_GITHUB_SECRET` | step-5 Client Secret | |
| `LLM_PROVIDER` | `gemini` | |
| `GEMINI_API_KEY` | step-7 key | |

`ROOMS_BASE_URL` and `NEXT_PUBLIC_ROOMS_BASE_URL` **must be the same value.**
They are two variables only because Next.js requires the `NEXT_PUBLIC_` prefix to
expose one to the browser. Setting only the first gives you a room page that
server-renders a correct price and then never receives a single update: the room
page falls back to `""` for the socket base
(`apps/web/src/app/rooms/[id]/page.tsx`), so the URL becomes the *relative*
`/rooms/:id/ws`, which the browser resolves against its own origin — i.e. at
Vercel, not at the Worker. The connection never establishes and the page sits
behind the "Reconnecting" banner.

Both must be `https://` (not `http://`), or the browser will refuse the
`ws://` upgrade from an HTTPS page as mixed content.

`NEXT_PUBLIC_*` values are baked in at build time, so changing it requires a
**redeploy**, not just a restart.

---

## 7. Gemini API key (free tier)

<https://aistudio.google.com/app/apikey> → **Create API key**. The free tier is
enough for this.

The adapter targets `gemini-2.0-flash`
(`packages/llm/src/gemini.ts`). With `LLM_PROVIDER=gemini` and
`GEMINI_API_KEY` set, a settled room shows one line of commentary; with either
missing, it shows nothing and the auction is unaffected. Nothing else depends on
this key.

---

## 8. Verify the deploy

1. Open the Vercel URL. The lobby loads with "No auctions yet."
   - If it 500s, `ROOMS_BASE_URL` is wrong or unset — `roomsBaseUrl()` throws
     when it is empty.
2. Create a lot. You should land on `/rooms/:id` showing the starting price 100
   and a running countdown.
3. Open the same room URL in a second browser **profile or incognito window**
   (a separate cookie jar means a separate guest identity), and bid from each.
   Both prices must move together.
4. Race it: type the same amount in both, click both as close to simultaneously
   as you can. One gets "You were outbid — the price moved while you were
   typing."; both end on the same number.
5. Wait out the 3-minute auction. The winner line appears, then (if Gemini is
   configured) a line of commentary.
6. Check the archive landed:
   ```bash
   psql "$DATABASE_URL" -c 'SELECT room_id, item_name, winning_price, winner_persistent FROM completed_auctions;'
   ```
   Then open `/leaderboard` and `/replay/<room_id>`.
   - Empty table but a closed auction? The settlement is stuck in the DO's
     outbox — almost always `DATABASE_URL`. Check
     `npx wrangler tail` while an auction closes. It retries on every
     subsequent alarm, so fixing the secret recovers queued settlements
     rather than losing them.

---

## 9. Optional: automatic Worker deploys

`.github/workflows/deploy-worker.yml` is in the repo but **inert by design**: it
only runs on manual dispatch until you add the credential, and it exits cleanly
without deploying if the credential is absent. Nothing auto-deploys to
Cloudflare behind your back.

To enable it:

1. Create a Cloudflare API token at
   <https://dash.cloudflare.com/profile/api-tokens> using the **Edit Cloudflare
   Workers** template.
2. Add it as a repository secret named `CLOUDFLARE_API_TOKEN`
   (`gh secret set CLOUDFLARE_API_TOKEN`).
3. Uncomment the `push:` trigger at the top of that workflow if you want it to
   run on merges to `main` that touch `packages/room-do/**`.

---

## Verification status

Honest accounting, because the difference matters:

**Verified on this machine:**

- `npm ci`, `npm test` (398 passing), both typechecks, and `next build`.
- `npx wrangler dev --config packages/room-do/wrangler.toml` starts, binds both
  Durable Objects, and serves `GET /lobby/rooms`.
- The full local flow: create a lot, two independent browser contexts bidding,
  simultaneous bids adjudicated by the Durable Object, both clients converging.
- That `wrangler.toml` contains exactly one migration block naming both DO
  classes, and no `[vars]` block.
- That `.dev.vars` and `.env*.local` are gitignored.

**Not verified — no credentials exist for any of it:**

- Every command in steps 1, 3, 4, 6, 7 and 8. `npx wrangler whoami` reports no
  authenticated account; there is no Vercel CLI, no Neon connection string, no
  Gemini key, and no GitHub OAuth app.
- Therefore: the exact deploy output, whether the Durable Object migration
  applies cleanly, whether Neon accepts the schema as written, and the Vercel
  monorepo build with `apps/web` as root directory.
- The Auth.js callback path and the Vercel monorepo build behaviour are read off
  this repo's own code, or off vendor documentation — not confirmed by running
  them. The Cloudflare free-plan claim was checked against Cloudflare's live
  pricing page (an earlier draft of this file asserted a paid plan was required,
  which that page contradicts).
