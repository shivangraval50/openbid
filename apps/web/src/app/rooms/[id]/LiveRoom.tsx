"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { minimumBid, type AuctionState } from "@openbid/auction-core";
import {
  createAuctionStore,
  selectDisplayPrice,
  selectMsRemaining,
  selectPendingCount,
  selectServerNow,
} from "@openbid/store";
import { connectRoom, type ConnStatus, type RoomConnection } from "@/lib/socket";
import { useAuctionSelector } from "@/hooks/useAuctionStore";
import { cx } from "@/cx";
import { BidForm } from "@/components/BidForm";
import { useBidPhase } from "@/components/bidPhase";
import { Commentary } from "@/components/Commentary";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { Countdown, extensionDeltaMs } from "@/components/Countdown";
import { PriceLadder } from "@/components/PriceLadder";
import { Latency } from "@/components/Latency";
import { PriceChart } from "@/components/PriceChart";
import styles from "./room.module.css";

/**
 * How long the anti-snipe notice stays up after the deadline jumps. Long
 * enough to be read without hunting for it, short enough that it is gone
 * before the next bid -- motion.md, "Aim for brevity and precision in
 * feedback animations."
 */
const EXTENSION_NOTICE_MS = 6_000;

/**
 * How trustworthy the numbers on screen currently are. Drives the
 * instrument panel's own edge, so a dropped connection is visible even to
 * someone looking straight at the price rather than at the header pill --
 * without anything being drawn on top of the price.
 */
function liveness(status: ConnStatus): "live" | "stale" | "down" {
  if (status === "reconnecting") return "stale";
  if (status === "closed") return "down";
  return "live";
}

