/**
 * Regressions.
 *
 * Every test here reproduces a defect that shipped, was found by review rather
 * than by the suite, and would have been visible to a user within the first
 * minute of using the product. They are kept together because what they have in
 * common is more instructive than what each one is: none of them threw, none
 * produced a number outside a plausible range, and the existing tests all
 * passed while they were live. Three of them passed *because* of how the
 * fixtures were shaped.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { App } from "../src/app.js";
import { detect, PRESETS, STRUCTURAL_ABS } from "../src/core/detect.js";
import { emptyBaseline } from "../src/core/baseline.js";
import { NO_ACTIONS } from "../src/core/corporate.js";
import { toPaise } from "../src/core/money.js";
import {
  istAt,
  sessionAt,
  sessionsBetween,
  riskHorizonSessions,
  GAP_VARIANCE_SHARE,
} from "../src/core/calendar.js";
import { assess, SANITY_BAND } from "../src/core/quality.js";
import * as store from "../src/store/db.js";
import Fastify from "fastify";
import { registerRoutes } from "../src/api/routes.js";
import { CALENDAR_VERIFIED_UNTIL } from "../src/core/calendar.js";

const DATA = join(process.cwd(), "..", "data");
const HAVE = existsSync(join(DATA, "history"));
const d = HAVE ? describe : describe.skip;

/** Signals that would become a card. Near misses are ledger rows, not cards. */
const cards = (signals: { kind: string }[]) => signals.filter((s) => s.kind !== "NOTHING_UNUSUAL");

