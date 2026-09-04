/**
 * Baselines: what "normal" means for one instrument.
 *
 * Every threshold in this system is relative to a number computed here, so the
 * two failure modes are equally bad. Too tight a baseline and the watchlist
 * fires constantly; too loose and it never fires at all. The defence against
 * both is the same: refuse to produce a baseline we do not have the data for,
 * and let the detector fall back to a plainer rule rather than pretending.
 */
import type { Paise } from "./money.js";
import { ewmaVol, betaAndResidualVol, toReturns, pairedReturns, mean, stdev, winsorize } from "./stats.js";

import { backAdjustCloses, type CorporateActions } from "./corporate.js";
import { istDate } from "./calendar.js";

export interface Baseline {
  symbol: string;
  /** EWMA sigma of split-adjusted daily returns. */
  dailyVol: number | null;
  /** Sigma of the part of the return the index does not explain. */
  residualVol: number | null;
  beta: number | null;
  /** Geometric mean volume, used for the human-facing "x normal" figure. */
  avgVolume: number | null;
  /**
   * Volume statistics live in log space. Daily turnover is strongly
   * right-skewed: on a raw scale the mean sits above the median, so a normal
   * day reads as below average and a single block deal drags the mean for
   * months. Log volume is close enough to symmetric for a z-score to mean
   * something.
   */
  logVolumeMean: number | null;
  logVolumeStdev: number | null;
  week52High: Paise | null;
  week52Low: Paise | null;
  observations: number;
  /**
   * Observations behind the beta and residual volatility specifically, after
   * date pairing and outlier removal. Distinct from `observations`, which counts
   * the return series: reporting the larger number next to a z-score derived
   * from the smaller one overstates how much evidence is behind it.
   */
  betaObservations: number;
  /** Last session used. Lets callers detect a stale baseline. */
  asOf: number | null;
}

export function emptyBaseline(symbol: string): Baseline {
  return {
    symbol,
    dailyVol: null,
    residualVol: null,
    beta: null,
    avgVolume: null,
    logVolumeMean: null,
    logVolumeStdev: null,
    week52High: null,
    week52Low: null,
    observations: 0,
    betaObservations: 0,
    asOf: null,
  };
}

export interface BarLike {
  ts: number;
  close: Paise | null;
  high: Paise | null;
  low: Paise | null;
  volume: number | null;
}

export interface BaselineOptions {
  /**
   * Ignore bars stamped after this instant.
   *
   * Bars are stamped at the session close, so the current day's bar is dated in
   * the future for most of a trading day. The price oracle refuses those; the
   * baseline was still consuming them, which gave every volatility, beta and
   * 52-week level a few hours of lookahead and made a same-day 52-week high
   * structurally impossible to detect, because the level already contained the
   * rest of the session.
   */
  asOf?: number;
  /**
   * Whether `bars[].close` already has splits applied. Defaults to RAW, the
   * conservative choice: if a caller forgets to declare it and the series is in
   * fact adjusted, the extra adjustment is a no-op for symbols with no splits
   * and produces a loud, testable failure for symbols that have them, rather
   * than a quiet 20x volatility error.
   */
  closeAdjustment?: "RAW" | "SPLIT_ADJUSTED" | "SPLIT_AND_DIVIDEND_ADJUSTED";
  /** Sessions of history to use for volatility and beta. */
  lookback?: number;
  /** Sessions used for the volume distribution. Shorter: turnover regimes shift. */
  volumeLookback?: number;
  halfLife?: number;
}