export function LiveRoom(props: {
  roomId: string;
  initialSeq: number;
  initialServerTime: number;
  initialState: AuctionState;
  socketBaseUrl: string;
  nickname?: string;
  /**
   * Whether `nickname` came from a GitHub session rather than the guest
   * cookie (`resolveIdentity().persistent`). Optional, matching `nickname`
   * above, and defaulted to `false` -- the only safe guess, since it is
   * what keeps an unattributable win off the leaderboard rather than
   * crediting it to whoever shares that nickname.
   */
  persistent?: boolean;
  /**
   * The lot's name, passed down rather than read off the seeded store so
   * that the heading renders even on the (practically unreachable) branch
   * where `server` is still null.
   */
  itemName: string;
}) {
  // Seeded synchronously, during render, inside the same `useMemo` that
  // creates the store -- NOT in a `useEffect`. Effects never run during
  // server rendering, so seeding there would mean the server-rendered HTML
  // (the entire point of this task: a real, priced first paint before any
  // socket opens) contained no price at all, and the client's first paint
  // would show "Loading…" until hydration's effects caught up. Seeding
  // here means `useSyncExternalStore`'s `getServerSnapshot` path already
  // sees real state on the server, and the client's first render matches
  // it exactly.
  //
  // Deliberately NOT `applyServerMessage({ t: "snapshot", ... })`: that
  // wire message requires `youAre`, a real per-connection field the HTTP
  // `/snapshot` endpoint has no value for (no connection, no participant
  // identity). `seedFromSnapshot` sets `server`/`lastSeenSeq`/`pending`
  // exactly as that case does, but leaves `youAre` null -- true until the
  // socket's own snapshot arrives -- and derives a provisional clock offset
  // from `initialServerTime` so the very first countdown render is already
  // server-corrected rather than trusting the local clock by default.
  //
  // Only depends on `roomId`: this is a "seed once, at construction" store,
  // not one that re-seeds on every prop change. `seedFromSnapshot` also
  // carries its own monotonicity guard (a regressive seq is a no-op once
  // real server state exists), so even a future caller that does re-run
  // this can't walk applied state backwards.
  const store = useMemo(() => {
    const s = createAuctionStore();
    s.getState().seedFromSnapshot(props.initialSeq, props.initialServerTime, props.initialState);
    return s;
    // Deliberately keyed on `roomId` alone, not `initialSeq`/`initialState`:
    // this seeds once, at construction, for this room. It intentionally
    // does not react to those props changing on a later re-render (e.g. a
    // parent re-fetching the SSR snapshot) -- once the socket is live, the
    // store already holds newer, authoritative state, and `seedFromSnapshot`'s
    // own monotonicity guard would reject a stale reseed attempt anyway.
  }, [props.roomId]);

  const connRef = useRef<RoomConnection | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [, forceTick] = useState(0);

  useEffect(() => {
    const url = `${props.socketBaseUrl.replace(/^http/, "ws")}/rooms/${props.roomId}/ws`;
    // `superseded` discards status updates from a connection this effect has
    // already torn down. A close event is delivered asynchronously, so on a
    // re-run the real order is: cleanup closes connection A -> connection B
    // opens and reports "open" -> A's queued `onclose` fires and reports
    // "closed", overwriting it. The room then showed "Disconnected."
    // permanently while B sat there connected and healthy, because nothing
    // ever emits "open" a second time for one socket.
    //
    // Guarded here rather than in `connectRoom`, which is deliberately kept
    // reporting "closed" on a disposed socket -- that is its own contract and
    // its own test. Knowing whether a replacement exists is this effect's
    // business, not the transport's.
    //
    // Found by CI, where a cold Turbopack cache compiles this page mid-test
    // and Fast Refresh remounts the component. Nothing about it is dev-only:
    // this effect also re-runs whenever any dependency below changes.
    let superseded = false;
    const conn = connectRoom({
      url,
      nickname: props.nickname ?? "guest",
      persistent: props.persistent ?? false,
      store,
      onStatus: (next) => {
        if (!superseded) setStatus(next);
      },
    });
    connRef.current = conn;
    return () => {
      superseded = true;
      conn.close();
    };
  }, [props.roomId, props.socketBaseUrl, props.nickname, props.persistent, store]);

  // Re-render the countdown on a timer; the clock value itself comes from
  // the store's server-corrected offset, never from a local timestamp.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  // Only *pure* state goes through `useAuctionSelector` (`useSyncExternalStore`
  // underneath). `selectMsRemaining`/`selectServerNow` call `Date.now()`
  // internally, so their result is different on almost every call --
  // violating `useSyncExternalStore`'s documented contract that
  // `getSnapshot` return a stable, cacheable value (React's own docs warn
  // this can produce an unnecessary extra render, or in dev mode a
  // "should be cached" console warning, when the store is checked for
  // tearing between render and commit). Computed directly from
  // `store.getState()` in the render body instead:
  // the existing 250ms `forceTick` already drives the re-render this needs,
  // so nothing is lost by not routing it through the subscription.
  const server = useAuctionSelector(store, (s) => s.server);
  const displayPrice = useAuctionSelector(store, selectDisplayPrice);
  const pendingCount = useAuctionSelector(store, selectPendingCount);
  const lastReject = useAuctionSelector(store, (s) => s.lastReject);
  const clockOffsetMs = useAuctionSelector(store, (s) => s.clockOffsetMs);
  const youAre = useAuctionSelector(store, (s) => s.youAre);
  const msRemaining = selectMsRemaining(store.getState());
  const serverNow = selectServerNow(store.getState());

  // The optimistic-bid lifecycle. See components/bidPhase.ts: `pending` is a
  // state you can read off a snapshot, `confirmed` and `rejected` are
  // transitions and are only visible by comparing consecutive ones.
  const phase = useBidPhase({
    pendingCount,
    lastRejectSeq: lastReject?.clientSeq ?? null,
  });

  // The anti-snipe extension. A bid inside the closing window pushes
  // `endsAtMs` out (see auction-core's validateBid), and without a marker the
  // countdown simply jumps upward -- which reads as a bug rather than as the
  // rule working. `previousEndsAtRef` is seeded with the CURRENT value, so
  // the first effect run after mount can never fire a spurious notice; that
  // is also what keeps this hydration-safe, since the server render and the
  // client's first render both show no notice.
  const endsAtMs = server?.endsAtMs ?? null;
  const [extendedByMs, setExtendedByMs] = useState<number | null>(null);
  const previousEndsAtRef = useRef(endsAtMs);

  useEffect(() => {
    const previous = previousEndsAtRef.current;
    previousEndsAtRef.current = endsAtMs;
    if (previous === null || endsAtMs === null) return;
    const delta = extensionDeltaMs(previous, endsAtMs);
    if (delta === null) return;
    setExtendedByMs(delta);
    const id = setTimeout(() => setExtendedByMs(null), EXTENSION_NOTICE_MS);
    return () => clearTimeout(id);
  }, [endsAtMs]);

  if (server === null) {
    return (
      <>
        <header className={styles.head}>
          <div>
            <p className={styles.eyebrow}>Lot</p>
            <h1 className={styles.lotName}>{props.itemName}</h1>
          </div>
        </header>
        <p className={styles.loading}>Loading…</p>
      </>
    );
  }

  // Two distinct notions of "over", deliberately not collapsed:
  //
  //   `closed`  -- what the UI should stop accepting bids on. Includes the
  //               local countdown hitting zero, because a bid submitted
  //               after the deadline is going to be rejected by
  //               `validateBid` anyway and it is better not to invite it.
  //   `settled` -- the SERVER's own `closed` event, the only thing that
  //               establishes a winner. It arrives up to one round trip
  //               (plus the DO's alarm scheduling) after the countdown
  //               reads zero.
  //
  // Commentary keys on `settled`, never on `closed`: in the window between
  // them `server.winner` is still null, so keying on `closed` would spend
  // a provider call describing an auction that closed "with no bids"
  // moments before the real winner arrived.
  const closed = server.status === "closed" || msRemaining <= 0;
  const settled = server.status === "closed";
  const winnerNickname =
    server.winner === null
      ? null
      : server.participants[server.winner.participantId]?.nickname ?? null;

  const minimum = minimumBid(server);
  // Distinct NICKNAMES, not participant records. Every `hello` on a fresh
  // socket mints a new participantId and appends a `joined` event, and
  // nothing ever removes a participant -- so `Object.keys(...).length` made
  // one person who reconnected twice read as three "Bidders". Counting
  // nicknames makes the number mean what its label says.
  //
  // Deliberately fixed here rather than by deduping participants inside
  // `RoomDO`'s `hello` handler. That would have worked too, and it would
  // additionally stop the event log accruing orphan participants -- but it
  // would silently change participantId from a per-connection identifier to
  // a per-nickname one, which is the exact premise two documented
  // justifications rest on (the `closed` branch below, and the README's
  // "no 'you won' indicator" limitation). Changing an identity lifetime to
  // fix a stat readout is a worse trade than counting the stat correctly.
  // The label is also not renamed: it was already telling the truth about
  // what it was supposed to show.
  const bidderCount = new Set(Object.values(server.participants).map((p) => p.nickname)).size;
  const budget = youAre === null ? null : server.participants[youAre]?.budget ?? null;

  return (
    <>
      <header className={styles.head}>
        <div>
          <p className={styles.eyebrow}>Lot</p>
          <h1 className={styles.lotName}>{props.itemName}</h1>
        </div>
        {/* The connection pill sits in the header, on the same line as the
            lot name: prominent, permanently in view (the page header is
            sticky), and structurally incapable of covering the price. Its
            slot's height is reserved by `.head`, so the pill unmounting on
            a successful connect does not move the price. */}
        <div className={styles.headStatus}>
          <ConnectionBanner status={status} />
        </div>
      </header>

      {/* ONE panel, not two widgets: the price readout and the chart are two
          views of the same series and share a card, a numeric face and an
          accent. See room.module.css and PriceLadder.module.css for the
          charting-data.md guidance behind that. */}
      <section
        className={styles.instrument}
        data-live={liveness(status)}
        data-settled={closed ? "true" : "false"}
        aria-label="Auction instrument"
      >
        <div className={styles.readout}>
          <PriceLadder
            state={server}
            displayPrice={displayPrice}
            pendingCount={pendingCount}
            minimum={minimum}
            phase={phase}
          />
          <div className={styles.clockCell}>
            <p className={styles.eyebrow}>Time remaining</p>
            <Countdown msRemaining={msRemaining} extendedByMs={extendedByMs} />
          </div>
        </div>
        <div className={styles.chartCell}>
          <PriceChart price={displayPrice} serverNow={serverNow} />
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Min increment</span>
            <span className={styles.statValue}>{server.config.minIncrement}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Bidders</span>
            <span className={styles.statValue}>{bidderCount}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Your budget</span>
            <span className={styles.statValue}>{budget === null ? "—" : budget}</span>
          </div>
          <div className={cx(styles.stat, styles.clockStat)}>
            <Latency offsetMs={clockOffsetMs} />
          </div>
        </div>
      </section>

      <section
        className={styles.actions}
        data-settled={closed ? "true" : "false"}
        aria-label="Place a bid"
      >
        <BidForm
          minimum={minimum}
          disabled={closed || status !== "open"}
          rejectReason={lastReject?.reason ?? null}
          onBid={(amount) => {
            const clientSeq = store.getState().placeOptimisticBid(amount);
            connRef.current?.send({ t: "bid", clientSeq, amount });
          }}
        />
        {closed ? (
          // Resolved by nickname, never by comparing `youAre` to
          // `winner.participantId`: a reconnecting client gets a *new*
          // participantId, so that comparison would tell a winner who
          // disconnected before close that they lost. No "you won" self
          // -indicator is rendered here for the same reason -- see the task
          // report for the open question on whether one belongs at all.
          <p
            className={cx(styles.outcome, server.winner === null && styles.outcomeEmpty)}
            data-testid="outcome"
          >
            {server.winner === null
              ? "Closed with no bids."
              : `Won by ${winnerNickname ?? "unknown"} at ${server.winner.amount}.`}
          </p>
        ) : null}
        {/* Decoration, and mounted unconditionally so it can observe the
            open -> settled transition. Renders nothing at all until (and
            unless) commentary actually arrives -- see Commentary.tsx. */}
        <Commentary
          settled={settled}
          itemName={server.config.itemName}
          winner={winnerNickname}
          price={server.winner?.amount ?? null}
        />
      </section>
    </>
  );
}
