const SYNCED_THRESHOLD_MS = 250;

export function describeSkew(offsetMs: number): string {
  const magnitude = Math.abs(Math.round(offsetMs));
  return magnitude <= SYNCED_THRESHOLD_MS
    ? "clock synced"
    : `clock offset ${magnitude} ms`;
}

// `offsetMs` is `null` until a real round trip (`observeClock`) measures
// one -- see `@openbid/store`'s `clockOffsetMs` doc comment. Rendering a
// static, non-computed placeholder for that case (rather than falling back
// to `describeSkew(0)` -> "clock synced", which would be a fabricated
// claim, not a measurement) is what fixes the hydration mismatch this
// component used to produce by construction: a pong cannot arrive before
// mount, so `offsetMs` is `null` on both the server render and the
// client's first (hydrating) render, and this branch renders identical,
// static text in both. The mismatch used to come from `describeSkew`
// reading two different real `Date.now()` calls (one at SSR time, one at
// hydration time) through `clockOffsetMs`; there is no `Date.now()` call
// anywhere in this component now.
export function Latency({ offsetMs }: { offsetMs: number | null }) {
  return (
    <p data-testid="latency" title="Difference between this browser's clock and the server's">
      {offsetMs === null ? "clock measuring…" : describeSkew(offsetMs)}
    </p>
  );
}
