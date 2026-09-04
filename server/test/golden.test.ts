/**
 * Golden tests: corporate-action handling checked against five years of real
 * recorded NSE history rather than against fixtures we invented.
 *
 * These earned their keep on the first run. They caught that this system was
 * double-adjusting for splits: Yahoo's chart endpoint already back-adjusts
 * `close`, and applying our own adjustment on top fabricated a -90% return on
 * Nestle India's split date, which inflated its volatility estimate by more
 * than twenty times. Nothing threw. The symbol would simply have stopped
 * producing signals, for months, and no synthetic test would have noticed.
 *
 * The dataset holds eleven genuine splits, including Nestle India's 10:1 in
 * January 2024 and a second 2:1 in August 2025.
 *
 * If the recorded data is absent (a fresh clone that has not run the fetcher),
 * these skip rather than fail: a missing dataset is a setup state, not a defect.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadHistoryDir } from "../src/data/history.js";
import { backAdjustCloses } from "../src/core/corporate.js";
import { toReturns, stdev } from "../src/core/stats.js";
import { computeBaseline } from "../src/core/baseline.js";
import { toRupees } from "../src/core/money.js";
import { detect, PRESETS, STRUCTURAL_ABS } from "../src/core/detect.js";
import { sessionAt } from "../src/core/calendar.js";
import { assess, DEFAULT_CIRCUIT_BAND, SANITY_BAND } from "../src/core/quality.js";

const DIR = join(process.cwd(), "..", "data", "history");
const HAVE = existsSync(DIR);
const d = HAVE ? describe : describe.skip;

/** NSE's most permissive scrip-level price band. */
const CIRCUIT = 0.2;

