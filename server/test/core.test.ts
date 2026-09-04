import { describe, it, expect } from "vitest";
import { toPaise, ret, formatPct, formatPaise } from "../src/core/money.js";
import { ewmaVol, betaAndResidualVol, toReturns, stdev, scaleVol } from "../src/core/stats.js";
import {
  sessionAt,
  sessionsBetween,
  istAt,
  istDate,
  isTradingDay,
  lastRegularClose,
  detectUnexpectedlyQuiet,
} from "../src/core/calendar.js";
import {
  splitFactor,
  dividendPerCurrentShare,
  decomposeReturn,
  backAdjustCloses,
  NO_ACTIONS,
  type CorporateActions,
} from "../src/core/corporate.js";
import { assess, DEFAULT_CIRCUIT_BAND, SANITY_BAND } from "../src/core/quality.js";
import { narrate, pickMode, describeAbsence, buildDigest } from "../src/core/digest.js";

// ---------------------------------------------------------------- money ----

describe("money", () => {
  it("stores prices as integer paise", () => {
    expect(toPaise(1328.0)).toBe(132800);
    expect(toPaise(2456.35)).toBe(245635);
  });

  it("rejects values that are not prices instead of propagating them", () => {
    expect(toPaise(NaN)).toBeNull();
    expect(toPaise(Infinity)).toBeNull();
    expect(toPaise(-5)).toBeNull();
    expect(toPaise(null)).toBeNull();
  });

  it("survives the accumulation that breaks float thresholds", () => {
    // 0.1 + 0.2 !== 0.3 in float. In paise it is exact, which matters because
    // every threshold in this system is a comparison.
    let acc = 0;
    for (let i = 0; i < 1000; i++) acc += toPaise(0.1)!;
    expect(acc).toBe(100_00);
  });

  it("returns null rather than Infinity on a zero base", () => {
    expect(ret(0, 100)).toBeNull();
    expect(ret(null, 100)).toBeNull();
    expect(ret(100, 110)).toBeCloseTo(0.1, 10);
  });

  it("formats with Indian digit grouping", () => {
    expect(formatPaise(12345678)).toBe("1,23,456.78");
    expect(formatPct(0.0421)).toBe("+4.21%");
    expect(formatPct(-0.0421)).toBe("-4.21%");
  });
});

// ---------------------------------------------------------------- stats ----

describe("stats", () => {
  it("refuses to produce a volatility from thin data", () => {
    expect(ewmaVol([0.01, -0.02, 0.005], 20, 30)).toBeNull();
  });

  it("weights recent observations more than old ones", () => {
    const calm = new Array(120).fill(0.001);
    const recentShock = [...calm, 0.08, -0.07, 0.09];
    const a = ewmaVol(calm, 20)!;
    const b = ewmaVol(recentShock, 20)!;
    expect(b).toBeGreaterThan(a * 3);

    // The same shock, long ago, must matter much less.
    const oldShock = [0.08, -0.07, 0.09, ...calm];
    expect(ewmaVol(oldShock, 20)!).toBeLessThan(b);
  });

  it("recovers a known beta and separates idiosyncratic movement", () => {
    const market: number[] = [];
    const asset: number[] = [];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
    for (let i = 0; i < 400; i++) {
      const m = rnd() * 0.02;
      market.push(m);
      asset.push(1.5 * m + rnd() * 0.004); // beta 1.5 plus small private noise
    }
    const r = betaAndResidualVol(asset, market)!;
    expect(r.beta).toBeGreaterThan(1.35);
    expect(r.beta).toBeLessThan(1.65);
    // Residual vol must be far below the asset's total vol: that gap is exactly
    // the noise reduction the market adjustment buys us.
    expect(r.residualVol).toBeLessThan(stdev(asset)! * 0.5);
  });

  it("returns null when there is not enough paired history for a beta", () => {
    expect(betaAndResidualVol([0.01, 0.02], [0.01, 0.02])).toBeNull();
  });

  it("scales daily volatility by root-time", () => {
    expect(scaleVol(0.02, 4)).toBeCloseTo(0.04, 10);
  });

  it("drops non-finite gaps when converting prices to returns", () => {
    expect(toReturns([100, null, 110, 121])).toEqual([0.1]);
  });
});

// -------------------------------------------------------------- calendar ----

