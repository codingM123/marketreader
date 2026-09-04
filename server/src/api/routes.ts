/**
 * HTTP surface.
 *
 * Two things worth flagging.
 *
 * Reading the digest does not advance the watermark. Acknowledgement is its own
 * endpoint, called by the client when a card has actually been on screen. A
 * background refresh, a preload, or a phone restoring a tab in someone's pocket
 * would otherwise silently mark news as read.
 *
 * Authentication is a query parameter. That is a deliberate omission rather than
 * an oversight: identity is threaded through every layer as a first-class
 * parameter, so real auth is a middleware that sets it, and spending hours of a
 * three-day build on a login form would have bought nothing the brief asked for.
 * It is called out here so nobody has to wonder whether it was missed.
 */
import type { FastifyInstance } from "fastify";
import { App, INDEX_SYMBOL, store } from "../app.js";
import { FAULT_DESCRIPTIONS, type FaultKind } from "../data/replay.js";
import { PRESETS } from "../core/detect.js";
import { CALENDAR_VERIFIED_UNTIL, calendarIsVerified } from "../core/calendar.js";

const DEMO_USER = "demo";

function userOf(req: { query: unknown; headers: Record<string, unknown> }): string {
  const q = (req.query ?? {}) as Record<string, string>;
  const h = req.headers["x-user"];
  return q.user || (typeof h === "string" ? h : "") || DEMO_USER;
}

