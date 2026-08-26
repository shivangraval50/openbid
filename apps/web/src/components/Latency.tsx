const SYNCED_THRESHOLD_MS = 250;

export function describeSkew(offsetMs: number): string {
  const magnitude = Math.abs(Math.round(offsetMs));
  return magnitude <= SYNCED_THRESHOLD_MS
    ? "clock synced"
    : `clock offset ${magnitude} ms`;
}

export function Latency({ offsetMs }: { offsetMs: number }) {
  return (
    <p data-testid="latency" title="Difference between this browser's clock and the server's">
      {describeSkew(offsetMs)}
    </p>
  );
}
