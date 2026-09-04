/**
 * Statistics used to decide whether a move is unusual *for this instrument*.
 *
 * Design note: every function here returns `null` when the input is too thin to
 * produce a trustworthy number. A watchlist that reports a confident z-score
 * off four data points is worse than one that says "not enough history yet" —
 * the first quietly generates false alerts, the second is honest.
 */

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). */
export function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

/**
 * Exponentially-weighted volatility of a return series.
 *
 * Why EWMA over a plain rolling window: volatility is regime-dependent. A flat
 * 20-day window treats a shock 20 days ago exactly like one yesterday, then
 * drops it off a cliff on day 21 — which makes thresholds jump for no reason
 * the market can see. EWMA decays smoothly.
 *
 * `halfLifeDays` is the horizon over which a day's influence halves.
 * Returns null below `minObs` observations.
 */
export function ewmaVol(
  returns: readonly number[],
  halfLifeDays = 20,
  minObs = 30,
): number | null {
  if (returns.length < minObs) return null;
  const lambda = Math.pow(0.5, 1 / halfLifeDays);

  // Walk oldest -> newest so the most recent observation carries weight 1.
  let weightedSumSq = 0;
  let weightSum = 0;
  const n = returns.length;
  for (let i = 0; i < n; i++) {
    const age = n - 1 - i; // 0 for the newest
    const w = Math.pow(lambda, age);
    const r = returns[i]!;
    if (!Number.isFinite(r)) continue;
    weightedSumSq += w * r * r;
    weightSum += w;
  }
  if (weightSum === 0) return null;
  const v = Math.sqrt(weightedSumSq / weightSum);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * How many standard deviations from zero. We deliberately centre on 0 rather
 * than on the sample mean drift: over a few days the drift term is noise, and
 * subtracting it makes a stock in a strong uptrend look "normal" precisely when
 * it is doing the thing the user cares about.
 */
export function zScore(x: number, sigma: number | null): number | null {
  if (sigma == null || sigma <= 0 || !Number.isFinite(x)) return null;
  return x / sigma;
}

/**
 * Beta of asset returns against market returns, plus the volatility of what the
 * market does not explain. Pairs must be aligned by date and equal length.
 *
 * Two things here were wrong in the first version and are worth stating,
 * because both were invisible and both mattered more than the code they broke.
 *
 * **The residual volatility is the number the detector actually divides by.**
 * It used to be a plain equal-weighted standard deviation over the whole
 * lookback, while the EWMA estimator next to it — the one the design notes
 * argue for at length — was only reached by symbols with no beta, which is to
 * say almost none. The documented estimator and the shipped estimator were
 * different functions. They are now the same one: residuals are decayed with
 * the same half-life as everything else, so a volatility regime change moves
 * this denominator too.
 *
 * **Outliers are removed as pairs, not clipped per series.** Winsorising the
 * regressand and the regressor independently breaks their correspondence on
 * exactly the high-leverage days that identify beta, and clipping a regressor
 * is errors-in-variables. Instead we fit once, find residuals that are not
 * returns at all (a demerger, a restatement), drop those whole observations,
 * and refit. The estimate stays robust without the arithmetic being wrong.
 */
export function betaAndResidualVol(
  asset: readonly number[],
  market: readonly number[],
  minObs = 60,
  halfLifeDays = 20,
): { beta: number; residualVol: number; observations: number } | null {
  const n = Math.min(asset.length, market.length);
  if (n < minObs) return null;

  let a = asset.slice(asset.length - n);
  let m = market.slice(market.length - n);

  const fit = (x: readonly number[], y: readonly number[]): number | null => {
    const mx = mean(x)!;
    const my = mean(y)!;
    let cov = 0;
    let varY = 0;
    for (let i = 0; i < x.length; i++) {
      const dx = x[i]! - mx;
      const dy = y[i]! - my;
      cov += dx * dy;
      varY += dy * dy;
    }
    if (varY <= 0) return null;
    const b = cov / varY;
    return Number.isFinite(b) ? b : null;
  };

  let beta = fit(a, m);
  if (beta == null) return null;

  // Second pass: drop observations whose residual is too large to be a return,
  // as whole pairs, then refit. Five robust sigmas, the same band used
  // elsewhere for the same reason.
  const firstResiduals = a.map((x, i) => x - beta! * m[i]!);
  const rs = robustSigma(firstResiduals);
  const med = median(firstResiduals);
  if (rs != null && med != null) {
    const keepA: number[] = [];
    const keepM: number[] = [];
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(firstResiduals[i]! - med) <= 5 * rs) {
        keepA.push(a[i]!);
        keepM.push(m[i]!);
      }
    }
    if (keepA.length >= minObs) {
      const refit = fit(keepA, keepM);
      if (refit != null) {
        beta = refit;
        a = keepA;
        m = keepM;
      }
    }
  }

  // The denominator the detector divides by. EWMA, so that a change in the
  // idiosyncratic volatility regime reaches the thresholds rather than being
  // averaged away over the whole lookback.
  const residuals = a.map((x, i) => x - beta! * m[i]!);
  const rv = ewmaVol(residuals, halfLifeDays, Math.min(minObs, 30));
  if (rv == null || rv <= 0) return null;

  return { beta, residualVol: rv, observations: a.length };
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/**
 * Median absolute deviation, rescaled to be comparable with a standard
 * deviation for normally distributed data.
 *
 * Sample standard deviation has a breakdown point of zero: one observation can
 * move it arbitrarily far. Real return series contain observations that are not
 * returns at all, but demergers, spin-offs and restatements. MAD ignores them.
 */
