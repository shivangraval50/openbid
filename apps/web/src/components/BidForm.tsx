"use client";

import { useEffect, useRef, useState } from "react";
import type { RejectReason } from "@openbid/protocol";
import styles from "./BidForm.module.css";

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
  // Tracks the minimum the field was last synced to (starts equal to the
  // initial value above, since that's what the field holds on mount).
  const syncedMinimumRef = useRef(props.minimum);

  // Follow the minimum upward as the auction moves, but never fight the
  // user mid-edit. "Stale" specifically means: the field still holds
  // exactly the *previous* minimum, verbatim -- not merely "a number below
  // the new one". A numeric `<` comparison against the new minimum alone
  // can't tell a genuinely stale, untouched field apart from a half-typed
  // replacement (typing "500" one digit at a time briefly reads as "5",
  // "50" -- both "below" almost any minimum) or a deliberately cleared one
  // (`Number("") === 0`, also "below"); either would otherwise get
  // silently overwritten mid-edit.
  useEffect(() => {
    setValue((current) =>
      current === String(syncedMinimumRef.current) ? String(props.minimum) : current
    );
    syncedMinimumRef.current = props.minimum;
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
    <form onSubmit={submit} noValidate className={styles.form}>
      <label htmlFor="bid" className={styles.label}>
        Your bid
      </label>
      <div className={styles.row}>
        <div className={styles.field}>
          <input
            id="bid"
            type="number"
            inputMode="decimal"
            value={value}
            min={props.minimum}
            onChange={(e) => setValue(e.target.value)}
            disabled={props.disabled}
            className={styles.input}
            /* Only the LOCAL check marks the field invalid. A server
               rejection is a statement about a bid that has already been
               sent, not about what the field currently holds -- the price
               moved underneath it -- so flagging the field for that would
               point at the wrong thing. */
            aria-invalid={localError === null ? undefined : true}
          />
        </div>
        <button type="submit" disabled={props.disabled} className={styles.submit}>
          Place bid
        </button>
      </div>
      <p className={styles.hint}>
        Minimum <span className={styles.hintValue}>{props.minimum}</span>
      </p>
      {/* The <p role="alert"> keeps EXACTLY its original text and nothing
          else; the icon is a sibling, not a child. See BidForm.module.css's
          note on the end-to-end spec that compares this text by exact
          equality. */}
      {message ? (
        <div className={styles.alert}>
          <svg
            className={styles.alertIcon}
            viewBox="0 0 20 20"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="10" cy="10" r="9" fill="currentColor" opacity="0.2" />
            <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M10 5.6v5.6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <circle cx="10" cy="14.3" r="1.05" fill="currentColor" />
          </svg>
          <p role="alert" className={styles.alertText}>{message}</p>
        </div>
      ) : null}
    </form>
  );
}