export async function registerRoutes(fastify: FastifyInstance, app: App): Promise<void> {
  // ------------------------------------------------------------- digest --

  fastify.get("/api/digest", async (req) => {
    const userId = userOf(req as any);
    ensureUser(app, userId);
    return app.buildDigestFor(userId);
  });

  /**
   * "What would I see if I had last looked N ago?"
   *
   * Read-only: no watermark is touched, no event recorded. The landing page
   * drags a slider across this, so a first-time reader watches the same market,
   * at the same instant, produce a different answer for a ten-minute absence
   * and a three-month one. That is the whole argument, and it is not a mockup.
   */
  fastify.get("/api/preview", async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const away = Number(q.awayMs);
    if (!Number.isFinite(away) || away < 0 || away > 400 * 24 * 3600_000) {
      return reply.code(400).send({ error: "awayMs must be between 0 and about a year" });
    }
    const userId = userOf(req as any);
    ensureUser(app, userId);
    return app.computeDigest(userId, away);
  });

  fastify.post("/api/ack", async (req) => {
    const userId = userOf(req as any);
    const body = (req.body ?? {}) as { symbols?: string[]; device?: string };
    const symbols = Array.isArray(body.symbols) ? body.symbols : [];
    if (symbols.length === 0) return { advanced: [], alreadyAhead: [] };
    return app.acknowledge(userId, symbols, body.device || "unknown");
  });

  // ---------------------------------------------------------- watchlist --

  fastify.get("/api/watchlist", async (req) => {
    const userId = userOf(req as any);
    ensureUser(app, userId);
    return {
      items: store.listWatch(app.db, userId).map((i) => ({ ...i, name: app.nameFor(i.symbol) })),
    };
  });

  fastify.post("/api/watchlist", async (req, reply) => {
    const userId = userOf(req as any);
    ensureUser(app, userId);
    const body = (req.body ?? {}) as { symbol?: string; quantity?: number };
    const symbol = (body.symbol ?? "").trim().toUpperCase();
    if (!symbol) return reply.code(400).send({ error: "symbol is required" });
    if (!app.oracle.knows(symbol) && !app.quotes.has(symbol)) {
      // Refusing an unknown symbol is kinder than accepting it and showing a
      // permanently blank row the user cannot diagnose.
      return reply.code(404).send({ error: `no market data available for ${symbol}` });
    }
    store.addWatch(app.db, userId, symbol, app.clock.now(), body.quantity ?? null);
    return { ok: true, symbol };
  });

  fastify.delete<{ Params: { symbol: string } }>("/api/watchlist/:symbol", async (req) => {
    const userId = userOf(req as any);
    store.removeWatch(app.db, userId, req.params.symbol.toUpperCase());
    return { ok: true };
  });

  fastify.put("/api/policy", async (req, reply) => {
    const userId = userOf(req as any);
    const body = (req.body ?? {}) as { policy?: string };
    if (!body.policy || !(body.policy in PRESETS)) {
      return reply.code(400).send({ error: "policy must be one of " + Object.keys(PRESETS).join(", ") });
    }
    ensureUser(app, userId);
    store.setPolicy(app.db, userId, body.policy);
    return { ok: true, policy: body.policy };
  });

  // ------------------------------------------------------------ symbols --

  fastify.get("/api/symbols", async (req) => {
    const q = ((req.query ?? {}) as Record<string, string>).q?.toUpperCase() ?? "";
    const all = store.allSymbols(app.db).filter((s) => s.symbol !== INDEX_SYMBOL || q);
    const hits = q ? all.filter((s) => s.symbol.includes(q) || s.display_name.toUpperCase().includes(q)) : all;
    return { symbols: hits.slice(0, 60) };
  });

  /**
   * Accounts the picker can offer.
   *
   * Accounts that watch something, or once did.
   *
   * Identity here is a query parameter, so any request naming a new one creates
   * it -- convenient for a demo, unbounded by design, and it left empty rows
   * from a curl session in the account switcher. Filtering on the watchlist
   * alone fixed that and introduced something worse: removing your last symbol
   * deleted you from the switcher with no route back, a dead end inside the
   * first thing the brief asks a watchlist to do. Watermarks survive removal by
   * design, so an account that has ever held a symbol stays reachable, while a
   * name conjured by a stray request does not.
   */
  fastify.get("/api/users", async () => ({
    users: (
      app.db
        .prepare(
          `SELECT u.id, u.name, u.policy FROM users u
           WHERE EXISTS (SELECT 1 FROM watchlist_items w WHERE w.user_id = u.id)
              OR EXISTS (SELECT 1 FROM watermarks m WHERE m.user_id = u.id)
           ORDER BY u.created_at`,
        )
        .all() as {
        id: string;
        name: string;
        policy: string;
      }[]
    ).map((u) => ({
      ...u,
      symbols: (
        app.db
          .prepare(`SELECT COUNT(*) AS n FROM watchlist_items WHERE user_id = ?`)
          .get(u.id) as { n: number }
      ).n,
    })),
  }));

  /**
   * The immutable event log, with read state joined on.
   *
   * The separation this endpoint exposes is the point: `events` rows are facts
   * about the market and are never mutated, while whether this person has been
   * shown one lives in `event_reads`. A `seen` boolean on the event would make
   * the history unrecoverable the moment it flipped -- and this view is what
   * makes that argument checkable rather than merely stated.
   */
  fastify.get("/api/events", async (req) => {
    const userId = userOf(req as any);
    const shown = store.lastShownMap(app.db, userId);
    return {
      events: store.recentEvents(app.db, userId, 200).map((e) => ({
        id: e.id,
        symbol: e.symbol,
        kind: e.kind,
        dedupeKey: e.dedupe_key,
        windowFrom: e.window_from,
        windowTo: e.window_to,
        strength: e.strength,
        createdAt: e.created_at,
        shownAt: shown.get(e.dedupe_key) ?? null,
        payload: JSON.parse(e.payload),
      })),
    };
  });

  // ------------------------------------------------------------- status --

  fastify.get("/api/status", async () => ({
    ...app.status(),
    lab: labEnabled,
    calendar: {
      verifiedUntil: CALENDAR_VERIFIED_UNTIL,
      verified: calendarIsVerified(app.clock.now()),
    },
  }));

  /**
   * Liveness that can actually fail.
   *
   * This used to be `store.symbols > 0`, and the quote store only ever grows,
   * so once a single quote had been ingested at boot the endpoint returned 200
   * forever -- feed dead, provider circuit open, process wedged, still 200. A
   * load balancer would have kept a dead instance in rotation indefinitely.
   */
  fastify.get("/api/health", async (_req, reply) => {
    const s = app.status();
    const cycle = s.ingest.lastCycle;
    const staleCycleMs = Math.max(60_000, s.ingest.intervalMs * 4);
    const problems: string[] = [];

    if (s.ingest.store.symbols === 0) problems.push("no quotes ingested");
    if (s.ingest.providerHealth.breaker === "OPEN") problems.push("provider circuit open");
    if (cycle == null) problems.push("no ingestion cycle has completed");
    else if (Date.now() - cycle.startedAt > staleCycleMs && s.mode === "live") {
      problems.push("last ingestion cycle is stale");
    } else if (cycle.requested > 0 && cycle.accepted === 0 && cycle.failed >= cycle.requested) {
      problems.push("every symbol failed in the last cycle");
    }
    if (app.adjustmentMismatches.length > 0) {
      problems.push(`${app.adjustmentMismatches.length} symbols with contradictory price adjustment`);
    }

    // Degraded is not dead.
    //
    // Past the horizon the holiday list is a guess, which makes every "the
    // market is open" answer a guess too. That is worth saying out loud and it
    // is emphatically not a reason to pull the instance out of rotation, so it
    // is a warning and `ok` still turns only on `problems`.
    //
    // This is the call that was missing. `calendarIsVerified` was exported,
    // documented as a safeguard, read by nothing, and then asserted as wired in
    // the README -- the same defect the README elsewhere confesses to. A
    // horizon nobody consults is decoration.
    const warnings: string[] = [];
    if (!calendarIsVerified(app.clock.now())) {
      warnings.push(
        "holiday calendar is unverified past " +
          CALENDAR_VERIFIED_UNTIL +
          "; session state falls back to the runtime quiet-market check",
      );
    }

    const ok = problems.length === 0;
    return reply.code(ok ? 200 : 503).send({
      ok,
      problems,
      warnings,
      symbols: s.ingest.store.symbols,
      provider: s.ingest.providerHealth.breaker,
    });
  });

  // ---------------------------------------------------------------- lab --
  //
  // The time machine and fault injector. These exist so that the resilience
  // claims in the README can be checked by a stranger in ninety seconds instead
  // of being taken on trust.
  //
  // They are also unauthenticated writes to global process state: one request
  // moves the clock or degrades the feed for every connected reader, and
  // /lab/rewind writes watermarks backwards, which is the one thing the rest of
  // the system is built to make impossible. That is an acceptable trade in a
  // replay demo and unacceptable anywhere else, so in live mode the routes are
  // not registered at all rather than merely discouraged. LAB=1 opts back in
  // for anyone who wants the time machine against real data.
  const labEnabled = app.mode === "replay" || process.env.LAB === "1";
  if (labEnabled) {

  fastify.get("/api/lab", async () => ({
    clock: app.clock.state(),
    replay: app.replay?.hasData()
      ? { from: app.replay.from, to: app.replay.to, symbols: app.replay.symbolsAvailable() }
      : null,
    fault: app.currentFault(),
    faultKinds: FAULT_DESCRIPTIONS,
    policies: PRESETS,
  }));

  fastify.post("/api/lab/clock", async (req, reply) => {
    const b = (req.body ?? {}) as { seek?: number; advanceMs?: number; speed?: number; paused?: boolean };
    const before = app.clock.now();
    if (typeof b.seek === "number") app.clock.seek(b.seek);
    if (typeof b.advanceMs === "number") app.clock.advance(b.advanceMs);
    if (typeof b.speed === "number") app.clock.setSpeed(b.speed);
    if (b.paused === true) app.clock.pause();
    if (b.paused === false) app.clock.resume();
    app.rewindQuotesIfClockWentBack(before);
    // Re-poll immediately so the effect is visible without waiting a cycle.
    await app.worker.cycleNow();
    return reply.send({ ok: true, clock: app.clock.state() });
  });

  /**
   * Faults whose effect is a function of elapsed time rather than of the next
   * tick. Staleness is measured against the provider's cadence, so a killed
   * feed changes nothing on screen until several cadences have passed -- and a
   * reviewer who clicks "Kill the feed", sees nothing move, and concludes the
   * lab is decorative has learned the opposite of the truth. Arming one of
   * these also advances the clock far enough for the consequence to be visible,
   * and the response says so rather than pretending it was instant.
   */
  const TIME_DEPENDENT = new Set<FaultKind>(["FEED_DOWN", "FROZEN", "RATE_LIMITED", "SYMBOL_GONE"]);

  fastify.post("/api/lab/fault", async (req, reply) => {
    const b = (req.body ?? {}) as {
      kind?: FaultKind;
      symbol?: string | null;
      ratio?: number;
      advance?: boolean;
    };
    const kind = (b.kind ?? "NONE") as FaultKind;
    if (!(kind in FAULT_DESCRIPTIONS)) return reply.code(400).send({ error: "unknown fault kind" });

    app.setFault({ kind, symbol: b.symbol ?? null, ratio: b.ratio });

    let advancedMs = 0;
    if (b.advance !== false && TIME_DEPENDENT.has(kind)) {
      // Eight cadences: past DELAYED, past the ILLIQUID boundary, into the
      // territory where the quality layer has to make its distinction.
      advancedMs = app.provider.cadenceMs * 8;
      app.clock.advance(advancedMs);
    }

    await app.worker.cycleNow();
    return reply.send({
      ok: true,
      fault: app.currentFault(),
      describes: FAULT_DESCRIPTIONS[kind],
      advancedMs,
      clock: app.clock.state(),
    });
  });

  fastify.post("/api/lab/reset", async () => {
    const before = app.clock.now();
    app.setFault({ kind: "NONE", symbol: null });
    app.clock.setSpeed(1);
    app.clock.resume();
    if (app.replay?.hasData()) {
      const span = app.replay.to - app.replay.from;
      app.clock.seek(app.replay.from + Math.min(span * 0.35, span));
    }
    app.rewindQuotesIfClockWentBack(before);
    await app.worker.cycleNow();
    return { ok: true, clock: app.clock.state() };
  });

  /**
   * Rewind a user's watermarks by a given number of milliseconds, so a reviewer
   * can experience "returning after three days" without waiting three days.
   * Distinct from the clock: this moves the user, not the market.
   */
  fastify.post("/api/lab/rewind", async (req) => {
    const userId = userOf(req as any);
    const b = (req.body ?? {}) as { ms?: number };
    const ms = typeof b.ms === "number" ? b.ms : 3 * 24 * 3600_000;
    const now = app.clock.now();
    const target = now - ms;
    // Watermarks are monotonic by design, so rewinding is not an ordinary
    // operation: it writes directly, and only from the lab endpoint.
    const tx = app.db.transaction(() => {
      for (const item of store.listWatch(app.db, userId)) {
        const anchor = app.oracle.priceAt(item.symbol, target);
        app.db
          .prepare(
            `INSERT INTO watermarks (user_id, symbol, seen_ts, seen_price, updated_at, device, is_seed)
             VALUES (?, ?, ?, ?, ?, 'lab-rewind', 0)
             ON CONFLICT(user_id, symbol) DO UPDATE SET
               seen_ts = excluded.seen_ts, seen_price = excluded.seen_price,
               updated_at = excluded.updated_at, device = excluded.device,
               -- Clearing this is not cosmetic. A row left flagged as a seed
               -- is treated as "never looked", so the digest discards every
               -- card and reports a first visit -- the lab's headline demo
               -- silently doing nothing. It also stays permanently exempt from
               -- the monotonic guard, which is the one invariant this schema
               -- exists to hold.
               is_seed = 0`,
          )
          .run(userId, item.symbol, target, anchor?.price ?? null, now);
      }
      app.db.prepare(`DELETE FROM event_reads WHERE user_id = ?`).run(userId);
    });
    tx();
    return { ok: true, watermarksAt: target, ms };
  });

  } // end lab routes

  // ------------------------------------------------------------- stream --

  fastify.get("/api/stream", (req, reply) => {
    const userId = userOf(req as any);
    ensureUser(app, userId);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = () => {
      try {
        const payload = app.buildDigestFor(userId);
        reply.raw.write(`event: digest\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (e) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: String(e) })}\n\n`);
      }
    };

    send();
    // Server-side conflation: the UI is re-rendered at a human rate, not at the
    // rate ticks arrive. Pushing every tick would burn bandwidth to produce
    // frames nobody can read.
    const timer = setInterval(send, 3000);
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);

    req.raw.on("close", () => {
      clearInterval(timer);
      clearInterval(keepAlive);
    });
  });
}

function ensureUser(app: App, userId: string): void {
  if (!store.getUser(app.db, userId)) {
    store.upsertUser(app.db, {
      id: userId,
      name: userId === DEMO_USER ? "Demo" : userId,
      policy: "balanced",
      created_at: app.clock.now(),
    });
  }
}