export function computeBaseline(
  symbol: string,
  bars: readonly BarLike[],
  actions: CorporateActions,
  marketBars: readonly BarLike[] | null,
  opts: BaselineOptions = {},
): Baseline {
  const lookback = opts.lookback ?? 500;
  const volumeLookback = opts.volumeLookback ?? 90;
  const halfLife = opts.halfLife ?? 20;

  const b = emptyBaseline(symbol);
  if (bars.length === 0) return b;

  const visible = opts.asOf == null ? bars : bars.filter((x) => x.ts <= opts.asOf!);
  if (visible.length === 0) return b;

  const window = visible.slice(-lookback);
  const ts = window.map((x) => x.ts);

  // Everything downstream runs on a split-adjusted series. Applying the
  // adjustment when it is already applied is just as destructive as skipping
  // it, so we act on the declared semantics rather than on an assumption.
  const alreadyAdjusted = (opts.closeAdjustment ?? "RAW") !== "RAW";
  const closes = alreadyAdjusted
    ? window.map((x) => x.close)
    : backAdjustCloses(window.map((x) => x.close), ts, actions);
  const returns = toReturns(closes);

  b.observations = returns.length;
  b.asOf = ts[ts.length - 1] ?? null;
  // Winsorised, so that a demerger the corporate-action feed never reported
  // cannot quietly redefine what "normal" means for this instrument.
  b.dailyVol = ewmaVol(winsorize(returns), halfLife);

  // --- Market relationship, aligned by trading date rather than by index.
  // Two series can differ in length whenever one instrument was suspended for a
  // session; zipping by position would then silently pair the wrong days.
  if (marketBars && marketBars.length > 0) {
    const mByDate = new Map<string, Paise | null>();
    for (const m of marketBars) mByDate.set(istDate(m.ts), m.close);

    const pairedAsset: (Paise | null)[] = [];
    const pairedMarket: (Paise | null)[] = [];
    for (let i = 0; i < window.length; i++) {
      const mc = mByDate.get(istDate(ts[i]!));
      if (mc == null) continue;
      pairedAsset.push(closes[i] ?? null);
      pairedMarket.push(mc);
    }
    // Returns computed pairwise, not per series. Taking returns of each
    // separately drops missing sessions independently and then pairs every
    // later observation with the wrong day -- the exact misalignment the
    // date-matching above exists to prevent, reintroduced one line later.
    //
    // Not winsorised here either: betaAndResidualVol removes outliers as whole
    // pairs internally. Clipping the two series independently, as this used to,
    // breaks the correspondence on exactly the days that identify beta, and
    // clipping a regressor is errors-in-variables.
    const { a: ar, b: mr } = pairedReturns(pairedAsset, pairedMarket);
    const fit = betaAndResidualVol(ar, mr, 60, halfLife);
    if (fit) {
      b.beta = fit.beta;
      b.residualVol = fit.residualVol;
      b.betaObservations = fit.observations;
    }
  }

  // --- Volume, in log space.
  const vols = window
    .slice(-volumeLookback)
    .map((x) => x.volume)
    .filter((v): v is number => v != null && v > 0);
  if (vols.length >= 20) {
    const logs = vols.map((v) => Math.log(v));
    b.logVolumeMean = mean(logs);
    b.logVolumeStdev = stdev(logs);
    if (b.logVolumeMean != null) b.avgVolume = Math.exp(b.logVolumeMean);
  }

  // --- 52-week extremes.
  //
  // From the traded range, not from closes. "Broke its 52-week high" is a claim
  // about a price that printed, and an intraday high above every close is the
  // normal case rather than the exception -- measured on this universe the gap
  // runs to nearly 4%, so a close-only version fires days late on a level the
  // exchange never published.
  //
  // Highs and lows carry the same split adjustment as the closes: the ratio of
  // adjusted to raw close for each session, applied to that session's range. A
  // split would otherwise leave a phantom yearly low the day after it happens.
  const yearFrom = Math.max(0, window.length - 252);
  let hi: Paise | null = null;
  let lo: Paise | null = null;
  for (let i = yearFrom; i < window.length; i++) {
    const bar = window[i]!;
    const adj = closes[i];
    const raw = bar.close;
    const factor = adj != null && raw != null && raw > 0 ? adj / raw : 1;

    const high = bar.high != null ? Math.round(bar.high * factor) : adj;
    const low = bar.low != null ? Math.round(bar.low * factor) : adj;
    if (high != null && (hi == null || high > hi)) hi = high;
    if (low != null && (lo == null || low < lo)) lo = low;
  }
  b.week52High = hi;
  b.week52Low = lo;

  return b;
}
