/**
 * Ranking and suppression.
 *
 * Detection produces candidates. This decides what a person actually sees.
 *
 * The governing constraint is that attention is finite and non-renewable. A
 * watchlist that surfaces twelve things has surfaced nothing, because the user
 * learns to skim it, and once they skim it the one card that mattered is gone
 * too. So the output is capped, and everything above the cap must be beaten on
 * merit by something below it.
 *
 * The second rule: nothing is dropped silently. Every suppressed candidate
 * leaves a ledger entry with a reason. The user is told "17 symbols, nothing
 * unusual" rather than being shown an empty screen and left to wonder whether
 * the system is working. A system that hides its own decisions cannot be
 * trusted with money.
 */
import type { Signal, Policy } from "./detect.js";

export type SuppressionReason =
  | "COOLDOWN"
  | "MARKET_WIDE"
  | "WEAKER_THAN_SIBLING"
  | "BELOW_CAP"
  | "NOTHING_UNUSUAL";

export interface RankedSignal extends Signal {
  score: number;
  rank: number;
}

export interface Suppressed {
  symbol: string;
  kind: string;
  reason: SuppressionReason;
  explain: string;
  strength: number;
}

export interface MarketContext {
  symbol: string;
  label: string;
  return: number;
  /** How many per-symbol cards this one card stands in for. */
  collapsed: number;
  explain: string;
}

export interface RankInput {
  signals: Signal[];
  policy: Policy;
  /** dedupeKey -> last time this exact event was shown to this user. */
  lastShownAt: Map<string, number>;
  now: number;
  /** Index return over the same window, for market-wide collapse. */
  marketReturn: number | null;
  marketSymbol: string;
  marketLabel: string;
  /** Optional per-symbol multiplier, e.g. weight by holding size. */
  weightOf?: (symbol: string) => number;
}

export interface RankResult {
  surfaced: RankedSignal[];
  suppressed: Suppressed[];
  market: MarketContext | null;
}

/**
 * How much each kind is worth relative to a price move of the same sigma.
 *
 * These are judgement, not fitted parameters, and they are deliberately few. We
 * have no labelled ground truth for "was this alert useful", so a learned model
 * here would be unfalsifiable and unexplainable, and would cost us the ability
 * to answer the only question that matters in a financial product: why did you
 * show me this?
 */
const KIND_WEIGHT: Record<string, number> = {
  CIRCUIT: 1.35,
  CORPORATE_ACTION: 1.25,
  MOVE: 1.0,
  LEVEL_BREAK: 0.95,
  VOLUME: 0.7,
  SYMBOL_LIFECYCLE: 0.9,
  DATA_QUALITY: 0.55,
};

/** Market-wide collapse triggers once this many symbols move together. */
const HERD_MIN = 4;
/** ...and the index itself has moved at least this much. */
const HERD_INDEX_MOVE = 0.006;

export function rank(input: RankInput): RankResult {
  const suppressed: Suppressed[] = [];
  const weightOf = input.weightOf ?? (() => 1);

  // 0. Near misses never compete. They exist to be recorded, not ranked: a
  //    symbol that stayed inside its own range is the most common outcome and
  //    the least interesting card, but it is still an answer the user is owed.
  let alive = input.signals.filter((s) => {
    if (s.kind !== "NOTHING_UNUSUAL") return true;
    suppressed.push({
      symbol: s.symbol,
      kind: s.kind,
      reason: "NOTHING_UNUSUAL",
      explain: s.because,
      strength: s.strength,
    });
    return false;
  });

  // 1. Cooldown. The same event re-detected on every poll is one event.
  alive = alive.filter((s) => {
    const last = input.lastShownAt.get(s.dedupeKey);
    if (last != null && input.now - last < input.policy.cooldownMs) {
      suppressed.push({
        symbol: s.symbol,
        kind: s.kind,
        reason: "COOLDOWN",
        explain:
          "already surfaced " +
          Math.round((input.now - last) / 60_000) +
          " minutes ago; not repeated inside the cooldown window",
        strength: s.strength,
      });
      return false;
    }
    return true;
  });

  // 2. Market-wide collapse. If the whole tape moved, "your stock moved" is not
  //    news about your stock. Cards whose move is mostly explained by the index
  //    become one market card; the ones with genuine idiosyncratic movement
  //    survive on their residual, which detect() already computed for them.
  let market: MarketContext | null = null;
  if (input.marketReturn != null && Math.abs(input.marketReturn) >= HERD_INDEX_MOVE) {
    const dir = Math.sign(input.marketReturn);
    const herd = alive.filter(
      (s) =>
        s.kind === "MOVE" &&
        Math.sign(s.direction === "UP" ? 1 : -1) === dir &&
        s.evidence.buckedTheMarket !== true,
    );
    if (herd.length >= HERD_MIN) {
      const keep = new Set(
        herd
          .slice()
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 1)
          .map((s) => s.dedupeKey),
      );
      const collapsedKeys = new Set(
        herd.filter((s) => !keep.has(s.dedupeKey)).map((s) => s.dedupeKey),
      );
      for (const s of herd) {
        if (collapsedKeys.has(s.dedupeKey)) {
          suppressed.push({
            symbol: s.symbol,
            kind: s.kind,
            reason: "MARKET_WIDE",
            explain:
              "moved with the market; the index itself was " +
              (input.marketReturn * 100).toFixed(1) +
              "%, so this is the tape, not the stock",
            strength: s.strength,
          });
        }
      }
      alive = alive.filter((s) => !collapsedKeys.has(s.dedupeKey));
      market = {
        symbol: input.marketSymbol,
        label: input.marketLabel,
        return: input.marketReturn,
        collapsed: collapsedKeys.size,
        explain:
          collapsedKeys.size +
          " of your holdings moved with the index rather than on their own news",
      };
    }
  }

  // 3. One card per symbol. Two signals about the same stock is one story told
  //    twice; keep the strongest and note the rest.
  const bySymbol = new Map<string, Signal[]>();
  for (const s of alive) {
    const list = bySymbol.get(s.symbol) ?? [];
    list.push(s);
    bySymbol.set(s.symbol, list);
  }
  const primaries: Signal[] = [];
  for (const [, list] of bySymbol) {
    list.sort((a, b) => score(b, weightOf) - score(a, weightOf));
    primaries.push(list[0]!);
    for (const s of list.slice(1)) {
      suppressed.push({
        symbol: s.symbol,
        kind: s.kind,
        reason: "WEAKER_THAN_SIBLING",
        explain: "folded into the stronger " + list[0]!.kind + " signal for the same symbol",
        strength: s.strength,
      });
    }
  }

  // 4. Cap. Everything past maxCards is real but did not clear the bar today.
  primaries.sort((a, b) => score(b, weightOf) - score(a, weightOf));
  const surfaced: RankedSignal[] = primaries
    .slice(0, input.policy.maxCards)
    .map((s, idx) => ({ ...s, score: round(score(s, weightOf), 3), rank: idx + 1 }));

  for (const s of primaries.slice(input.policy.maxCards)) {
    suppressed.push({
      symbol: s.symbol,
      kind: s.kind,
      reason: "BELOW_CAP",
      explain:
        "real, but ranked below the top " +
        input.policy.maxCards +
        "; visible in the full list",
      strength: s.strength,
    });
  }

  return { surfaced, suppressed, market };
}

function score(s: Signal, weightOf: (sym: string) => number): number {
  const kind = KIND_WEIGHT[s.kind] ?? 0.5;
  return s.strength * kind * weightOf(s.symbol);
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
