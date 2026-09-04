/**
 * Persistence.
 *
 * Two decisions here are load-bearing and worth reading before the schema.
 *
 * 1. The event log is immutable and read state is a separate table.
 *
 *    The tempting design is a `seen` boolean on the event. It is wrong: once
 *    flipped, the fact that the event ever happened becomes unrecoverable, so
 *    history views, "what did you show me last Tuesday", and any debugging of a
 *    bad alert all become impossible. Events are facts about the market and are
 *    never mutated. Whether a particular user has looked at one is a fact about
 *    that user and lives in `event_reads`.
 *
 * 2. Watermarks move forward only.
 *
 *    A user reads their digest on a phone, then opens a laptop that has been
 *    asleep for a day. Last-write-wins would let the laptop's stale watermark
 *    overwrite the phone's, so everything they already read reappears; the
 *    reverse ordering silently swallows news they never saw. Neither is
 *    acceptable, and there is no clock accurate enough to arbitrate. Taking the
 *    maximum makes the merge commutative and idempotent, so the outcome does
 *    not depend on which device syncs first.
 *
 * SQLite because the write volume that matters is events and watermarks, not
 * ticks: quotes never touch disk. The repository boundary below is what would
 * move to Postgres plus Redis if that stopped being true.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // WAL lets the ingestion worker write while requests read.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Columns added after the first release.
 *
 * `CREATE TABLE IF NOT EXISTS` is not a migration: it does nothing at all to a
 * table that already exists, so a column added later is simply absent for
 * anyone whose database predates it, and the first query naming that column
 * fails at runtime rather than at startup. That is exactly what happened when
 * `is_seed` was added -- every request 500'd with "no such column" on a
 * developer machine that had a database from an hour earlier.
 *
 * A full migration framework would be more machinery than this project earns.
 * Reading the existing columns and adding the missing ones is enough, and it is
 * honest about its limits: it can add nullable or defaulted columns, and
 * nothing else. Anything structural needs a real migration and should say so.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "watermarks", column: "is_seed", ddl: "INTEGER NOT NULL DEFAULT 0" },
];

function applyAddedColumns(db: DB): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const exists = (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      policy      TEXT NOT NULL DEFAULT 'balanced',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watchlist_items (
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol    TEXT NOT NULL,
      added_at  INTEGER NOT NULL,
      -- Optional position size. When present it weights ranking: a 2% move in
      -- something you hold a lot of outranks a 3% move in something you watch.
      quantity  REAL,
      PRIMARY KEY (user_id, symbol)
    );

    -- How far each user has acknowledged reading, per symbol.
    -- seen_ts is monotonic: see advanceWatermark().
    CREATE TABLE IF NOT EXISTS watermarks (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol      TEXT NOT NULL,
      -- 1 while the row is only the placeholder written when the symbol was
      -- added, 0 once a person has actually acknowledged seeing it. Kept as a
      -- column rather than inferred from the device string, so the difference
      -- between never having looked and having looked from a client that did
      -- not name itself stays representable.
      is_seed     INTEGER NOT NULL DEFAULT 0,
      seen_ts     INTEGER NOT NULL,
      -- The price at the moment they acknowledged. Stored because it is the
      -- only anchor for "since you last looked"; recomputing it later from a
      -- bar series would silently drift as the series is re-adjusted.
      seen_price  INTEGER,
      updated_at  INTEGER NOT NULL,
      device      TEXT,
      PRIMARY KEY (user_id, symbol)
    );

    -- Immutable. Never updated, never deleted by application code.
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      dedupe_key  TEXT NOT NULL,
      window_from INTEGER NOT NULL,
      window_to   INTEGER NOT NULL,
      strength    REAL NOT NULL,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_time ON events (user_id, created_at DESC);
    -- Idempotency: re-evaluating the same event must not duplicate it.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON events (user_id, dedupe_key);

    CREATE TABLE IF NOT EXISTS event_reads (
      user_id     TEXT NOT NULL,
      dedupe_key  TEXT NOT NULL,
      shown_at    INTEGER NOT NULL,
      PRIMARY KEY (user_id, dedupe_key)
    );

    CREATE TABLE IF NOT EXISTS symbols (
      symbol       TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      is_index     INTEGER NOT NULL DEFAULT 0
    );
  `);

  applyAddedColumns(db);
}

// ------------------------------------------------------------------ users --

export interface User {
  id: string;
  name: string;
  policy: string;
  created_at: number;
}

export function upsertUser(db: DB, u: User): void {
  db.prepare(
    `INSERT INTO users (id, name, policy, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  ).run(u.id, u.name, u.policy, u.created_at);
}

export function getUser(db: DB, id: string): User | null {
  return (db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as User | undefined) ?? null;
}

export function setPolicy(db: DB, userId: string, policy: string): void {
  db.prepare(`UPDATE users SET policy = ? WHERE id = ?`).run(policy, userId);
}

// ------------------------------------------------------------- watchlists --

export interface WatchItem {
  symbol: string;
  added_at: number;
  quantity: number | null;
}

export function listWatch(db: DB, userId: string): WatchItem[] {
  return db
    .prepare(`SELECT symbol, added_at, quantity FROM watchlist_items WHERE user_id = ? ORDER BY added_at`)
    .all(userId) as WatchItem[];
}

/**
 * Adding is idempotent, and seeds a watermark at the moment of adding.
 *
 * Without that seed, a symbol added today would be diffed against epoch zero
 * and the user's first view of it would claim every move since 1970 as news.
 * "There is no since yet" is the correct state for a brand-new item, and the
 * cheapest way to represent it is a watermark equal to now.
 */
