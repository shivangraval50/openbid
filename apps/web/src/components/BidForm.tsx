"use client";

import { useEffect, useState } from "react";
import type { RejectReason } from "@openbid/protocol";

const REJECT_COPY: Record<RejectReason, string> = {
  TOO_LOW: "You were outbid — the price moved while you were typing.",
  AUCTION_CLOSED: "This auction is closed.",
  RATE_LIMITED: "Slow down — you're bidding too fast.",
  INSUFFICIENT_BUDGET: "That's over your remaining budget.",
};

export function BidForm(props: {
  minimum: number;
  disabled: boolean;
  rejectReason: RejectReason | null;
  onBid: (amount: number) => void;
}) {
  const [value, setValue] = useState(String(props.minimum));
  const [localError, setLocalError] = useState<string | null>(null);

  // Follow the minimum upward as the auction moves, but never fight the user
  // mid-edit: only resync when the field still holds a stale minimum.
  useEffect(() => {
    setValue((current) =>
      Number(current) < props.minimum ? String(props.minimum) : current
    );
  }, [props.minimum]);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < props.minimum) {
      setLocalError(`Bid must be at least ${props.minimum}.`);
      return;
    }
    setLocalError(null);
    props.onBid(amount);
  }

  const message = localError ?? (props.rejectReason && REJECT_COPY[props.rejectReason]);

  return (
    // noValidate: the browser's own HTML5 constraint validation (triggered
    // by the input's `min` attribute) would otherwise block the submit
    // event entirely on an out-of-range value, before our handler ever
    // runs -- replacing our specific, tested error copy with a generic
    // native tooltip. `min` stays on the input for assistive tech / spinner
    // semantics; the actual validation is this component's own.
    <form onSubmit={submit} noValidate>
      <label htmlFor="bid">Your bid</label>
      <input
        id="bid"
        type="number"
        inputMode="decimal"
        value={value}
        min={props.minimum}
        onChange={(e) => setValue(e.target.value)}
        disabled={props.disabled}
      />
      <button type="submit" disabled={props.disabled}>
        Place bid
      </button>
      {message ? <p role="alert">{message}</p> : null}
    </form>
  );
}