describe("NSE calendar", () => {
  const on = (d: string, hhmm: string) =>
    istAt(d, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

  it("classifies the sessions of a normal trading day", () => {
    // 2026-09-08 is a Tuesday.
    expect(sessionAt(on("2026-09-08", "08:30")).session).toBe("CLOSED");
    expect(sessionAt(on("2026-09-08", "09:05")).session).toBe("PRE_OPEN");
    expect(sessionAt(on("2026-09-08", "11:00")).session).toBe("REGULAR");
    expect(sessionAt(on("2026-09-08", "15:45")).session).toBe("POST_CLOSE");
    expect(sessionAt(on("2026-09-08", "20:00")).session).toBe("CLOSED");
  });

  it("treats only the continuous session as live", () => {
    expect(sessionAt(on("2026-09-08", "09:05")).isLive).toBe(false);
    expect(sessionAt(on("2026-09-08", "11:00")).isLive).toBe(true);
  });

  it("knows weekends and holidays are not trading days", () => {
    expect(isTradingDay(on("2026-09-05", "11:00"))).toBe(false); // Saturday
    expect(isTradingDay(on("2026-09-06", "11:00"))).toBe(false); // Sunday
    expect(isTradingDay(on("2026-08-15", "11:00"))).toBe(false); // Independence Day
    expect(isTradingDay(on("2026-09-08", "11:00"))).toBe(true);
  });

  it("counts zero sessions across a weekend, however many hours elapsed", () => {
    // Friday 16:00 -> Monday 09:00 is 65 wall-clock hours and zero sessions.
    // Telling a user "you were away 3 days" here would be true and misleading.
    const fri = on("2026-09-04", "16:00");
    const mon = on("2026-09-07", "09:00");
    expect(mon - fri).toBeGreaterThan(64 * 3600_000);
    expect(sessionsBetween(fri, mon)).toBe(0);
  });

  it("counts a partial session as a fraction", () => {
    const open = on("2026-09-08", "09:15");
    const mid = on("2026-09-08", "12:22"); // ~half of the 375-minute session
    const s = sessionsBetween(open, mid);
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.6);
  });

  it("walks back over a weekend to find the real last close", () => {
    const sun = on("2026-09-06", "10:00");
    expect(istDate(lastRegularClose(sun))).toBe("2026-09-04");
  });

  it("stops claiming the market is live when the whole universe goes quiet", () => {
    const now = on("2026-09-08", "11:00");
    const state = sessionAt(now);
    expect(detectUnexpectedlyQuiet(state, now - 60_000, now)).toBe(false);
    expect(detectUnexpectedlyQuiet(state, now - 20 * 60_000, now)).toBe(true);
    expect(detectUnexpectedlyQuiet(state, null, now)).toBe(true);
    // ...but silence outside market hours is expected, not an incident.
    const night = on("2026-09-08", "23:00");
    expect(detectUnexpectedlyQuiet(sessionAt(night), null, night)).toBe(false);
  });
});

// ---------------------------------------------------- corporate actions ----

const DAY = 24 * 3600_000;

function withSplit(exDateTs: number, num: number, den: number): CorporateActions {
  return {
    symbol: "TEST",
    splits: [{ exDateTs, numerator: num, denominator: den, ratio: `${num}:${den}` }],
    dividends: [],
  };
}

