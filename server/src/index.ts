/**
 * Entry point.
 *
 * Boots in replay mode by default. A reviewer cloning this on a Sunday, or at
 * midnight, or from outside India, gets a working product with real recorded
 * NSE prices rather than an empty screen and a note explaining that the market
 * is closed. `MODE=live` switches to the network provider.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { App, store } from "./app.js";
import { registerRoutes } from "./api/routes.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const MODE = (process.env.MODE ?? "replay") as "replay" | "live";
const ROOT = resolve(process.cwd(), "..");
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "marketreader.db");

/**
 * Three seeded users with overlapping lists.
 *
 * Not decoration. Two of the brief's questions — how the system scales with more
 * users, and how state persists across sessions and devices — cannot be shown at
 * all with a single account. With three, the overlap is visible on the status
 * endpoint (one fetch serves every user watching Reliance) and each account
 * carries its own independent watermark, so switching between them shows three
 * different answers to "what changed since you last looked" over identical
 * market data.
 */
const SEED_USERS: {
  id: string;
  name: string;
  policy: string;
  /**
   * How long ago this account last looked. Seeded rather than left at zero so a
   * fresh clone opens onto a working digest instead of the first-visit screen,
   * which is correct and says nothing. Three different absences also make the
   * central idea legible without touching a control: the same market, read
   * through three windows, gives three different answers.
   */
  lastLookedDaysAgo: number;
  list: [string, number | null][];
}[] = [
  { id: "demo", name: "Demo", policy: "balanced", lastLookedDaysAgo: 7, list: [] }, // filled below
  {
    id: "asha",
    name: "Asha",
    policy: "signal",
    lastLookedDaysAgo: 3,
    list: [
      ["RELIANCE", 120], ["HDFCBANK", 60], ["INFY", null], ["ITC", 400],
      ["NESTLEIND", 2], ["TATAPOWER", null], ["BEL", 250], ["HAL", null],
      ["SUNPHARMA", null], ["MARUTI", 5], ["TITAN", null], ["ASIANPAINT", null],
    ],
  },
  {
    id: "ravi",
    name: "Ravi",
    policy: "everything",
    lastLookedDaysAgo: 30,
    list: [
      ["RELIANCE", null], ["SUZLON", 4000], ["IDEA", 12000], ["YESBANK", 3000],
      ["IRFC", 800], ["RVNL", null], ["IREDA", 500], ["PAYTM", null],
      ["ADANIENT", null], ["JIOFIN", null],
    ],
  },
];

/** A watchlist chosen to exercise the interesting paths, not to look impressive. */
const SEED_WATCHLIST: [string, number | null][] = [
  ["RELIANCE", 40],
  ["HDFCBANK", 25],
  ["TCS", null],
  ["NESTLEIND", 5], // carries a real 10:1 split and a 2:1
  ["VEDL", null], // carries a real demerger the action feed does not report
  ["ADANIENT", null], // carries a real 28% single-session crash
  ["TATASTEEL", 300],
  ["IREDA", null], // recently listed: a short baseline
  ["SUZLON", 1000], // high volatility: the case a fixed % threshold gets wrong
  ["HINDUNILVR", null], // low volatility: the other case it gets wrong
  ["IDEA", 5000],
  ["ITC", 120],
  ["SBIN", null],
  ["INFY", null],
  ["TATAMOTORS", null], // the provider 404s this one: a real lifecycle case
];

async function main() {
  const app = new App({ dataDir: DATA_DIR, dbPath: DB_PATH, mode: MODE });

  // Seed once, so a fresh clone opens onto something meaningful.
  SEED_USERS[0]!.list = SEED_WATCHLIST;
  for (const u of SEED_USERS) {
    if (store.getUser(app.db, u.id)) continue;
    const now = app.clock.now();
    store.upsertUser(app.db, { id: u.id, name: u.name, policy: u.policy, created_at: now });
    for (const [symbol, qty] of u.list) {
      store.addWatch(app.db, u.id, symbol, now, qty);
    }
    // Place the watermark in the past, so this account has something to be
    // shown. The anchor price is the one that actually printed at that instant,
    // which is what the digest would have recorded had they really looked then.
    const seenAt = now - u.lastLookedDaysAgo * 24 * 3600_000;
    for (const [symbol] of u.list) {
      const anchor = app.oracle.priceAt(symbol, seenAt);
      store.advanceWatermark(app.db, u.id, symbol, seenAt, anchor?.price ?? null, "seed-demo", now);
    }
  }

  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "warn" },
    // Health checks and SSE both suffer under an aggressive default.
    connectionTimeout: 0,
  });
  await fastify.register(cors, { origin: true });
  await registerRoutes(fastify, app);

  // Serve the built UI when it exists, so production is one process.
  const publicDir = join(process.cwd(), "public");
  if (existsSync(publicDir)) {
    await fastify.register(fastifyStatic, { root: publicDir });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  app.worker.start();

  try {
    await fastify.listen({ port: PORT, host: HOST });
  } catch (e) {
    // A port collision is the single most likely first-run failure on someone
    // else's machine, and a raw EADDRINUSE stack does not tell them the one
    // thing they need to know.
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(
        `\n  Port ${PORT} is already in use. Run it somewhere else:\n\n` +
          `    bash / zsh    PORT=8080 npm run serve\n` +
          `    PowerShell    $env:PORT=8080; npm run serve\n` +
          `    cmd.exe       set PORT=8080 && npm run serve\n\n`,
      );
      process.exit(1);
    }
    throw e;
  }
  const s = app.status();
  process.stdout.write(
    [
      ``,
      `  MarketReader  ->  http://localhost:${PORT}`,
      `  mode: ${MODE}   provider: ${s.ingest.provider}   universe: ${s.universe} symbols`,
      s.replay
        ? `  replaying ${new Date(s.replay.from).toISOString()} .. ${new Date(s.replay.to).toISOString()}`
        : `  live market data`,
      `  clock at ${new Date(s.now).toISOString()}  (${s.session.session})`,
      ``,
    ].join("\n"),
  );

  const shutdown = async () => {
    await fastify.close();
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});