d("recorded NSE history", () => {
  const all = loadHistoryDir(DIR);

  it("loaded the recorded universe", () => {
    expect(all.size).toBeGreaterThan(40);
    expect(all.has("^NSEI")).toBe(true);
  });

  it("found real corporate actions to test against", () => {
    const withSplits = [...all.values()].filter((h) => h.actions.splits.length > 0);
    expect(withSplits.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * The regression guard. If the provider ever changes what `close` means, this
   * fails loudly on the next run instead of silently corrupting every
   * volatility estimate in the system.
   */
  it("the provider's declared adjustment matches what the data actually shows", () => {
    const disagreements: string[] = [];
    for (const h of all.values()) {
      if (h.observedAdjustment === "UNKNOWN") continue; // no split to test against
      if (h.observedAdjustment !== h.closeAdjustment) {
        disagreements.push(`${h.symbol}: declared ${h.closeAdjustment}, observed ${h.observedAdjustment}`);
      }
    }
    expect(disagreements).toEqual([]);
    // And the check must actually be exercising something.
    const tested = [...all.values()].filter((h) => h.observedAdjustment !== "UNKNOWN");
    expect(tested.length).toBeGreaterThanOrEqual(8);
  });

  it("contains real single-session moves no fixed circuit band would allow", () => {
    // Worth stating plainly, because it is the assumption most naive
    // implementations make and it is false. Stocks in the F&O segment have no
    // fixed price band, and this dataset holds several genuine moves past 20%:
    // Adani Enterprises during the January 2023 short-seller report, and Adani
    // Ports on the June 2024 election result.
    const extremes = new Map<string, number>();
    for (const h of all.values()) {
      if (h.symbol.startsWith("^")) continue;
      const rs = toReturns(h.bars.map((b) => b.close));
      if (rs.length === 0) continue;
      const worst = Math.max(...rs.map(Math.abs));
      if (worst > 0.2) extremes.set(h.symbol, worst);
    }
    expect(extremes.has("ADANIENT")).toBe(true);
    expect(extremes.get("ADANIENT")!).toBeGreaterThan(0.25);
    // ...and none of them is a split we failed to apply.
    for (const sym of extremes.keys()) {
      const worstIsSplit = all.get(sym)!.actions.splits.length > 0;
      expect(worstIsSplit, sym + " extreme move should not come from a split").toBe(false);
    }
  });

  it("proves the corporate-action feed is incomplete", () => {
    // Vedanta fell 65% in one session on its demerger. The provider reports no
    // split and no dividend for that date. This is the case that justifies
    // having a statistical guard at all: a feed-only defence cannot see it.
    const h = all.get("VEDL")!;
    const rs = toReturns(h.bars.map((b) => b.close));
    const worst = Math.min(...rs);
    expect(worst).toBeLessThan(-0.6);
    expect(h.actions.splits.length).toBe(0);
  });

  it("demonstrates the damage a wrong adjustment assumption does", () => {
    // Treating this already-adjusted series as raw is the mistake this codebase
    // originally made. Reproduced here so the cost stays visible.
    const h = all.get("NESTLEIND")!;
    const ts = h.bars.map((b) => b.ts);
    const doubled = backAdjustCloses(h.bars.map((b) => b.close), ts, h.actions);

    const correctVol = stdev(toReturns(h.bars.map((b) => b.close)))!;
    const corruptedVol = stdev(toReturns(doubled))!;

    expect(Math.max(...toReturns(doubled).map(Math.abs))).toBeGreaterThan(0.85);
    expect(corruptedVol).toBeGreaterThan(correctVol * 10);
  });

  it("carries Nestle India's 10:1 split as an event, not as a price crash", () => {
    const h = all.get("NESTLEIND");
    expect(h, "NESTLEIND history missing").toBeDefined();

    const tenForOne = h!.actions.splits.find((s) => s.numerator === 10);
    expect(tenForOne, "expected a 10:1 split in the recorded events").toBeDefined();

    const ex = tenForOne!.exDateTs;
    const before = [...h!.bars].reverse().find((b) => b.ts < ex && b.close != null)!;
    const after = h!.bars.find((b) => b.ts >= ex && b.close != null)!;

    // The split is knowable from the events feed...
    expect(tenForOne!.ratio).toBe("10:1");
    // ...but is not visible as a return, because the series is adjusted.
    const across = (after.close! - before.close!) / before.close!;
    expect(Math.abs(across)).toBeLessThan(0.1);
  });

  it("separates split adjustment from dividend adjustment", () => {
    // adjclose removes dividends as well as splits, so the ratio between them
    // is a pure dividend factor: flat across a split date, stepping only on
    // ex-dividend dates. This is what proves `close` is split-adjusted only.
    const h = all.get("NESTLEIND")!;
    const ex = h.actions.splits.find((s) => s.numerator === 10)!.exDateTs;
    const idx = h.bars.findIndex((b) => b.ts >= ex && b.close != null && b.adjClose != null);
    const ratioAt = (i: number) => h.bars[i]!.adjClose! / h.bars[i]!.close!;
    expect(ratioAt(idx)).toBeCloseTo(ratioAt(idx - 1), 3);
    // ...and by the end of the series every dividend has been passed, so the
    // two converge.
    const last = h.bars.length - 1;
    expect(ratioAt(last)).toBeCloseTo(1, 3);
  });

  it("still knows the pre-split price was a five-figure number", () => {
    // A detail worth keeping: the adjusted series is convenient for statistics
    // and wrong for anything a user remembers. Nestle traded near Rs 27,000
    // before the split, and a user who checked in December 2023 saw that.
    const h = all.get("NESTLEIND")!;
    const ex = h.actions.splits.find((s) => s.numerator === 10)!.exDateTs;
    const before = [...h.bars].reverse().find((b) => b.ts < ex && b.close != null)!;
    const trueQuotedPrice = toRupees(before.close!) * 10;
    expect(trueQuotedPrice).toBeGreaterThan(10_000);
  });
});

d("baselines from recorded history", () => {
  const all = loadHistoryDir(DIR);
  const nifty = all.get("^NSEI")!;
  const ADJ = { closeAdjustment: "SPLIT_ADJUSTED" } as const;

  it("produces sane volatility and beta for a large cap", () => {
    const h = all.get("HDFCBANK")!;
    const b = computeBaseline("HDFCBANK", h.bars, h.actions, nifty.bars, ADJ);

    expect(b.observations).toBeGreaterThan(400);
    // Indian large-cap daily vol sits roughly in the 0.5%-3.5% band.
    expect(b.dailyVol!).toBeGreaterThan(0.005);
    expect(b.dailyVol!).toBeLessThan(0.035);
    // A bank heavyweight in the index tracks it closely.
    expect(b.beta!).toBeGreaterThan(0.5);
    expect(b.beta!).toBeLessThan(1.8);
    // The whole point of the market adjustment: less noise to threshold against.
    // Compared over the same 500-session window the baseline itself used;
    // comparing against the full series would be measuring two different things.
    const sameWindow = stdev(toReturns(h.bars.slice(-500).map((x) => x.close)))!;
    expect(b.residualVol!).toBeLessThan(sameWindow);
  });

  // The test that used to sit here asserted residualVol < stdev(returns) for
  // every symbol and read as evidence that the market adjustment worked. It is
  // an algebraic identity -- regressing on any factor cannot increase residual
  // variance in sample -- so it passed by construction and measured nothing.
  // The real measurement, out of sample, is in calibration.test.ts.

  it("gives a high-beta name a higher beta than a defensive one", () => {
    const beta = (sym: string) => {
      const h = all.get(sym)!;
      return computeBaseline(sym, h.bars, h.actions, nifty.bars, ADJ).beta!;
    };
    // Public-sector banks are famously more index-sensitive than staples.
    expect(beta("PNB")).toBeGreaterThan(beta("HINDUNILVR"));
  });

  it("computes 52-week levels that bracket the last traded price", () => {
    for (const sym of ["RELIANCE", "TCS", "ITC"]) {
      const h = all.get(sym)!;
      const b = computeBaseline(sym, h.bars, h.actions, nifty.bars, ADJ);
      const last = [...h.bars].reverse().find((x) => x.close != null)!.close!;
      expect(b.week52Low!, sym).toBeLessThanOrEqual(last);
      expect(b.week52High!, sym).toBeGreaterThanOrEqual(last);
    }
  });

  it("models volume in log space, where a typical day sits near the middle", () => {
    const h = all.get("RELIANCE")!;
    const b = computeBaseline("RELIANCE", h.bars, h.actions, nifty.bars, ADJ);
    expect(b.logVolumeStdev!).toBeGreaterThan(0);

    // On a raw scale the arithmetic mean sits well above the median for skewed
    // turnover, so a normal day would score negative. The geometric mean this
    // baseline uses should land close to the median instead.
    const vols = h.bars.map((x) => x.volume).filter((v): v is number => v != null && v > 0).slice(-90);
    const sorted = [...vols].sort((a, b2) => a - b2);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const arithmetic = vols.reduce((s, v) => s + v, 0) / vols.length;

    expect(b.avgVolume!).toBeGreaterThan(median * 0.7);
    expect(b.avgVolume!).toBeLessThan(median * 1.4);
    expect(arithmetic).toBeGreaterThan(b.avgVolume!); // the skew we are avoiding
  });

  it("returns an empty baseline rather than guessing when history is absent", () => {
    const b = computeBaseline("NEWLISTING", [], { symbol: "NEWLISTING", splits: [], dividends: [] }, null);
    expect(b.dailyVol).toBeNull();
    expect(b.beta).toBeNull();
    expect(b.observations).toBe(0);
  });

  it("still produces a usable baseline for a recently listed stock", () => {
    // IREDA listed in late 2023: ~690 sessions, enough for vol, enough for beta.
    const h = all.get("IREDA")!;
    const b = computeBaseline("IREDA", h.bars, h.actions, nifty.bars, ADJ);
    expect(b.observations).toBeGreaterThan(300);
    expect(b.dailyVol).not.toBeNull();
    // ...and a newly listed name should be more volatile than a bluechip.
    const rel = all.get("RELIANCE")!;
    const relB = computeBaseline("RELIANCE", rel.bars, rel.actions, nifty.bars, ADJ);
    expect(b.dailyVol!).toBeGreaterThan(relB.dailyVol!);
  });
});

d("the structural guard, on real events", () => {
  const all = loadHistoryDir(DIR);
  const nifty = all.get("^NSEI")!;
  const ADJ = { closeAdjustment: "SPLIT_ADJUSTED" } as const;

  /** Replay one real session transition through the detector. */
  function detectAcross(symbol: string, findWorst: "min" | "max") {
    const h = all.get(symbol)!;
    const bars = h.bars.filter((b) => b.close != null);
    let idx = -1;
    let best = 0;
    for (let i = 1; i < bars.length; i++) {
      const r = (bars[i]!.close! - bars[i - 1]!.close!) / bars[i - 1]!.close!;
      if (idx === -1 || (findWorst === "min" ? r < best : r > best)) { best = r; idx = i; }
    }
    const prev = bars[idx - 1]!;
    const now = bars[idx]!;
    const nowTs = now.ts + 6 * 3600_000; // mid-session on the day in question
    const baseline = computeBaseline(symbol, bars.slice(0, idx), h.actions, nifty.bars, ADJ);
    const session = sessionAt(nowTs);
    const q = {
      symbol,
      ltp: now.close,
      prevClose: prev.close,
      exchangeTs: nowTs - 1000,
      ingestTs: nowTs,
    };
    const assessment = assess(q, {
      now: nowTs,
      session,
      cadenceMs: 30_000,
      universeFreshestTs: nowTs - 1000,
      // The real production value. An earlier version of this test widened the
      // band to stop the quality layer pre-empting the detector, which quietly
      // meant the test proved something the running system did not do: in
      // production a -65% print was being labelled "bad data" before detect()
      // ever saw it. The band moved instead.
      circuitBand: SANITY_BAND,
    });
    const signals = detect({
      symbol,
      now: nowTs,
      watermarkTs: prev.ts + 6 * 3600_000,
      watermarkPrice: prev.close,
      price: now.close,
      prevClose: prev.close,
      exchangeTs: nowTs - 1000,
      dayVolume: now.volume,
      maxSessionMove: null,
      assessment,
      baseline,
      actions: h.actions,
      marketReturn: null,
      circuitBand: DEFAULT_CIRCUIT_BAND,
      policy: PRESETS.balanced,
    });
    return { signals, move: best };
  }

  it("flags Vedanta's undocumented demerger instead of reporting a 65% loss", () => {
    const { signals, move } = detectAcross("VEDL", "min");
    expect(move).toBeLessThan(-0.6);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("SUSPECTED_STRUCTURAL");
    // Crucially, it must not ALSO be reported as a price move.
    expect(kinds).not.toContain("MOVE");
    const s = signals.find((x) => x.kind === "SUSPECTED_STRUCTURAL")!;
    expect(s.because).toMatch(/demerger|spin-off|restatement/);
  });

  it("lets Adani's genuine 28% crash through as real news", () => {
    // The guard must not swallow real events. This is the whole difficulty:
    // a threshold loose enough to catch structure and tight enough to keep news.
    const { signals, move } = detectAcross("ADANIENT", "min");
    expect(move).toBeLessThan(-0.25);
    expect(Math.abs(move)).toBeLessThan(STRUCTURAL_ABS);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("MOVE");
    expect(kinds).not.toContain("SUSPECTED_STRUCTURAL");
  });

  it("keeps volatility estimates honest despite the demerger in the sample", () => {
    // Vedanta's -65% is still in the series. Winsorising must stop it from
    // redefining normal, or every real signal from VEDL afterwards is lost.
    const h = all.get("VEDL")!;
    const b = computeBaseline("VEDL", h.bars, h.actions, nifty.bars, ADJ);
    const naive = stdev(toReturns(h.bars.slice(-500).map((x) => x.close)))!;
    expect(b.dailyVol!).toBeLessThan(naive);
    // ...and still lands in a plausible range for a volatile metals name.
    expect(b.dailyVol!).toBeGreaterThan(0.008);
    expect(b.dailyVol!).toBeLessThan(0.06);
  });
});
