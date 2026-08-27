CREATE TABLE IF NOT EXISTS completed_auctions (
  room_id         TEXT PRIMARY KEY,
  item_name       TEXT        NOT NULL,
  starting_price  NUMERIC     NOT NULL,
  winner_nickname TEXT,
  -- TRUE only when winner_nickname is a persistent, GitHub-backed identity
  -- (auth.ts stores the unique `login` there), FALSE for a guest. The
  -- leaderboard ranks only signed-in participants, and a bare nickname
  -- cannot tell the two apart after the fact -- the guest cookie is
  -- client-writable, so a guest can set it to any GitHub login. DEFAULT
  -- FALSE so the safe answer is the one a row gets by omission.
  winner_persistent BOOLEAN NOT NULL DEFAULT FALSE,
  winning_price   NUMERIC,
  closed_at       TIMESTAMPTZ NOT NULL,
  bid_log         JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS completed_auctions_closed_at_idx
  ON completed_auctions (closed_at DESC);