describe("corporate actions", () => {
  const t0 = istAt("2026-01-01", 0);

  it("applies a split on the half-open interval, never twice", () => {
    const ca = withSplit(t0 + 5 * DAY, 10, 1);
    expect(splitFactor(ca, t0, t0 + 10 * DAY)).toBeCloseTo(0.1, 12);
    // Ex-date equal to the window start is already in the price at the start.
    expect(splitFactor(ca, t0 + 5 * DAY, t0 + 10 * DAY)).toBe(1);
    // Entirely before or after the window: no effect.
    expect(splitFactor(ca, t0 + 6 * DAY, t0 + 10 * DAY)).toBe(1);
  });

  it("turns a 10:1 split from a 90% crash into a flat position", () => {
    // The Nestle India case: 27,000 -> 2,700 overnight.
    const ca = withSplit(t0 + 1 * DAY, 10, 1);
    const d = decomposeReturn(toPaise(27000), t0, toPaise(2700), t0 + 2 * DAY, ca);
    expect(d.raw!).toBeCloseTo(-0.9, 3); // what a naive watchlist shows
    expect(d.adjusted!).toBeCloseTo(0, 6); // what actually happened
    expect(d.isArtifact).toBe(true);
    expect(d.explainedFraction).toBeGreaterThan(0.99);
  });

  it("still reports the real move inside a split window", () => {
    const ca = withSplit(t0 + 1 * DAY, 10, 1);
    // 10:1 split AND a genuine 5% gain: 27,000 -> 2,835.
    const d = decomposeReturn(toPaise(27000), t0, toPaise(2835), t0 + 2 * DAY, ca);
    expect(d.adjusted!).toBeCloseTo(0.05, 6);
    // Explained fraction is high, so the corporate-action card leads, but the
    // adjusted number carried on it is the true 5%.
    expect(d.actions[0]!.kind).toBe("SPLIT");
  });

  it("credits a dividend back to the holder", () => {
    const ca: CorporateActions = {
      symbol: "TEST",
      splits: [],
      dividends: [{ exDateTs: t0 + DAY, amount: toPaise(10)! }],
    };
    // Price fell exactly by the dividend: the holder is flat, not down.
    const d = decomposeReturn(toPaise(1000), t0, toPaise(990), t0 + 2 * DAY, ca);
    expect(d.raw!).toBeCloseTo(-0.01, 6);
    expect(d.adjusted!).toBeCloseTo(0, 6);
  });

  it("scales a dividend paid before a later split", () => {
    // Rs 10 per old share, then a 10:1 split, is Rs 1 per share as counted now.
    const ca: CorporateActions = {
      symbol: "TEST",
      splits: [{ exDateTs: t0 + 5 * DAY, numerator: 10, denominator: 1, ratio: "10:1" }],
      dividends: [{ exDateTs: t0 + DAY, amount: toPaise(10)! }],
    };
    expect(dividendPerCurrentShare(ca, t0, t0 + 10 * DAY)).toBe(toPaise(1));
  });

  it("does not label an ordinary move as a corporate-action artifact", () => {
    const d = decomposeReturn(toPaise(100), t0, toPaise(93), t0 + DAY, NO_ACTIONS("TEST"));
    expect(d.isArtifact).toBe(false);
    expect(d.adjusted!).toBeCloseTo(-0.07, 6);
  });

  it("back-adjusts a series so the split stops looking like a return", () => {
    const ts = [t0, t0 + DAY, t0 + 2 * DAY, t0 + 3 * DAY];
    const closes = [toPaise(27000), toPaise(27100), toPaise(2700), toPaise(2710)];
    const ca = withSplit(t0 + 2 * DAY, 10, 1);
    const adj = backAdjustCloses(closes, ts, ca);
    const rs = toReturns(adj);
    expect(Math.max(...rs.map(Math.abs))).toBeLessThan(0.05);
  });
});

// -------------------------------------------------------------- quality ----

describe("quote quality", () => {
  const openNow = istAt("2026-09-08", 11 * 60);
  const session = sessionAt(openNow);
  const base = {
    now: openNow,
    session,
    cadenceMs: 30_000,
    universeFreshestTs: openNow - 5_000,
    circuitBand: DEFAULT_CIRCUIT_BAND,
  };
  const q = (over: Partial<Parameters<typeof assess>[0]> = {}) => ({
    symbol: "TEST",
    ltp: toPaise(100),
    prevClose: toPaise(100),
    exchangeTs: openNow - 5_000,
    ingestTs: openNow,
    ...over,
  });

  it("is LIVE inside the provider cadence", () => {
    expect(assess(q(), base).quality).toBe("LIVE");
  });

  it("separates a thin stock from a broken feed", () => {
    const old = { exchangeTs: openNow - 25 * 60_000 };
    // Everything else is printing: this stock is simply illiquid.
    expect(assess(q(old), base).quality).toBe("ILLIQUID");
    // Nothing is printing: the feed is the problem, and we stop trusting it.
    const dead = { ...base, universeFreshestTs: openNow - 25 * 60_000 };
    const a = assess(q(old), dead);
    expect(a.quality).toBe("STALE");
    expect(a.usableForSignals).toBe(false);
  });

  it("treats an old price as correct when the market is shut", () => {
    const sun = istAt("2026-09-06", 10 * 60);
    const a = assess(q({ exchangeTs: sun - 40 * 3600_000 }), {
      ...base,
      now: sun,
      session: sessionAt(sun),
      universeFreshestTs: null,
    });
    expect(a.quality).toBe("CLOSED");
    expect(a.displayable).toBe(true);
    expect(a.usableForSignals).toBe(true);
  });

  it("refuses to score signals off a value it does not believe", () => {
    // The threshold itself is configurable; what matters is that a rejected
    // value is never shown and never reaches detection.
    const a = assess(q({ ltp: toPaise(140) }), base); // 40%, band here is 20%
    expect(a.quality).toBe("SUSPECT");
    expect(a.usableForSignals).toBe(false);
    expect(a.displayable).toBe(false);
  });

  it("rejects non-positive prices and future timestamps", () => {
    expect(assess(q({ ltp: 0 }), base).quality).toBe("SUSPECT");
    expect(assess(q({ ltp: toPaise(-1) }), base).quality).toBe("UNAVAILABLE");
    expect(assess(q({ exchangeTs: openNow + 5 * 60_000 }), base).quality).toBe("SUSPECT");
  });

  it("lets a corporate-action-sized move through to the detector", () => {
    // A 10:1 split prints at exactly a tenth of the previous close, and a real
    // demerger printed at -65%. Neither is corrupt, and calling them corrupt
    // costs the user the one explanation that would have helped. This layer
    // passes them on; detect() decides what they are.
    const production = { ...base, circuitBand: SANITY_BAND };
    expect(assess(q({ ltp: toPaise(10) }), production).quality).toBe("LIVE"); // 10:1 split
    expect(assess(q({ ltp: toPaise(35) }), production).quality).toBe("LIVE"); // demerger
    expect(assess(q({ ltp: toPaise(147) }), production).quality).toBe("LIVE"); // +47%
  });

  it("still rejects a magnitude that cannot be a price under any reading", () => {
    const production = { ...base, circuitBand: SANITY_BAND };
    // Paise reported where rupees were expected.
    const a = assess(q({ ltp: toPaise(8500) }), production);
    expect(a.quality).toBe("SUSPECT");
    expect(a.displayable).toBe(false);
    expect(a.reason).toMatch(/units or encoding/);
  });

  it("reports a missing symbol as unavailable, not as a zero price", () => {
    const a = assess(q({ ltp: null, exchangeTs: null }), base);
    expect(a.quality).toBe("UNAVAILABLE");
    expect(a.displayable).toBe(false);
  });
});