export function robustSigma(xs: readonly number[]): number | null {
  const m = median(xs);
  if (m == null) return null;
  const mad = median(xs.map((x) => Math.abs(x - m)));
  if (mad == null || mad <= 0) return null;
  return 1.4826 * mad;
}

/**
 * Clip a return series to a robust range before it is used to estimate
 * volatility.
 *
 * Vedanta fell 65% in one session on its 2026 demerger, and the provider's
 * corporate-action feed does not carry that event at all. Left in the sample it
 * would raise the volatility estimate enough to suppress every genuine signal
 * the stock produced afterwards. Winsorising keeps the observation from
 * distorting "normal" without pretending it did not happen: the detector still
 * sees the raw move, and treats it as the structural event it is.
 */
export function winsorize(xs: readonly number[], k = 5): number[] {
  const rs = robustSigma(xs);
  const m = median(xs);
  if (rs == null || m == null) return [...xs];
  const lo = m - k * rs;
  const hi = m + k * rs;
  return xs.map((x) => (x < lo ? lo : x > hi ? hi : x));
}

/** Convert an array of prices into simple period returns. */
export function toReturns(prices: readonly (number | null)[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1];
    const p1 = prices[i];
    if (p0 == null || p1 == null || p0 <= 0) continue;
    const r = (p1 - p0) / p0;
    if (Number.isFinite(r)) out.push(r);
  }
  return out;
}

/**
 * Returns for two price series that must stay aligned.
 *
 * The obvious implementation -- take returns of each series separately, then zip
 * -- is wrong, and wrong invisibly. `toReturns` drops gaps where a price is
 * missing, and the two series do not have their gaps in the same places, so a
 * single suspended session in one of them shortens that array by one and
 * silently pairs every subsequent observation with the wrong day. Beta is then
 * fitted on shifted data and comes out meaningless while looking entirely
 * plausible.
 *
 * Emitting only the indices where both series have a usable price at `i-1` and
 * `i` keeps the correspondence exact, at the cost of a slightly shorter sample.
 */
export function pairedReturns(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
): { a: number[]; b: number[] } {
  const outA: number[] = [];
  const outB: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 1; i < n; i++) {
    const a0 = a[i - 1];
    const a1 = a[i];
    const b0 = b[i - 1];
    const b1 = b[i];
    if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
    if (a0 <= 0 || b0 <= 0) continue;
    const ra = (a1 - a0) / a0;
    const rb = (b1 - b0) / b0;
    if (!Number.isFinite(ra) || !Number.isFinite(rb)) continue;
    outA.push(ra);
    outB.push(rb);
  }
  return { a: outA, b: outB };
}

/**
 * Scale a per-day volatility to a horizon of `days` using the square-root rule.
 * Valid only under an i.i.d. assumption, which markets violate — but it is the
 * standard approximation and it fails in a known direction (understates tails),
 * which is the right direction for a system whose job is to suppress noise.
 */
export function scaleVol(dailyVol: number, days: number): number {
  return dailyVol * Math.sqrt(Math.max(days, 1 / 375)); // floor = one trading minute
}
