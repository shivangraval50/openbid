export function formatRemaining(ms: number): string {
  const clamped = Math.max(0, ms);
  const total = Math.floor(clamped / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// `msRemaining` must be computed by the caller from the store's
// server-corrected clock (`selectMsRemaining`/`selectServerNow`), never
// from this component's own `Date.now()` -- there is no local timestamp
// read here at all, by design.
export function Countdown({ msRemaining }: { msRemaining: number }) {
  const urgent = msRemaining <= 10_000;
  return (
    <span role="timer" aria-live="off" data-urgent={urgent ? "true" : "false"}>
      {formatRemaining(msRemaining)}
    </span>
  );
}