export function addWatch(db: DB, userId: string, symbol: string, now: number, quantity?: number | null): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO watchlist_items (user_id, symbol, added_at, quantity) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, symbol) DO UPDATE SET quantity = excluded.quantity`,
    ).run(userId, symbol, now, quantity ?? null);
    db.prepare(
      `INSERT INTO watermarks (user_id, symbol, seen_ts, seen_price, updated_at, device, is_seed)
       VALUES (?, ?, ?, NULL, ?, 'seed', 1)
       ON CONFLICT(user_id, symbol) DO NOTHING`,
    ).run(userId, symbol, now, now);
  });
  tx();
}

export function removeWatch(db: DB, userId: string, symbol: string): void {
  // The watermark survives removal on purpose: re-adding a symbol should not
  // replay everything that happened while it was off the list.
  db.prepare(`DELETE FROM watchlist_items WHERE user_id = ? AND symbol = ?`).run(userId, symbol);
}

/** Every symbol any user watches. This is what ingestion subscribes to. */
export function watchedUniverse(db: DB): string[] {
  return (db.prepare(`SELECT DISTINCT symbol FROM watchlist_items`).all() as { symbol: string }[]).map(
    (r) => r.symbol,
  );
}

// ------------------------------------------------------------ watermarks --

export interface Watermark {
  symbol: string;
  seen_ts: number;
  seen_price: number | null;
  updated_at: number;
  device: string | null;
  /** 1 when this is still the placeholder written at add time. */
  is_seed: number;
}

export function getWatermarks(db: DB, userId: string): Map<string, Watermark> {
  const rows = db
    .prepare(
      `SELECT symbol, seen_ts, seen_price, updated_at, device, is_seed FROM watermarks WHERE user_id = ?`,
    )
    .all(userId) as Watermark[];
  return new Map(rows.map((r) => [r.symbol, r]));
}

/**
 * Move a watermark forward. Never backward.
 *
 * The guard is in the WHERE clause rather than in application code so that two
 * devices syncing concurrently cannot interleave a read and a write around it.
 * Returns true when the write actually advanced anything, which the API surfaces
 * so a client can tell "accepted" from "already ahead of you".
 */
export function advanceWatermark(
  db: DB,
  userId: string,
  symbol: string,
  seenTs: number,
  seenPrice: number | null,
  device: string,
  now: number,
): boolean {
  const r = db
    .prepare(
      `INSERT INTO watermarks (user_id, symbol, seen_ts, seen_price, updated_at, device, is_seed)
       VALUES (@u, @s, @ts, @p, @now, @dev, 0)
       ON CONFLICT(user_id, symbol) DO UPDATE SET
         seen_ts    = excluded.seen_ts,
         seen_price = excluded.seen_price,
         updated_at = excluded.updated_at,
         device     = excluded.device,
         is_seed    = 0
       WHERE excluded.seen_ts > watermarks.seen_ts
          OR watermarks.is_seed = 1`,
    )
    .run({ u: userId, s: symbol, ts: seenTs, p: seenPrice, now, dev: device });
  return r.changes > 0;
}

// ----------------------------------------------------------------- events --

export interface EventRow {
  id: number;
  user_id: string;
  symbol: string;
  kind: string;
  dedupe_key: string;
  window_from: number;
  window_to: number;
  strength: number;
  payload: string;
  created_at: number;
}

/** Append-only. The unique index on dedupe_key makes re-detection a no-op. */
export function recordEvent(
  db: DB,
  e: Omit<EventRow, "id">,
): void {
  db.prepare(
    `INSERT INTO events (user_id, symbol, kind, dedupe_key, window_from, window_to, strength, payload, created_at)
     VALUES (@user_id, @symbol, @kind, @dedupe_key, @window_from, @window_to, @strength, @payload, @created_at)
     ON CONFLICT(user_id, dedupe_key) DO NOTHING`,
  ).run(e);
}

export function markShown(db: DB, userId: string, dedupeKeys: string[], now: number): void {
  const stmt = db.prepare(
    `INSERT INTO event_reads (user_id, dedupe_key, shown_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, dedupe_key) DO UPDATE SET shown_at = excluded.shown_at`,
  );
  const tx = db.transaction((keys: string[]) => {
    for (const k of keys) stmt.run(userId, k, now);
  });
  tx(dedupeKeys);
}

export function lastShownMap(db: DB, userId: string): Map<string, number> {
  const rows = db
    .prepare(`SELECT dedupe_key, shown_at FROM event_reads WHERE user_id = ?`)
    .all(userId) as { dedupe_key: string; shown_at: number }[];
  return new Map(rows.map((r) => [r.dedupe_key, r.shown_at]));
}

export function recentEvents(db: DB, userId: string, limit = 100): EventRow[] {
  return db
    .prepare(`SELECT * FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(userId, limit) as EventRow[];
}

// ---------------------------------------------------------------- symbols --

export function upsertSymbol(db: DB, symbol: string, displayName: string, isIndex: boolean): void {
  db.prepare(
    `INSERT INTO symbols (symbol, display_name, is_index) VALUES (?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET display_name = excluded.display_name`,
  ).run(symbol, displayName, isIndex ? 1 : 0);
}

export function allSymbols(db: DB): { symbol: string; display_name: string; is_index: number }[] {
  return db.prepare(`SELECT * FROM symbols ORDER BY is_index DESC, symbol`).all() as any;
}
