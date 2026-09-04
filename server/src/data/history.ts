/**
 * Loading recorded daily history into domain types.
 *
 * This is a boundary module: every shape the provider invented dies here. The
 * core packages know about bars, splits and dividends; they have never heard of
 * `chart.result[0].indicators.quote[0]`. When the provider changes, or when a
 * second provider is added, only this file moves.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { toPaise, type Paise } from "../core/money.js";
import { sessionCloseOf } from "../core/calendar.js";
import type { CorporateActions, Split, Dividend } from "../core/corporate.js";

export interface DailyBar {
  /**
   * Epoch ms at which this bar's `close` was observed, i.e. the session close.
   *
   * The provider stamps daily bars at the session *open* while the row carries
   * the session's *close*. Passing that through unchanged made every price
   * lookup answer with information from later in the day than the instant asked
   * about: a query at 09:20 returned the 15:30 price, labelled 09:20. Since
   * every number this product reports is a comparison against a past instant
   * the user chose, that quietly collapsed "what changed since you looked" to
   * roughly zero for every intraday absence, while the ordinary "today" figure
   * beside it stayed correct.
   *
   * Bars are therefore re-stamped at load. A daily close is a fact about 15:30,
   * and it is not true before then.
   */
  ts: number;
  open: Paise | null;
  high: Paise | null;
  low: Paise | null;
  close: Paise | null;
  volume: number | null;
  /** Provider's own split+dividend adjusted close. Used only to cross-check ours. */
  adjClose: Paise | null;
}

/**
 * What a provider's "close" column actually means.
 *
 * This is the single most dangerous ambiguity in market data. Three vendors
 * will hand you a field called `close` and mean three different things, and
 * none of them will tell you which. Yahoo's chart endpoint returns closes that
 * are already split-adjusted, alongside an `adjclose` that is split *and*
 * dividend adjusted, and documents neither.
 *
 * Getting this wrong is silent and expensive: applying a split adjustment to a
 * series that already has one injects a fabricated 90% return, which inflates
 * the volatility estimate by more than an order of magnitude, which raises
 * every threshold derived from it, which suppresses every real signal that
 * instrument produces for months. Nothing crashes. The product just quietly
 * stops working for that symbol.
 *
 * So the boundary declares its semantics, and `detectAdjustment` below checks
 * the declaration against the data on load.
 */
export type PriceAdjustment = "RAW" | "SPLIT_ADJUSTED" | "SPLIT_AND_DIVIDEND_ADJUSTED";

export interface SymbolHistory {
  symbol: string;
  displayName: string;
  bars: DailyBar[];
  actions: CorporateActions;
  /** Declared semantics of `bars[].close`. */
  closeAdjustment: PriceAdjustment;
  /** What the data itself says, independent of the declaration. */
  observedAdjustment: PriceAdjustment | "UNKNOWN";
}

/**
 * Infer whether splits have already been applied, by looking at the return
 * across each split's ex-date. An unadjusted 10:1 split leaves a -90% print;
 * an adjusted one leaves an ordinary day.
 *
 * Returns UNKNOWN when the symbol has no splits to test against, which is most
 * of them. That is fine: with no split in the series there is nothing for a
 * wrong assumption to corrupt.
 */