// --------------------------------------------------------------- digest ----

describe("narrative facts", () => {
  const t0 = istAt("2026-08-03", 9 * 60 + 15); // a Monday
  const day = (n: number) => t0 + n * 24 * 3600_000;

  it("finds the biggest session close to close, not within a date", () => {
    // The shape a long window actually has: one closing price per session.
    // Measuring inside each date would score every day at zero.
    const path = [
      { ts: day(0), price: toPaise(100)! },
      { ts: day(1), price: toPaise(102)! },
      { ts: day(2), price: toPaise(93)! }, // the day that mattered
      { ts: day(3), price: toPaise(95)! },
    ];
    const n = narrate(path);
    expect(n.biggestSession).not.toBeNull();
    expect(n.biggestSession!.ret).toBeCloseTo(-0.0882, 3);
    expect(n.biggestSession!.date).toBe("2026-08-05");
  });

  it("reports the drawdown a round trip hides", () => {
    // Ends where it started, having been down 12% in between. An endpoint diff
    // reports "nothing changed", which is true and useless.
    const path = [
      { ts: day(0), price: toPaise(100)! },
      { ts: day(1), price: toPaise(94)! },
      { ts: day(2), price: toPaise(88)! },
      { ts: day(3), price: toPaise(100)! },
    ];
    const n = narrate(path);
    expect(n.netReturn).toBeCloseTo(0, 6);
    expect(n.maxDrawdown!).toBeCloseTo(-0.12, 6);
    expect(n.roundTripped).toBe(true);
  });

  it("says nothing rather than guessing from a single point", () => {
    expect(narrate([{ ts: day(0), price: toPaise(100)! }]).netReturn).toBeNull();
    expect(narrate([]).biggestSession).toBeNull();
  });

  it("chooses the answer shape from sessions, not from elapsed days", () => {
    expect(pickMode(0.4)).toBe("GLANCE");
    expect(pickMode(2)).toBe("SESSION");
    expect(pickMode(6)).toBe("NARRATIVE");
    // A weekend is three days and zero sessions: it must not become a summary.
    const fri = istAt("2026-09-04", 16 * 60);
    const mon = istAt("2026-09-07", 9 * 60);
    expect(pickMode(sessionsBetween(fri, mon))).toBe("GLANCE");
  });

  it("does not claim news on a first visit", () => {
    const absence = describeAbsence(t0, day(5), true);
    const d = buildDigest({
      now: day(5),
      absence,
      cards: [],
      suppressed: [],
      market: null,
      coverage: { symbolsWatched: 8, evaluated: 8, degraded: 0, unavailable: 0 },
    });
    expect(d.headline).toMatch(/baseline/i);
    expect(d.cards).toHaveLength(0);
  });

  it("states plainly when nothing happened", () => {
    const d = buildDigest({
      now: day(5),
      absence: describeAbsence(t0, day(5), false),
      cards: [],
      suppressed: [],
      market: null,
      coverage: { symbolsWatched: 14, evaluated: 14, degraded: 0, unavailable: 0 },
    });
    expect(d.headline).toMatch(/Nothing meaningful/);
    expect(d.subhead).toMatch(/14 symbols checked/);
  });
});
