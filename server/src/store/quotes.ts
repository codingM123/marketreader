/**
 * The hot quote store: last-known-good price per symbol, in memory.
 *
 * Ticks never reach disk. There is exactly one current price per symbol no
 * matter how many users watch it, so the working set is bounded by the size of
 * the exchange (roughly two thousand listed equities), not by the user base.
 * That is the whole reason this system's cost does not grow with users.
 *
 * The other job here is ordering. Market data arrives out of order: retries,
 * multiple upstream connections, a provider replaying a buffer after a
 * reconnect. A store that simply takes the newest write will happily replace a
 * 15:29 price with a re-delivered 15:24 one, and the user watches the price go
 * backwards in time. The guard is a strict monotonicity check on the exchange
 * timestamp, and rejections are counted rather than swallowed, because a rising
 * rejection rate is the earliest signal that an upstream is misbehaving.
 */
import type { Paise } from "../core/money.js";

export interface Quote {
  symbol: string;
  ltp: Paise | null;
  prevClose: Paise | null;
  dayHigh: Paise | null;
  dayLow: Paise | null;
  volume: number | null;
  week52High: Paise | null;
  week52Low: Paise | null;
  /** Exchange-stamped time of the last trade. The only clock we order by. */
  exchangeTs: number | null;
  /** When we received it. Used for lag observability, never for ordering. */
  ingestTs: number;
  source: string;
}

export type PutResult = "ACCEPTED" | "REJECTED_OUT_OF_ORDER" | "REJECTED_DUPLICATE" | "REJECTED_INVALID";

export interface StoreStats {
  symbols: number;
  accepted: number;
  outOfOrder: number;
  duplicates: number;
  invalid: number;
  /** Newest exchange timestamp anywhere in the store. */
  freshestExchangeTs: number | null;
  /** Median lag between exchange stamp and our receipt, in ms. */
  medianLagMs: number | null;
}

export class QuoteStore {
  private readonly map = new Map<string, Quote>();
  /** symbol -> when the provider last failed to return it, and why. */
  private readonly failures = new Map<string, { since: number; reason: string }>();
  private accepted = 0;
  private outOfOrder = 0;
  private duplicates = 0;
  private invalid = 0;
  private lags: number[] = [];

  put(q: Quote): PutResult {
    if (q.ltp == null || q.exchangeTs == null || !Number.isFinite(q.ltp) || q.ltp <= 0) {
      this.invalid++;
      // Still recorded, so the quality layer can report UNAVAILABLE with the
      // source and timestamp rather than a bare absence.
      if (!this.map.has(q.symbol)) this.map.set(q.symbol, q);
      return "REJECTED_INVALID";
    }

    const prev = this.map.get(q.symbol);
    if (prev?.exchangeTs != null) {
      if (q.exchangeTs < prev.exchangeTs) {
        this.outOfOrder++;
        return "REJECTED_OUT_OF_ORDER";
      }
      if (q.exchangeTs === prev.exchangeTs && q.ltp === prev.ltp) {
        // Same print re-delivered. Common and harmless: our poller runs faster
        // than an illiquid stock trades. Counted so the ratio stays visible.
        this.duplicates++;
        return "REJECTED_DUPLICATE";
      }
    }

    this.map.set(q.symbol, q);
    this.accepted++;
    const lag = q.ingestTs - q.exchangeTs;
    if (lag >= 0 && lag < 3600_000) {
      this.lags.push(lag);
      if (this.lags.length > 2000) this.lags = this.lags.slice(-1000);
    }
    return "ACCEPTED";
  }

  /**
   * Record that the provider declined to return a symbol this cycle.
   *
   * Without this the quality layer sees only "no new print" and cannot tell a
   * thinly traded scrip from one the provider has stopped carrying -- which is
   * precisely the distinction the taxonomy exists to make. The provider knows;
   * throwing that away and then inferring it from silence is strictly worse
   * than passing it along.
   */
  markFailure(symbol: string, reason: string, now: number): void {
    if (!this.failures.has(symbol)) this.failures.set(symbol, { since: now, reason });
  }

  clearFailure(symbol: string): void {
    this.failures.delete(symbol);
  }

  failureFor(symbol: string): { since: number; reason: string } | null {
    return this.failures.get(symbol) ?? null;
  }

  get(symbol: string): Quote | null {
    return this.map.get(symbol) ?? null;
  }

  has(symbol: string): boolean {
    return this.map.has(symbol);
  }

  symbols(): string[] {
    return [...this.map.keys()];
  }

  /**
   * Newest exchange timestamp across every symbol we hold.
   *
   * This single number is what lets the quality layer tell an untraded stock
   * apart from a dead feed, so it is worth the linear scan. At a few thousand
   * symbols it is microseconds; if the universe grew, it would become an
   * incrementally maintained maximum.
   */
  freshestExchangeTs(): number | null {
    let best: number | null = null;
    for (const q of this.map.values()) {
      if (q.exchangeTs != null && (best == null || q.exchangeTs > best)) best = q.exchangeTs;
    }
    return best;
  }

  stats(): StoreStats {
    const sorted = [...this.lags].sort((a, b) => a - b);
    return {
      symbols: this.map.size,
      accepted: this.accepted,
      outOfOrder: this.outOfOrder,
      duplicates: this.duplicates,
      invalid: this.invalid,
      freshestExchangeTs: this.freshestExchangeTs(),
      medianLagMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
    };
  }

  /** Test and time-machine support: drop everything and start clean. */
  clear(): void {
    this.map.clear();
    this.failures.clear();
  }
}
