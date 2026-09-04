/**
 * Replay provider: a recorded trading session, served as if it were live.
 *
 * This exists for two reasons, and the second one is the important one.
 *
 * The obvious reason is that this was built over a weekend. NSE was open for
 * sixty-eight minutes of the seventy-two available, so a recorder was the first
 * thing written and everything since has been developed against its output.
 *
 * The real reason is that resilience claims are worthless unless someone can
 * check them. Every system says it handles stale data; almost none will let you
 * see it happen. This provider takes a fault configuration, so a reviewer can
 * kill the feed, freeze a symbol, inject a corrupt tick, deliver prints out of
 * order, or drop a 10:1 split on a stock that has no corporate action on file,
 * and watch what the product does about it. The failure paths are demonstrable
 * rather than asserted.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Clock } from "../core/clock.js";
import { toPaise } from "../core/money.js";
import type { FetchResult, MarketDataProvider, ProviderHealth, RawQuote } from "./provider.js";

interface RecordedTick {
  sym: string;
  poll_ts: number; // seconds, float
  mkt_ts: number | null; // seconds
  ltp: number | null;
  prev_close: number | null;
  day_high: number | null;
  day_low: number | null;
  vol: number | null;
  w52_high: number | null;
  w52_low: number | null;
}

export type FaultKind =
  | "NONE"
  | "FEED_DOWN"
  | "RATE_LIMITED"
  | "FROZEN"
  | "CORRUPT_TICK"
  | "OUT_OF_ORDER"
  | "PHANTOM_SPLIT"
  | "GARBAGE_PRICE"
  | "SYMBOL_GONE";

export interface Fault {
  kind: FaultKind;
  /** Null means "apply to every symbol". */
  symbol: string | null;
  /** For PHANTOM_SPLIT: the ratio to divide the price by. */
  ratio?: number;
  /** Set when the fault was armed, for display. */
  since?: number;
}

export const NO_FAULT: Fault = { kind: "NONE", symbol: null };

export const FAULT_DESCRIPTIONS: Record<FaultKind, string> = {
  NONE: "Feed healthy.",
  FEED_DOWN: "Provider is unreachable. Every fetch fails; the product must serve last-known-good and say so.",
  RATE_LIMITED: "Provider is refusing requests. Should back off with jitter, not hammer.",
  GARBAGE_PRICE: "A price eighty-five times the previous close, as a paise-for-rupees units bug produces. This one genuinely is not a price, and must never reach the screen.",
  FROZEN: "Quotes still arrive but the exchange timestamp stops advancing. This is the case a naive staleness check misses, because bytes are still flowing.",
  CORRUPT_TICK: "A price 47% away from the previous close, with nothing in the corporate-action feed to explain it. Larger than any Indian equity moves between two closes, and not large enough to be an encoding error: the detector must quarantine it and say why, not report a 47% gain.",
  OUT_OF_ORDER: "An older print re-delivered after a newer one. Must not overwrite the newer price.",
  PHANTOM_SPLIT: "Price divided overnight with nothing in the corporate-action feed, exactly as Vedanta's real demerger behaved. Must be caught by the statistical guard, not reported as a crash.",
  SYMBOL_GONE: "The provider stops returning this symbol, as happens on a rename or delisting.",
};

export class ReplayProvider implements MarketDataProvider {
  readonly name = "replay";
  readonly cadenceMs: number;
  readonly closeAdjustment = "SPLIT_ADJUSTED" as const;

  private readonly bySymbol = new Map<string, RecordedTick[]>();
  private fault: Fault = NO_FAULT;
  private lastServed = new Map<string, number>();
  private lastSuccessTs: number | null = null;
  private lastErrorTs: number | null = null;
  private lastError: string | null = null;

  readonly from: number;
  readonly to: number;

  constructor(
    private readonly clock: Clock,
    ticks: RecordedTick[],
    opts: { cadenceMs?: number } = {},
  ) {
    this.cadenceMs = opts.cadenceMs ?? 40_000;
    for (const t of ticks) {
      if (!t?.sym || typeof t.poll_ts !== "number") continue;
      const arr = this.bySymbol.get(t.sym) ?? [];
      arr.push(t);
      this.bySymbol.set(t.sym, arr);
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const arr of this.bySymbol.values()) {
      arr.sort((a, b) => a.poll_ts - b.poll_ts);
      lo = Math.min(lo, arr[0]!.poll_ts * 1000);
      hi = Math.max(hi, arr[arr.length - 1]!.poll_ts * 1000);
    }
    this.from = Number.isFinite(lo) ? lo : Date.now();
    this.to = Number.isFinite(hi) ? hi : Date.now();
  }

