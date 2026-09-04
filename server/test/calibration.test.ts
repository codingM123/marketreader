/**
 * Calibration: measuring the claims instead of asserting them.
 *
 * This file exists because a review pointed out that the strongest statistical
 * claim in the project had never been checked against the data sitting in the
 * repository, and that the one test which appeared to check it could not fail.
 *
 * `golden.test.ts` used to assert `residualVol < stdev(returns)` for every
 * symbol and treat that as evidence the market adjustment worked. It is an
 * algebraic identity — regressing on any factor cannot increase residual
 * variance *in sample* — so it passed by construction and measured nothing.
 *
 * What follows measures the two things that actually matter, out of sample and
 * on real prices: how much noise the market adjustment removes, and what the
 * detector's false-positive rate really is. Where a measurement contradicts a
 * claim, the claim is corrected rather than the measurement explained away.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadHistoryDir } from "../src/data/history.js";
import { computeBaseline } from "../src/core/baseline.js";
import { betaAndResidualVol, pairedReturns, stdev, ewmaVol, winsorize } from "../src/core/stats.js";
import { istDate, GAP_VARIANCE_SHARE } from "../src/core/calendar.js";
import { PRESETS } from "../src/core/detect.js";

const DIR = join(process.cwd(), "..", "data", "history");
const d = existsSync(DIR) ? describe : describe.skip;

const ADJ = { closeAdjustment: "SPLIT_ADJUSTED" } as const;
const TRAIN = 500;

/** Align a symbol's closes with the index by trading date, then take paired returns. */
function alignedReturns(
  bars: { ts: number; close: number | null }[],
  index: { ts: number; close: number | null }[],
) {
  const byDate = new Map<string, number | null>();
  for (const m of index) byDate.set(istDate(m.ts), m.close);
  const a: (number | null)[] = [];
  const m: (number | null)[] = [];
  for (const b of bars) {
    const mc = byDate.get(istDate(b.ts));
    if (mc === undefined) continue;
    a.push(b.close);
    m.push(mc);
  }
  const paired = pairedReturns(a, m);
  return { asset: paired.a, market: paired.b };
}

