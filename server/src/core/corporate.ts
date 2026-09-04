/**
 * Corporate actions: the reason a watchlist must not compute returns from raw
 * prices.
 *
 * On 2024-01-05 Nestle India executed a 10:1 split. The quoted price fell from
 * roughly 27,000 to roughly 2,700 overnight. A watchlist that subtracts
 * yesterday's close from today's tells its user their holding lost 90% of its
 * value. It did not — they own ten times as many shares. This module is the
 * difference between a product that is trusted and one that is uninstalled.
 *
 * The same logic covers bonus issues (economically a split) and dividends
 * (price drops by roughly the dividend on the ex-date, but the holder received
 * cash, so their return is unchanged).
 */
import type { Paise } from "./money.js";

export interface Split {
  /** Epoch ms of the ex-date, i.e. the first session priced post-split. */
  exDateTs: number;
  /** 10:1 split -> numerator 10, denominator 1: one share becomes ten. */
  numerator: number;
  denominator: number;
  ratio: string;
}

export interface Dividend {
  exDateTs: number;
  amount: Paise;
}

export interface CorporateActions {
  symbol: string;
  splits: Split[];
  dividends: Dividend[];
}

export const NO_ACTIONS = (symbol: string): CorporateActions => ({
  symbol,
  splits: [],
  dividends: [],
});

/**
 * Multiplier that restates a price observed *before* the window into the share
 * terms prevailing *after* it. For a 10:1 split this is 0.1.
 *
 * Half-open interval (from, to]: an action whose ex-date equals `from` has
 * already been reflected in the price at `from`, so it must not be applied
 * twice — an off-by-one here silently doubles the adjustment.
 */
export function splitFactor(ca: CorporateActions, fromTs: number, toTs: number): number {
  let f = 1;
  for (const s of ca.splits) {
    if (s.exDateTs > fromTs && s.exDateTs <= toTs) {
      if (s.numerator > 0 && s.denominator > 0) f *= s.denominator / s.numerator;
    }
  }
  return f;
}

/**
 * Cash dividends paid in (from, to], expressed per share *as counted today* —
 * i.e. a dividend paid before a later 10:1 split is worth a tenth per current
 * share. Getting this wrong overstates the dividend contribution by the split
 * ratio.
 */
export function dividendPerCurrentShare(
  ca: CorporateActions,
  fromTs: number,
  toTs: number,
): Paise {
  let total = 0;
  for (const d of ca.dividends) {
    if (d.exDateTs > fromTs && d.exDateTs <= toTs) {
      // Split factor for splits occurring after this dividend but within window.
      const f = splitFactor(ca, d.exDateTs, toTs);
      total += d.amount * f;
    }
  }
  return Math.round(total);
}

export interface AppliedAction {
  kind: "SPLIT" | "DIVIDEND";
  exDateTs: number;
  label: string;
  /** Fractional impact this action had on the *raw* quoted price. */
  priceImpact: number;
}

export interface ReturnDecomposition {
  /** What a naive "(now - then) / then" produces. Shown only for diagnostics. */
  raw: number | null;
  /** What actually happened to someone holding the position. */
  adjusted: number | null;
  actions: AppliedAction[];
  /** Fraction of the raw move that corporate actions account for, 0..1. */
  explainedFraction: number;
  /**
   * True when the raw move is materially large and mostly mechanical. Callers
   * must suppress price alerts on these and surface a corporate-action card
   * instead — never both, and never the price alert alone.
   */
  isArtifact: boolean;
}

const ARTIFACT_MIN_RAW_MOVE = 0.06; // 6% — below this, mislabeling costs little
const ARTIFACT_EXPLAINED = 0.6;     // actions must explain most of the move

export function decomposeReturn(
  fromPrice: Paise | null,
  fromTs: number,
  toPrice: Paise | null,
  toTs: number,
  ca: CorporateActions,
): ReturnDecomposition {
  const empty: ReturnDecomposition = {
    raw: null, adjusted: null, actions: [], explainedFraction: 0, isArtifact: false,
  };
  if (fromPrice == null || toPrice == null || fromPrice <= 0) return empty;

  const raw = (toPrice - fromPrice) / fromPrice;

  const sf = splitFactor(ca, fromTs, toTs);
  const restatedFrom = fromPrice * sf;
  if (restatedFrom <= 0) return { ...empty, raw };

  const div = dividendPerCurrentShare(ca, fromTs, toTs);
  const adjusted = (toPrice + div - restatedFrom) / restatedFrom;

  const actions: AppliedAction[] = [];
  for (const s of ca.splits) {
    if (s.exDateTs > fromTs && s.exDateTs <= toTs) {
      actions.push({
        kind: "SPLIT",
        exDateTs: s.exDateTs,
        label: `${s.ratio} split`,
        priceImpact: s.denominator / s.numerator - 1,
      });
    }
  }
  for (const d of ca.dividends) {
    if (d.exDateTs > fromTs && d.exDateTs <= toTs) {
      actions.push({
        kind: "DIVIDEND",
        exDateTs: d.exDateTs,
        label: `dividend`,
        priceImpact: -d.amount / fromPrice,
      });
    }
  }

  const explainedFraction =
    Math.abs(raw) > 1e-9 ? Math.max(0, 1 - Math.abs(adjusted) / Math.abs(raw)) : 0;

  const isArtifact =
    actions.length > 0 &&
    Math.abs(raw) >= ARTIFACT_MIN_RAW_MOVE &&
    explainedFraction >= ARTIFACT_EXPLAINED;

  actions.sort((a, b) => a.exDateTs - b.exDateTs);
  return { raw, adjusted, actions, explainedFraction, isArtifact };
}

/**
 * Back-adjust a raw close series so every point is expressed in the share terms
 * of the final observation. Volatility baselines *must* run on this series: a
 * single unadjusted split injects a synthetic 90% return that inflates sigma
 * for months, which then suppresses every real signal the stock produces.
 */
export function backAdjustCloses(
  closes: readonly (Paise | null)[],
  timestamps: readonly number[],
  ca: CorporateActions,
): (Paise | null)[] {
  if (closes.length === 0) return [];
  const endTs = timestamps[timestamps.length - 1]!;
  return closes.map((c, i) => {
    if (c == null) return null;
    const f = splitFactor(ca, timestamps[i]!, endTs);
    return Math.round(c * f);
  });
}