export function detectAdjustment(
  bars: readonly DailyBar[],
  actions: CorporateActions,
): PriceAdjustment | "UNKNOWN" {
  if (actions.splits.length === 0 || bars.length < 3) return "UNKNOWN";

  for (const sp of actions.splits) {
    const idx = bars.findIndex((b) => b.ts >= sp.exDateTs && b.close != null);
    if (idx <= 0) continue;
    let prev: DailyBar | null = null;
    for (let j = idx - 1; j >= 0; j--) {
      if (bars[j]!.close != null) { prev = bars[j]!; break; }
    }
    if (!prev) continue;

    const observed = bars[idx]!.close! / prev.close!;
    const expectedIfRaw = sp.denominator / sp.numerator;
    // Within 15% of the split ratio: the jump is there, so the series is raw.
    if (Math.abs(observed - expectedIfRaw) < Math.abs(expectedIfRaw) * 0.15) return "RAW";
  }
  return "SPLIT_ADJUSTED";
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Parse one recorded Yahoo chart payload. Returns null on anything malformed. */
export function parseHistory(symbol: string, raw: unknown): SymbolHistory | null {
  const r = raw as any;
  const ts: unknown[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || ts.length === 0 || !q) return null;

  const adj = r?.indicators?.adjclose?.[0]?.adjclose;
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = num(ts[i]);
    if (t == null) continue;
    bars.push({
      ts: sessionCloseOf(t * 1000),
      open: toPaise(num(q.open?.[i])),
      high: toPaise(num(q.high?.[i])),
      low: toPaise(num(q.low?.[i])),
      close: toPaise(num(q.close?.[i])),
      volume: num(q.volume?.[i]),
      adjClose: toPaise(num(adj?.[i])),
    });
  }

  const splits: Split[] = [];
  for (const s of Object.values<any>(r?.events?.splits ?? {})) {
    const n = num(s?.numerator);
    const d = num(s?.denominator);
    const date = num(s?.date);
    if (n == null || d == null || date == null || n <= 0 || d <= 0) continue;
    splits.push({ exDateTs: date * 1000, numerator: n, denominator: d, ratio: String(s?.splitRatio ?? `${n}:${d}`) });
  }
  splits.sort((a, b) => a.exDateTs - b.exDateTs);

  const dividends: Dividend[] = [];
  for (const d of Object.values<any>(r?.events?.dividends ?? {})) {
    const amt = toPaise(num(d?.amount));
    const date = num(d?.date);
    if (amt == null || date == null) continue;
    dividends.push({ exDateTs: date * 1000, amount: amt });
  }
  dividends.sort((a, b) => a.exDateTs - b.exDateTs);

  const actions: CorporateActions = { symbol, splits, dividends };
  return {
    symbol,
    displayName: String(r?.meta?.longName ?? r?.meta?.shortName ?? symbol),
    bars,
    actions,
    // Yahoo's chart endpoint back-adjusts `close` for splits but not dividends.
    closeAdjustment: "SPLIT_ADJUSTED",
    observedAdjustment: detectAdjustment(bars, actions),
  };
}

/** Filenames use `_NSEI` for the index symbol `^NSEI`, since `^` is awkward on disk. */
export const fileFor = (symbol: string) => symbol.replace("^", "_") + ".json";
export const symbolFor = (file: string) =>
  (file.startsWith("_") ? "^" + file.slice(1) : file).replace(/\.json$/, "");

export interface AdjustmentMismatch {
  symbol: string;
  declared: PriceAdjustment;
  observed: PriceAdjustment;
}

/**
 * Symbols whose data contradicts the declaration the provider made about it.
 *
 * This is the check the whole `closeAdjustment` mechanism exists for, and for a
 * while it was not actually performed: `detectAdjustment` was called once to
 * populate a field, nothing compared the two, and the only assertion lived in
 * the test suite. "Fails loudly on the next run" meant "fails when somebody
 * runs the tests", which is not the same thing and is not what a vendor
 * changing its semantics under you would trip.
 */
export function adjustmentMismatches(all: Map<string, SymbolHistory>): AdjustmentMismatch[] {
  const out: AdjustmentMismatch[] = [];
  for (const h of all.values()) {
    if (h.observedAdjustment === "UNKNOWN") continue;
    if (h.observedAdjustment !== h.closeAdjustment) {
      out.push({ symbol: h.symbol, declared: h.closeAdjustment, observed: h.observedAdjustment });
    }
  }
  return out;
}

export function loadHistoryDir(dir: string): Map<string, SymbolHistory> {
  const out = new Map<string, SymbolHistory>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const symbol = symbolFor(f);
    try {
      const parsed = parseHistory(symbol, JSON.parse(readFileSync(join(dir, f), "utf-8")));
      if (parsed) out.set(symbol, parsed);
    } catch {
      // A single corrupt file must not take down the load. The symbol simply
      // has no history, which downstream already handles as "no baseline yet".
    }
  }
  return out;
}