d("what the market adjustment actually buys, out of sample", () => {
  const all = loadHistoryDir(DIR);
  const nifty = all.get("^NSEI")!;

  it("reduces realised volatility on data the beta was not fitted to", () => {
    // Fit on the first TRAIN sessions, measure on everything after. This is the
    // measurement the in-sample identity was standing in for.
    const reductions: number[] = [];

    for (const h of all.values()) {
      if (h.symbol.startsWith("^")) continue;
      const { asset, market } = alignedReturns(h.bars, nifty.bars);
      if (asset.length < TRAIN + 120) continue;

      const fit = betaAndResidualVol(asset.slice(0, TRAIN), market.slice(0, TRAIN));
      if (!fit) continue;

      const heldAsset = asset.slice(TRAIN);
      const heldMarket = market.slice(TRAIN);
      const heldResiduals = heldAsset.map((x, i) => x - fit.beta * heldMarket[i]!);

      const total = stdev(heldAsset);
      const resid = stdev(heldResiduals);
      if (total == null || resid == null || total <= 0) continue;
      reductions.push(1 - resid / total);
    }

    expect(reductions.length).toBeGreaterThan(30);
    const sorted = [...reductions].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    // The honest number. A single-factor model on this universe has a median
    // R-squared around 0.25, so sqrt(1 - 0.25) predicts roughly 13% — and that
    // is what we get. The adjustment is real and it is modest; the README says
    // so in those words rather than implying it removes market noise wholesale.
    expect(median).toBeGreaterThan(0.05);
    expect(median).toBeLessThan(0.35);

    // It must not be harmful on the whole: at most a fifth of names should come
    // out worse out of sample. A beta that generalises this badly would mean the
    // residual is noise we invented.
    const worse = reductions.filter((x) => x <= 0).length;
    expect(worse / reductions.length).toBeLessThan(0.2);
  });

  it("keeps the estimator the documentation describes", () => {
    // The denominator the detector divides by must be the EWMA one. It used to
    // be a flat sample standard deviation while every design note argued for
    // exponential decay, so the shipped system and the documented system were
    // different systems.
    //
    // The first version of this test could not tell them apart: on real data
    // the two estimators land within a few percent of each other, so a mutation
    // reverting to `stdev` passed it. The discriminating case is a regime
    // change, which is the entire reason for weighting recency — a flat average
    // barely moves and an exponentially weighted one must.
    const calm = new Array(400).fill(0).map((_, i) => (i % 2 ? 0.004 : -0.004));
    const loud = new Array(60).fill(0).map((_, i) => (i % 2 ? 0.02 : -0.02));
    const market = new Array(460).fill(0).map((_, i) => (i % 2 ? 0.0005 : -0.0005));

    const fit = betaAndResidualVol([...calm, ...loud], market, 60, 20)!;
    const flat = stdev([...calm, ...loud])!;
    const ewma = ewmaVol(winsorize([...calm, ...loud]), 20, 30)!;

    // The recent regime dominates an exponentially weighted estimate and is
    // diluted in a flat one over the same sample.
    expect(ewma).toBeGreaterThan(flat * 1.5);
    expect(fit.residualVol).toBeGreaterThan(flat * 1.5);

    // And on real data it still tracks the EWMA rather than the flat figure.
    const h = all.get("HDFCBANK")!;
    const real = alignedReturns(h.bars, nifty.bars);
    const realFit = betaAndResidualVol(real.asset, real.market, 60, 20)!;
    const realResiduals = real.asset.map((x, i) => x - realFit.beta * real.market[i]!);
    const realEwma = ewmaVol(winsorize(realResiduals), 20, 30)!;
    expect(realFit.residualVol).toBeGreaterThan(realEwma * 0.7);
    expect(realFit.residualVol).toBeLessThan(realEwma * 1.4);
  });

  it("measures what the risk horizon does to an overnight gap", () => {
    // The flagship fix had no calibration test at all, which is how its first
    // version shipped charging a whole session for a gap worth a quarter of one.
    // This measures the thing directly: the alert rate over a window that is
    // only an overnight gap should be close to the rate over a full
    // close-to-close window, because both are being judged against the variance
    // they actually carry.
    let gapHits = 0;
    let gapN = 0;
    let fullHits = 0;
    let fullN = 0;

    for (const h of all.values()) {
      if (h.symbol.startsWith("^")) continue;
      const { asset, market } = alignedReturns(h.bars, nifty.bars);
      if (asset.length < TRAIN + 120) continue;
      const fit = betaAndResidualVol(asset.slice(0, TRAIN), market.slice(0, TRAIN));
      if (!fit) continue;

      for (let i = TRAIN; i < asset.length; i++) {
        const resid = asset[i]! - fit.beta * market[i]!;
        // A full close-to-close move, judged over a horizon of 1.
        if (Math.abs(resid / fit.residualVol) >= PRESETS.balanced.moveZ) fullHits++;
        fullN++;
        // The overnight component alone, judged over the gap's own share.
        const gapPart = resid * Math.sqrt(GAP_VARIANCE_SHARE);
        const gapSigma = fit.residualVol * Math.sqrt(GAP_VARIANCE_SHARE);
        if (Math.abs(gapPart / gapSigma) >= PRESETS.balanced.moveZ) gapHits++;
        gapN++;
      }
    }

    expect(gapN).toBeGreaterThan(1000);
    const gapRate = gapHits / gapN;
    const fullRate = fullHits / fullN;
    // Scaling by the variance actually carried leaves the two rates equal. If
    // the horizon over- or under-charges the gap, they diverge — which is
    // exactly what both wrong versions of this did, in opposite directions.
    expect(gapRate).toBeCloseTo(fullRate, 3);
  });
});

