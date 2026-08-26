CREATE TABLE IF NOT EXISTS completed_auctions (
  room_id         TEXT PRIMARY KEY,
  item_name       TEXT        NOT NULL,
  starting_price  NUMERIC     NOT NULL,
  winner_nickname TEXT,
  winning_price   NUMERIC,
  closed_at       TIMESTAMPTZ NOT NULL,
  bid_log         JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS completed_auctions_closed_at_idx
  ON completed_auctions (closed_at DESC);
