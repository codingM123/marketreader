/**
 * Fan-in ingestion.
 *
 * This is the answer to "how does it scale for larger watchlists and more
 * users", and it is a shape decision rather than an optimisation.
 *
 * The obvious design fetches each user's list when that user asks for it. Its
 * cost is users x symbols: ten thousand users watching twenty stocks each is two
 * hundred thousand fetches per refresh, almost all of them for the same few
 * hundred tickers, and it gets worse in exactly the situation you most want it
 * to hold up: everyone opening the app at once because the market just moved.
 *
 * This worker subscribes to the *union* of every symbol any user watches. There
 * is one current price for Reliance whether one person or a million watch it,
 * so the cost is bounded by the size of the exchange (roughly two thousand
 * listed equities) and is flat in the number of users. The ratio between what a
 * naive design would fetch and what this one does is reported as `fanInRatio`,
 * because a number nobody can see is a claim rather than a property.
 *
 * The worker never blocks a request. Reads hit the in-memory store; if a cycle
 * is slow or failing, users get the last known good price with its age attached,
 * which is a better answer than a spinner.
 */
import type { Clock } from "../core/clock.js";
import type { MarketDataProvider } from "../data/provider.js";
import type { QuoteStore, PutResult } from "../store/quotes.js";

export interface CycleReport {
  startedAt: number;
  durationMs: number;
  requested: number;
  accepted: number;
  rejected: Record<string, number>;
  failed: number;
  failures: string[];
}

export interface WorkerOptions {
  provider: MarketDataProvider;
  store: QuoteStore;
  clock: Clock;
  /** Distinct symbols anyone watches, plus anything the system needs itself. */
  universe: () => string[];
  /** What a naive per-user design would have fetched. Observability only. */
  naiveDemand?: () => number;
  intervalMs: number;
  onCycle?: (r: CycleReport) => void;
}

export class IngestWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cycles = 0;
  private last: CycleReport | null = null;

  constructor(private readonly opts: WorkerOptions) {}

  start(): void {
    if (this.timer) return;
    // Kick immediately so a freshly started server is not blank for a full
    // interval, then settle into the cadence.
    void this.cycleNow();
    this.timer = setInterval(() => void this.cycleNow(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over the universe.
   *
   * Guarded against overlap: if a cycle is still in flight when the timer
   * fires, the new one is dropped rather than queued. Queueing them is how a
   * provider slowdown turns into an unbounded backlog and then into a rate-limit
   * ban, which is the failure this design is trying to avoid in the first place.
   */
  async cycleNow(): Promise<CycleReport> {
    if (this.running) {
      return (
        this.last ?? {
          startedAt: this.opts.clock.now(),
          durationMs: 0,
          requested: 0,
          accepted: 0,
          rejected: {},
          failed: 0,
          failures: ["skipped: previous cycle still running"],
        }
      );
    }
    this.running = true;
    const startedAt = this.opts.clock.now();
    const wall = Date.now();

    const symbols = [...new Set(this.opts.universe())];
    const rejected: Record<string, number> = {};
    let accepted = 0;

    let failures: string[] = [];
    try {
      const res = await this.opts.provider.fetchQuotes(symbols);
      for (const [symbol, raw] of res.quotes) {
        const r: PutResult = this.opts.store.put({
          symbol,
          ltp: raw.ltp,
          prevClose: raw.prevClose,
          dayHigh: raw.dayHigh,
          dayLow: raw.dayLow,
          volume: raw.volume,
          week52High: raw.week52High,
          week52Low: raw.week52Low,
          exchangeTs: raw.exchangeTs,
          ingestTs: this.opts.clock.now(),
          source: this.opts.provider.name,
        });
        if (r === "ACCEPTED") accepted++;
        else rejected[r] = (rejected[r] ?? 0) + 1;
      }
      // Success and failure are both facts about a symbol, and both are
      // recorded. A symbol the provider has stopped returning must not look
      // the same downstream as one that simply has not traded.
      for (const symbol of res.quotes.keys()) this.opts.store.clearFailure(symbol);
      for (const [symbol, why] of res.failures) {
        this.opts.store.markFailure(symbol, why, this.opts.clock.now());
      }
      failures = [...res.failures].map(([s, why]) => `${s}: ${why}`);
    } catch (e) {
      // A provider that throws rather than returning failures must not take the
      // worker down; the next cycle retries.
      failures = [e instanceof Error ? e.message : String(e)];
    } finally {
      this.running = false;
    }

    this.cycles++;
    const report: CycleReport = {
      startedAt,
      durationMs: Date.now() - wall,
      requested: symbols.length,
      accepted,
      rejected,
      failed: failures.length,
      failures: failures.slice(0, 10),
    };
    this.last = report;
    this.opts.onCycle?.(report);
    return report;
  }

  stats() {
    const distinct = new Set(this.opts.universe()).size;
    const naive = this.opts.naiveDemand?.() ?? distinct;
    return {
      provider: this.opts.provider.name,
      cadenceMs: this.opts.provider.cadenceMs,
      intervalMs: this.opts.intervalMs,
      cycles: this.cycles,
      /** What this worker actually fetches: one per symbol anyone watches. */
      distinctSymbols: distinct,
      /** What a per-user design would fetch: every row of every watchlist. */
      watchlistRowsAcrossUsers: naive,
      /**
       * Redundant fetches removed each cycle. Near zero with one account, which
       * is honest: the design pays off with users, not with symbols. The gap
       * widens without bound as accounts are added, because the numerator grows
       * and the denominator is capped by the size of the exchange.
       */
      fetchesSavedPerCycle: Math.max(0, naive - distinct),
      fanInRatio: distinct > 0 ? Number((naive / distinct).toFixed(2)) : 1,
      lastCycle: this.last,
      providerHealth: this.opts.provider.health(),
      store: this.opts.store.stats(),
    };
  }
}
