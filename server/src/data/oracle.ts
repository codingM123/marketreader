/**
 * Answering "what was this worth at that moment".
 *
 * Every number the digest reports is a comparison against a point in the past
 * chosen by the user, not by the calendar, so a price lookup at an arbitrary
 * instant is a core operation rather than a convenience.
 *
 * Two sources, in order of resolution:
 *   - recorded intraday ticks, when the instant falls inside a recorded session
 *   - daily closes otherwise
 *
 * The lookup never interpolates. If the last known price before an instant is
 * three hours old, the honest answer is that three-hour-old price together with
 * its age, not a straight line drawn between two points that were never traded.
 */
import type { Paise } from "../core/money.js";
import type { SymbolHistory } from "./history.js";
import type { PathPoint } from "../core/digest.js";

export interface IntradayPoint {
  ts: number;
  price: Paise;
}

export class PriceOracle {
  private readonly intraday = new Map<string, IntradayPoint[]>();

  constructor(private readonly history: Map<string, SymbolHistory>) {}

  /** Feed recorded ticks in, so intraday windows resolve at tick resolution. */
  loadIntraday(symbol: string, points: IntradayPoint[]): void {
    const sorted = [...points].sort((a, b) => a.ts - b.ts);
    this.intraday.set(symbol, sorted);
  }

  /**
   * Last known price at or before `ts`, with the time it was actually observed.
   *
   * The postcondition that matters is `observedAt <= ts`. It reads as too
   * obvious to state, which is exactly why it was violated for every intraday
   * lookup in the first version of this file: daily bars arrived stamped at the
   * session open while carrying the session's close, so a query at 09:20
   * answered with the closing price and reported it as a 09:20 observation.
   * Nothing threw, the numbers were all in range, and the product's headline
   * figure was silently wrong. The bars are re-stamped at the boundary now, and
   * the filter below is the belt to that braces.
   */
  priceAt(symbol: string, ts: number): { price: Paise; observedAt: number } | null {
    const ticks = this.intraday.get(symbol);
    if (ticks && ticks.length > 0 && ts >= ticks[0]!.ts) {
      const p = lastAtOrBefore(ticks, ts, (x) => x.ts);
      if (p && p.ts <= ts) return { price: p.price, observedAt: p.ts };
    }

    const h = this.history.get(symbol);
    if (!h) return null;
    const bar = lastAtOrBefore(
      h.bars.filter((b) => b.close != null),
      ts,
      (b) => b.ts,
    );
    if (!bar || bar.ts > ts) return null;
    return { price: bar.close!, observedAt: bar.ts };
  }

  /**
   * Simple return between two instants for one symbol.
   *
   * Used for the index, where a corporate action never applies. For individual
   * stocks the caller goes through decomposeReturn instead, because a raw
   * return across a split is a lie.
   */
  returnBetween(symbol: string, fromTs: number, toTs: number): number | null {
    const a = this.priceAt(symbol, fromTs);
    const b = this.priceAt(symbol, toTs);
    if (!a || !b || a.price <= 0) return null;
    if (a.observedAt === b.observedAt) return 0;
    return (b.price - a.price) / a.price;
  }

  /**
   * The price path across a window, for narrative facts and sparklines.
   *
   * Downsampled to at most `maxPoints`, because a week's absence over a recorded
   * session is thousands of points and a sparkline rendered at 300 pixels wide
   * cannot show them. Downsampling is stride-based and always keeps the first
   * and last point, so the endpoints of the window a user is being shown are the
   * real ones.
   */
  pathBetween(symbol: string, fromTs: number, toTs: number, maxPoints = 120): PathPoint[] {
    const out: PathPoint[] = [];

    const h = this.history.get(symbol);
    if (h) {
      for (const b of h.bars) {
        if (b.close == null) continue;
        if (b.ts >= fromTs && b.ts <= toTs) out.push({ ts: b.ts, price: b.close });
      }
    }
    const ticks = this.intraday.get(symbol);
    if (ticks) {
      for (const t of ticks) {
        if (t.ts >= fromTs && t.ts <= toTs) out.push({ ts: t.ts, price: t.price });
      }
    }

    out.sort((a, b) => a.ts - b.ts);
    if (out.length <= maxPoints) return out;

    const stride = Math.ceil(out.length / maxPoints);
    const sampled: PathPoint[] = [];
    for (let i = 0; i < out.length; i += stride) sampled.push(out[i]!);
    const last = out[out.length - 1]!;
    if (sampled[sampled.length - 1]!.ts !== last.ts) sampled.push(last);
    return sampled;
  }

  /**
   * The largest single-session move inside a window.
   *
   * This is what the structural guard needs, and the window return is not a
   * substitute for it. A stock that halves over three months is a bear market;
   * a stock that halves between two consecutive closes is a demerger, a
   * restatement, or a bad print. Judging structure by the endpoints of the
   * user's absence conflates the two, and the direction of the error then
   * depends on how long they happened to be away, which is exactly the property
   * a detector must not have.
   */
  maxSessionMove(symbol: string, fromTs: number, toTs: number): number | null {
    const h = this.history.get(symbol);
    if (!h) return null;
    let prev: Paise | null = null;
    let worst = 0;
    let seen = false;
    for (const b of h.bars) {
      if (b.close == null) continue;
      if (b.ts < fromTs) {
        prev = b.close; // carry the anchor up to the window edge
        continue;
      }
      if (b.ts > toTs) break;
      if (prev != null && prev > 0) {
        const r = (b.close - prev) / prev;
        if (Math.abs(r) > Math.abs(worst)) worst = r;
        seen = true;
      }
      prev = b.close;
    }
    return seen ? worst : null;
  }

  knows(symbol: string): boolean {
    return this.history.has(symbol) || this.intraday.has(symbol);
  }
}

/** Binary search for the last element at or before `ts`. */
function lastAtOrBefore<T>(arr: readonly T[], ts: number, key: (x: T) => number): T | null {
  let lo = 0;
  let hi = arr.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]!) <= ts) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? null : arr[found]!;
}