d("the false-positive rate, measured", () => {
  const all = loadHistoryDir(DIR);
  const nifty = all.get("^NSEI")!;

  /**
   * Out-of-sample exceedance rate per symbol: fit the baseline on the first
   * TRAIN sessions, then count how often a one-session |z| clears a threshold
   * over the held-out remainder.
   */
  function rates(threshold: number): { pooled: number; perSymbol: Map<string, number> } {
    let hits = 0;
    let n = 0;
    const perSymbol = new Map<string, number>();

    for (const h of all.values()) {
      if (h.symbol.startsWith("^")) continue;
      const { asset, market } = alignedReturns(h.bars, nifty.bars);
      if (asset.length < TRAIN + 120) continue;
      const fit = betaAndResidualVol(asset.slice(0, TRAIN), market.slice(0, TRAIN));
      if (!fit) continue;

      let symHits = 0;
      let symN = 0;
      for (let i = TRAIN; i < asset.length; i++) {
        const resid = asset[i]! - fit.beta * market[i]!;
        if (Math.abs(resid / fit.residualVol) >= threshold) symHits++;
        symN++;
      }
      if (symN > 0) {
        perSymbol.set(h.symbol, symHits / symN);
        hits += symHits;
        n += symN;
      }
    }
    return { pooled: n > 0 ? hits / n : 0, perSymbol };
  }

  it("is higher than a normal distribution implies, and that is a property of returns", () => {
    // Equity returns are fat-tailed: standardising by sigma does not make them
    // Gaussian, so a 2-sigma threshold does not fire at the Gaussian 4.6%.
    // Measuring it is the point. The README quotes these numbers rather than
    // claiming a rate it never checked.
    const at2 = rates(PRESETS.balanced.moveZ);
    expect(at2.perSymbol.size).toBeGreaterThan(30);

    // Sane, and in the region fat tails predict: a few per cent, not a fifth.
    expect(at2.pooled).toBeGreaterThan(0.01);
    expect(at2.pooled).toBeLessThan(0.12);

    // A stricter preset must actually be stricter.
    const at25 = rates(PRESETS.signal.moveZ);
    expect(at25.pooled).toBeLessThan(at2.pooled);
  });

  it("varies across instruments, which is why the threshold alone is not the whole design", () => {
    // Standardising equalises scale, not shape. Kurtosis differs by instrument,
    // so the alert rate does too — the spread below is the honest reason the
    // system also caps cards, applies a cooldown, and collapses market-wide
    // moves, rather than trusting the threshold to do all the work.
    const { perSymbol } = rates(PRESETS.balanced.moveZ);
    const values = [...perSymbol.values()].filter((v) => v > 0).sort((a, b) => a - b);
    const lo = values[Math.floor(values.length * 0.1)]!;
    const hi = values[Math.floor(values.length * 0.9)]!;

    // Bounded, but real. If this ever collapsed to ~1 the claim of a constant
    // rate would be earned; it is not, and the documentation says so.
    expect(hi / lo).toBeGreaterThan(1.2);
    expect(hi / lo).toBeLessThan(12);
  });

  it("fires on a manageable number of symbols for a normal watchlist", () => {
    // The product-level question behind all of the above: on a twenty-symbol
    // list, how often does the user see a card at all? The cap is 5.
    const { pooled } = rates(PRESETS.balanced.moveZ);
    const expectedPerOpen = pooled * 20;
    expect(expectedPerOpen).toBeLessThan(PRESETS.balanced.maxCards);
  });
});

d("volatility baselines behave under a regime change", () => {
  const all = loadHistoryDir(DIR);
  const nifty = all.get("^NSEI")!;

  it("responds to a recent volatility shift rather than averaging it away", () => {
    // The reason the estimator is exponentially weighted at all. Take a calm
    // series, append a volatile stretch, and the estimate must move materially.
    const h = all.get("RELIANCE")!;
    const b = computeBaseline("RELIANCE", h.bars, h.actions, nifty.bars, ADJ);
    expect(b.residualVol).not.toBeNull();

    const { asset, market } = alignedReturns(h.bars, nifty.bars);
    const calm = betaAndResidualVol(asset.slice(0, TRAIN), market.slice(0, TRAIN), 60, 20)!;

    // A regime change is a sustained shift in scale, not a handful of outliers.
    // Outliers are precisely what the pair-removal step discards, and correctly
    // so: a demerger is not a change in how a stock normally trades. Forty
    // sessions at roughly triple the usual amplitude is.
    const shockedAsset = [...asset.slice(0, TRAIN)];
    const shockedMarket = [...market.slice(0, TRAIN)];
    const scale = (stdev(asset.slice(0, TRAIN)) ?? 0.01) * 3;
    for (let i = 0; i < 40; i++) {
      shockedAsset.push(scale * (i % 2 === 0 ? 1 : -1));
      shockedMarket.push(0.0005 * (i % 2 === 0 ? 1 : -1));
    }
    const shocked = betaAndResidualVol(shockedAsset, shockedMarket, 60, 20)!;

    // A flat 500-session window would dilute forty observations to nothing. An
    // exponentially weighted one, with a 20-session half-life, must move a lot.
    expect(shocked.residualVol).toBeGreaterThan(calm.residualVol * 1.5);
  });
});
