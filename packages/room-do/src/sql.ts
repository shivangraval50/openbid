import type { AuctionEvent } from "@openbid/auction-core";

type Sql = SqlStorage;

export function initSchema(sql: Sql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL
    );
  `);
}

export function putMeta(sql: Sql, k: string, v: string): void {
  sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = ?", k, v, v);
}

export function getMeta(sql: Sql, k: string): string | null {
  const rows = sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray();
  return rows.length > 0 ? rows[0]!.v : null;
}

export function appendEvent(sql: Sql, event: AuctionEvent): number {
  sql.exec("INSERT INTO events (payload) VALUES (?)", JSON.stringify(event));
  return currentSeq(sql);
}

export function currentSeq(sql: Sql): number {
  const rows = sql
    .exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events")
    .toArray();
  return rows[0]?.seq ?? 0;
}

export function readEventsSince(
  sql: Sql,
  seq: number
): { seq: number; event: AuctionEvent }[] {
  return sql
    .exec<{ seq: number; payload: string }>(
      "SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq ASC",
      seq
    )
    .toArray()
    .map((row) => ({ seq: row.seq, event: JSON.parse(row.payload) as AuctionEvent }));
}