function detectWith(over: Partial<Parameters<typeof detect>[0]> & { now: number; watermarkTs: number }) {
  const now = over.now;
  const baseline = over.baseline ?? emptyBaseline("TEST");
  const price = over.price ?? toPaise(101)!;
  const prevClose = over.prevClose ?? toPaise(100)!;
  const assessment =
    over.assessment ??
    assess(
      { symbol: "TEST", ltp: price, prevClose, exchangeTs: now - 1000, ingestTs: now },
      {
        now,
        session: sessionAt(now),
        cadenceMs: 30_000,
        universeFreshestTs: now - 1000,
        circuitBand: SANITY_BAND,
      },
    );
  return detect({
    symbol: "TEST",
    watermarkPrice: prevClose,
    price,
    prevClose,
    exchangeTs: now - 1000,
    dayVolume: null,
    maxSessionMove: null,
    assessment,
    baseline,
    actions: NO_ACTIONS("TEST"),
    marketReturn: null,
    circuitBand: 0.2,
    policy: PRESETS.balanced,
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe("the horizon a move is judged over", () => {
  const FRI_CLOSE = istAt("2026-09-04", 15 * 60 + 30);
  const MON_OPEN = istAt("2026-09-07", 9 * 60 + 16);

  it("charges the overnight gap what the gap is worth", () => {
    // Volatility is estimated close to close, and a close-to-close return is
    // roughly a quarter overnight gap and three quarters session. Elapsed
    // *trading* time across a weekend is zero, so scaling by it alone inflated
    // the z-score up to nineteenfold. Charging a whole session instead — the
    // first attempt at this fix — deflated it by about two, in the window the
    // product is named after. Variance is additive, so the horizon is.
    // 09:16 is one minute past the open, so the gap term dominates and the
    // session term contributes that single minute. Both are present.
    expect(sessionsBetween(FRI_CLOSE, MON_OPEN)).toBeLessThan(0.01);
    const oneMinute = (1 / 375) * (1 - GAP_VARIANCE_SHARE);
    expect(riskHorizonSessions(FRI_CLOSE, MON_OPEN)).toBeCloseTo(GAP_VARIANCE_SHARE + oneMinute, 4);

    // A full close-to-close window is exactly one unit, which is what the
    // baseline measured. Neither term may be dropped or the identity breaks.
    const friClose = istAt("2026-09-04", 15 * 60 + 30);
    const monClose = istAt("2026-09-07", 15 * 60 + 30);
    expect(riskHorizonSessions(friClose, monClose)).toBeCloseTo(1, 3);

    // Inside one session no gap is crossed, so only the session term applies.
    const open = istAt("2026-09-08", 9 * 60 + 15);
    const noon = istAt("2026-09-08", 12 * 60);
    expect(riskHorizonSessions(open, noon)).toBeCloseTo(
      sessionsBetween(open, noon) * (1 - GAP_VARIANCE_SHARE),
      6,
    );
  });

  it("does not call an ordinary Monday gap a data fault", () => {
    // The shipped behaviour was a card reading "that is 13 standard deviations
    // for this stock ... verify against the exchange" for a one percent gap.
    const b = emptyBaseline("TEST");
    b.dailyVol = 0.015;
    b.observations = 400;

    const signals = detectWith({
      now: MON_OPEN,
      watermarkTs: FRI_CLOSE,
      prevClose: toPaise(100)!,
      price: toPaise(101)!,
      baseline: b,
    });
    // Nothing is *surfaced*. A near miss is still recorded, so the held-back
    // ledger can say how close it came -- that is a ledger row, not a card.
    expect(signals.map((s) => s.kind)).not.toContain("SUSPECTED_STRUCTURAL");
    expect(cards(signals)).toHaveLength(0);
    expect(signals.map((s) => s.kind)).toEqual(["NOTHING_UNUSUAL"]);
  });
});

describe("what the structural guard is allowed to swallow", () => {
  const from = istAt("2026-09-03", 15 * 60 + 30);
  const now = istAt("2026-09-04", 15 * 60 + 25);
  const baseline = () => {
    const b = emptyBaseline("TEST");
    b.dailyVol = 0.012; // a typical NSE large cap
    b.residualVol = 0.0099;
    b.beta = 1.0;
    b.observations = 480;
    b.betaObservations = 470;
    return b;
  };

  it("reports a genuine crash as news, however many sigmas it is", () => {
    // A real 28% single-session fall is roughly 28 sigma for a typical name.
    // A relative threshold low enough to catch a split therefore swallows the
    // largest true event the product will ever have to report -- which is what
    // a 12-sigma arm did, for 47 of the 49 equities on the shipped list.
    const signals = detectWith({
      now,
      watermarkTs: from,
      prevClose: toPaise(1000)!,
      price: toPaise(720)!,
      baseline: baseline(),
      maxSessionMove: -0.28,
    });
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("MOVE");
    expect(kinds).not.toContain("SUSPECTED_STRUCTURAL");
  });

  it("judges the session, not the window", () => {
    // A mutation reverting `maxSessionMove` to the window return used to pass
    // the whole suite, because every case here pinned the watermark price to
    // the previous close and the two quantities were identical by construction.
    // They must not be: a stock that drifts back near its old price after a
    // structural collapse has a small window return and a catastrophic session.
    const signals = detectWith({
      now,
      watermarkTs: now - 60 * 24 * 3600_000,
      watermarkPrice: toPaise(105)!, // window return is only -4.8%
      prevClose: toPaise(300)!,
      price: toPaise(100)!, // ...but the session itself is -66%
      baseline: baseline(),
      maxSessionMove: -0.66,
    });
    expect(signals.map((s) => s.kind)).toContain("SUSPECTED_STRUCTURAL");
  });

  it("is not switched off by a dividend far too small to explain the move", () => {
    // The predicate compared a window-level explained *fraction* against a
    // session-level magnitude, so over a long window — where the net return can
    // be near zero — a trivial dividend accounted for a large fraction of it and
    // silenced the guard. It is now the action's own price impact against the
    // size of the session move, which no rupee of dividend can reach.
    const t0 = now - 180 * 24 * 3600_000;
    const tinyDividend = {
      symbol: "TEST",
      splits: [],
      dividends: [{ exDateTs: t0 + 5 * 24 * 3600_000, amount: toPaise(0.7)! }],
    };
    const signals = detectWith({
      now,
      watermarkTs: t0,
      watermarkPrice: toPaise(100)!,
      prevClose: toPaise(300)!,
      price: toPaise(99)!, // window return ~ -1%, session -67%
      baseline: baseline(),
      maxSessionMove: -0.67,
      actions: tinyDividend,
    });
    expect(signals.map((s) => s.kind)).toContain("SUSPECTED_STRUCTURAL");
  });

  it("still catches an undocumented split however long the user was away", () => {
    // Measured across the window, a 90% overnight fall shrinks below any
    // sensible threshold once enough sessions surround it, and the user was
    // told their holding had simply lost half its value. The test is per
    // session, so absence length cannot change the verdict.
    for (const days of [1, 30, 90]) {
      const signals = detectWith({
        now,
        watermarkTs: now - days * 24 * 3600_000,
        prevClose: toPaise(1000)!,
        price: toPaise(100)!,
        baseline: baseline(),
        maxSessionMove: -0.9,
      });
      expect(signals.map((s) => s.kind), `away ${days} days`).toContain("SUSPECTED_STRUCTURAL");
    }
  });

  it("is not switched off by an unrelated dividend sitting in the window", () => {
    // The predicate used to be "no corporate actions at all", so a single
    // dividend disabled the defence entirely -- and over a year the chance of
    // some action falling in the window approaches nine in ten.
    const t0 = now - 40 * 24 * 3600_000;
    const withDividend = {
      symbol: "TEST",
      splits: [],
      dividends: [{ exDateTs: t0 + 5 * 24 * 3600_000, amount: toPaise(11)! }],
    };
    const signals = detectWith({
      now,
      watermarkTs: t0,
      prevClose: toPaise(1000)!,
      price: toPaise(100)!,
      baseline: baseline(),
      maxSessionMove: -0.9,
      actions: withDividend,
    });
    expect(signals.map((s) => s.kind)).toContain("SUSPECTED_STRUCTURAL");
  });

  it("stays quiet when a known split fully explains the move", () => {
    const t0 = now - 5 * 24 * 3600_000;
    const withSplit = {
      symbol: "TEST",
      splits: [{ exDateTs: t0 + 2 * 24 * 3600_000, numerator: 10, denominator: 1, ratio: "10:1" }],
      dividends: [],
    };
    const signals = detectWith({
      now,
      watermarkTs: t0,
      prevClose: toPaise(1000)!,
      price: toPaise(100)!,
      baseline: baseline(),
      maxSessionMove: -0.9,
      actions: withSplit,
    });
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("CORPORATE_ACTION");
    expect(kinds).not.toContain("SUSPECTED_STRUCTURAL");
  });

  it("uses a threshold no real Indian equity reaches between two closes", () => {
    expect(STRUCTURAL_ABS).toBeGreaterThan(0.28); // Adani Enterprises, Jan 2023
    expect(STRUCTURAL_ABS).toBeLessThan(0.649); // Vedanta demerger, Apr 2026
  });
});

describe("bucking the market describes a card, it does not qualify one", () => {
  it("does not surface a sub-threshold move because the signs happened to differ", () => {
    // A defensive name drifting up 0.3% while the index is down 0.5% has almost
    // no residual. Discounting the threshold to 0.7x whenever the raw signs
    // disagreed fired for one in eight symbol-sessions whose residual was under
    // a single sigma, and voided the constant false-positive rate outright.
    const b = emptyBaseline("TEST");
    b.dailyVol = 0.012;
    b.residualVol = 0.012;
    b.beta = 0.2;
    b.observations = 480;
    b.betaObservations = 470;

    const now = istAt("2026-09-08", 12 * 60);
    const signals = detectWith({
      now,
      watermarkTs: istAt("2026-09-08", 9 * 60 + 15),
      prevClose: toPaise(1000)!,
      price: toPaise(1003)!, // +0.3%
      baseline: b,
      marketReturn: -0.005,
    });
    expect(cards(signals)).toHaveLength(0);
  });

  it("does not admit a move that clears only the discounted bar", () => {
    // The old escalation multiplied the threshold by 0.7 whenever the raw signs
    // differed. A mutation restoring it survived the suite, because the existing
    // case was blocked by the absolute floor before the z-test was ever
    // consulted. This one clears the floor comfortably and lands between the
    // discounted bar and the real one, so only the discount can surface it.
    const b = emptyBaseline("TEST");
    b.dailyVol = 0.012;
    b.residualVol = 0.012;
    b.beta = 0.2;
    b.observations = 480;
    b.betaObservations = 470;

    const open = istAt("2026-09-08", 9 * 60 + 15);
    const now = istAt("2026-09-08", 15 * 60 + 25);
    // ~1.7 sigma over most of a session: above 0.7 x 2.0, below 2.0.
    const signals = detectWith({
      now,
      watermarkTs: open,
      prevClose: toPaise(1000)!,
      price: toPaise(1017)!,
      baseline: b,
      marketReturn: -0.006,
    });
    const z = signals.find((s) => s.kind === "NOTHING_UNUSUAL")?.evidence.z;
    expect(Math.abs(Number(z))).toBeGreaterThan(PRESETS.balanced.moveZ * 0.7);
    expect(Math.abs(Number(z))).toBeLessThan(PRESETS.balanced.moveZ);
    expect(cards(signals)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

d("a price lookup answers about the past only", () => {
  const app = new App({ dataDir: DATA, dbPath: ":memory:", mode: "replay" });

  it("never returns an observation from after the instant asked about", () => {
    // Daily bars arrive stamped at the session open while carrying the
    // session's close, so every intraday lookup answered with the closing price
    // and labelled it with the morning. "Since you last looked" therefore
    // collapsed to roughly zero for any absence inside a single day, while the
    // conventional "today" figure printed beside it stayed correct.
    let violations = 0;
    let checked = 0;
    for (const symbol of ["RELIANCE", "HDFCBANK", "TCS", "ITC", "SBIN"]) {
      for (const minutes of [9 * 60 + 20, 10 * 60, 12 * 60, 14 * 60, 15 * 60 + 25]) {
        const t = istAt("2026-09-04", minutes);
        const p = app.oracle.priceAt(symbol, t);
        checked++;
        if (p && p.observedAt > t) violations++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(violations).toBe(0);
  });

  it("anchors a morning lookup to the previous session's close", () => {
    const t = istAt("2026-09-04", 10 * 60);
    const p = app.oracle.priceAt("RELIANCE", t)!;
    expect(p).not.toBeNull();
    // Yesterday's close, not today's.
    expect(p.observedAt).toBeLessThan(istAt("2026-09-04", 0));
  });

  it("distinguishes a single-session collapse from a long decline", () => {
    // The value the structural guard runs on.
    const worst = app.oracle.maxSessionMove(
      "VEDL",
      istAt("2026-01-01", 0),
      istAt("2026-09-04", 15 * 60 + 30),
    );
    expect(worst).not.toBeNull();
    expect(worst!).toBeLessThan(-0.6); // the demerger, seen as one session
  });

  app.close();
});

d("acknowledging that you have looked", () => {
  it("advances a freshly seeded watermark on the first click", () => {
    // The seed is written at wall-clock time and every exchange timestamp is
    // older, so a monotonic guard rejected the first acknowledgement outright.
    // The button silently did nothing, and the digest stayed pinned to its
    // first-visit copy forever -- most reliably while the market was shut,
    // which is when the app is most often opened.
    const app = new App({ dataDir: DATA, dbPath: ":memory:", mode: "replay" });
    const now = app.clock.now();
    store.upsertUser(app.db, { id: "u1", name: "U", policy: "balanced", created_at: now });
    store.addWatch(app.db, "u1", "RELIANCE", now, null);

    const before = store.getWatermarks(app.db, "u1").get("RELIANCE")!;
    expect(before.is_seed).toBe(1);

    const first = app.acknowledge("u1", ["RELIANCE"], "test-device");
    expect(first.advanced).toEqual(["RELIANCE"]);

    const after = store.getWatermarks(app.db, "u1").get("RELIANCE")!;
    expect(after.is_seed).toBe(0);
    expect(after.device).toBe("test-device");
    app.close();
  });

  it("still refuses to move a real watermark backwards", () => {
    // The monotonic guarantee is the point; only the seed placeholder is exempt.
    const app = new App({ dataDir: DATA, dbPath: ":memory:", mode: "replay" });
    const now = app.clock.now();
    store.upsertUser(app.db, { id: "u2", name: "U", policy: "balanced", created_at: now });
    store.addWatch(app.db, "u2", "RELIANCE", now, null);

    expect(store.advanceWatermark(app.db, "u2", "RELIANCE", now + 60_000, null, "phone", now)).toBe(true);
    // A laptop that has been asleep tries to write an older position.
    expect(store.advanceWatermark(app.db, "u2", "RELIANCE", now - 3600_000, null, "laptop", now)).toBe(false);
    expect(store.getWatermarks(app.db, "u2").get("RELIANCE")!.seen_ts).toBe(now + 60_000);
    expect(store.getWatermarks(app.db, "u2").get("RELIANCE")!.device).toBe("phone");
    app.close();
  });

  it("merges to the maximum whichever device writes first", () => {
    const app = new App({ dataDir: DATA, dbPath: ":memory:", mode: "replay" });
    const now = app.clock.now();
    for (const [user, order] of [
      ["a", [now + 1000, now + 5000]],
      ["b", [now + 5000, now + 1000]],
    ] as [string, number[]][]) {
      store.upsertUser(app.db, { id: user, name: user, policy: "balanced", created_at: now });
      store.addWatch(app.db, user, "TCS", now, null);
      for (const ts of order) store.advanceWatermark(app.db, user, "TCS", ts, null, "d", now);
    }
    const a = store.getWatermarks(app.db, "a").get("TCS")!.seen_ts;
    const b = store.getWatermarks(app.db, "b").get("TCS")!.seen_ts;
    expect(a).toBe(b); // commutative, so sync order cannot matter
    app.close();
  });
});

d("a first visit has nothing to compare against", () => {
  it("surfaces no cards at all, which is what the copy says", () => {
    // The headline read "Nothing is flagged on a first visit" while a card sat
    // underneath it. A screen that contradicts itself in its first two lines is
    // worse than either half alone.
    const app = new App({ dataDir: DATA, dbPath: ":memory:", mode: "replay" });
    const now = app.clock.now();
    store.upsertUser(app.db, { id: "fresh", name: "Fresh", policy: "balanced", created_at: now });
    for (const s of ["RELIANCE", "TATAMOTORS", "TCS"]) store.addWatch(app.db, "fresh", s, now, null);

    const { digest } = app.buildDigestFor("fresh");
    expect(digest.absence.isFirstVisit).toBe(true);
    expect(digest.cards).toHaveLength(0);
    expect(digest.headline).toMatch(/baseline/i);
    app.close();
  });
});


d("the verified horizon of the holiday calendar", () => {
  /**
   * `calendarIsVerified` was exported, carried a doc comment calling an unread
   * horizon "worse than not having one, because it reads like a safeguard", was
   * called by nothing in the entire tree, and was then asserted as wired in the
   * README. DECISIONS.md had already recorded it as a found defect. Nobody
   * fixed it; the document just claimed it was fixed.
   *
   * These two tests exist so that a horizon nobody consults fails the suite
   * rather than passing review. The first pins that it is read at all; the
   * second pins that reading it does not take a healthy instance out of
   * rotation, which is the mistake the obvious fix would make.
   */
  async function health(atMs: number) {
    const app = new App({ dataDir: DATA, dbPath: ":memory:", mode: "replay" });
    app.clock.seek(atMs);
    const fastify = Fastify({ logger: false });
    await registerRoutes(fastify, app);
    const res = await fastify.inject({ method: "GET", url: "/api/health" });
    await fastify.close();
    return {
      status: res.statusCode,
      body: res.json() as { ok: boolean; problems: string[]; warnings?: string[] },
    };
  }

  const dayAfterHorizon = Date.parse(CALENDAR_VERIFIED_UNTIL + "T12:00:00+05:30") + 86_400_000;

  it("is reported once the clock passes it", async () => {
    const { body } = await health(dayAfterHorizon);
    expect(body.warnings ?? []).toEqual([expect.stringContaining(CALENDAR_VERIFIED_UNTIL)]);
  });

  it("is a warning and not a liveness failure, because a guess is not an outage", async () => {
    // Assert on `problems`, not on the status code: this harness never runs an
    // ingestion cycle, so the endpoint is legitimately unhealthy for a reason
    // that has nothing to do with the calendar. The invariant that matters is
    // that crossing the horizon changes only the warnings.
    const within = await health(Date.parse("2025-06-01T12:00:00+05:30"));
    const past = await health(dayAfterHorizon);

    expect(within.body.warnings ?? []).toEqual([]);
    expect(past.body.warnings ?? []).toHaveLength(1);
    expect(past.body.problems).toEqual(within.body.problems);
    expect(past.status).toBe(within.status);
  });
});