  static fromFile(clock: Clock, path: string): ReplayProvider {
    if (!existsSync(path)) return new ReplayProvider(clock, []);
    const ticks: RecordedTick[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        ticks.push(JSON.parse(line));
      } catch {
        // A truncated final line is expected while the recorder is still
        // running. Skipping it is correct; failing the load is not.
      }
    }
    return new ReplayProvider(clock, ticks);
  }

  setFault(f: Fault): void {
    this.fault = { ...f, since: this.clock.now() };
  }

  currentFault(): Fault {
    return this.fault;
  }

  symbolsAvailable(): string[] {
    return [...this.bySymbol.keys()];
  }

  hasData(): boolean {
    return this.bySymbol.size > 0;
  }

  async fetchQuotes(symbols: string[]): Promise<FetchResult> {
    const quotes = new Map<string, RawQuote>();
    const failures = new Map<string, string>();
    const now = this.clock.now();
    const f = this.fault;

    if (f.kind === "FEED_DOWN" && f.symbol == null) {
      this.lastErrorTs = now;
      this.lastError = "injected: provider unreachable";
      for (const s of symbols) failures.set(s, "provider unreachable (injected fault)");
      return { quotes, failures, health: this.health() };
    }
    if (f.kind === "RATE_LIMITED" && f.symbol == null) {
      this.lastErrorTs = now;
      this.lastError = "injected: HTTP 429";
      for (const s of symbols) failures.set(s, "HTTP 429 rate limited (injected fault)");
      return { quotes, failures, health: this.health() };
    }

    for (const symbol of symbols) {
      const targeted = f.symbol === symbol;

      if (targeted && (f.kind === "SYMBOL_GONE" || f.kind === "FEED_DOWN")) {
        failures.set(symbol, "symbol not returned by provider (injected fault)");
        continue;
      }

      const tick = this.tickAt(symbol, now, targeted && f.kind === "OUT_OF_ORDER");
      if (!tick) {
        failures.set(symbol, "no recorded data for this symbol at this instant");
        continue;
      }

      let ltp = tick.ltp;
      let exchangeTs = tick.mkt_ts != null ? tick.mkt_ts * 1000 : tick.poll_ts * 1000;

      if (targeted) {
        if (f.kind === "FROZEN") {
          // Bytes keep flowing; the exchange stamp stops moving. A freshness
          // check that looks at receipt time instead of trade time misses this
          // entirely, which is the point of the fault.
          //
          // The stamp is pinned to the moment the fault was armed, not to the
          // start of the recording. Serving the very first tick looked more
          // dramatic and did nothing at all: it is older than the quote already
          // in the store, so the monotonic guard rejected it and the freeze
          // never landed. Pinning to the arming moment means the quote simply
          // stops advancing and ages, which is what a symbol that has stopped
          // printing actually looks like.
          const pinned = this.tickAt(symbol, f.since ?? now, false);
          if (pinned) exchangeTs = (pinned.mkt_ts ?? pinned.poll_ts) * 1000;
        }
        if (f.kind === "CORRUPT_TICK" && ltp != null) {
          ltp = ltp * 1.47; // beyond trading, inside the sanity band: detect() judges it
        }
        if (f.kind === "GARBAGE_PRICE" && ltp != null) {
          ltp = ltp * 85; // a units error, not a price: the quality layer rejects it
        }
        if (f.kind === "PHANTOM_SPLIT" && ltp != null) {
          ltp = ltp / (f.ratio && f.ratio > 1 ? f.ratio : 10);
        }
      }

      quotes.set(symbol, {
        symbol,
        ltp: toPaise(ltp),
        prevClose: toPaise(tick.prev_close),
        dayHigh: toPaise(tick.day_high),
        dayLow: toPaise(tick.day_low),
        volume: tick.vol ?? null,
        week52High: toPaise(tick.w52_high),
        week52Low: toPaise(tick.w52_low),
        exchangeTs,
      });
    }

    if (quotes.size > 0) this.lastSuccessTs = now;
    return { quotes, failures, health: this.health() };
  }

  /**
   * The most recent recorded tick at or before `at`.
   *
   * Binary search rather than a scan: with a full session recorded across fifty
   * symbols this is called on every poll for every symbol, and the linear
   * version showed up immediately once the recording grew past a few thousand
   * lines.
   */
  private tickAt(symbol: string, at: number, deliverOlder: boolean): RecordedTick | null {
    const arr = this.bySymbol.get(symbol);
    if (!arr || arr.length === 0) return null;

    let lo = 0;
    let hi = arr.length - 1;
    let found = -1;
    const target = at / 1000;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.poll_ts <= target) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === -1) {
      // Before the recording starts: serve the first tick rather than nothing,
      // so a reviewer who lands outside the window still sees a working product.
      found = 0;
    }
    if (deliverOlder) found = Math.max(0, found - 8);
    this.lastServed.set(symbol, found);
    return arr[found]!;
  }

  health(): ProviderHealth {
    return {
      name: this.fault.kind === "NONE" ? this.name : `${this.name} (fault: ${this.fault.kind})`,
      breaker: this.fault.kind === "FEED_DOWN" || this.fault.kind === "RATE_LIMITED" ? "OPEN" : "CLOSED",
      lastSuccessTs: this.lastSuccessTs,
      lastErrorTs: this.lastErrorTs,
      lastError: this.lastError,
      consecutiveFailures: 0,
    };
  }
}
