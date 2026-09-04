/**
 * The market data boundary.
 *
 * Everything above this interface deals in symbols and prices. Nothing above it
 * knows that one provider calls the last traded price `regularMarketPrice`,
 * that another returns rupees where a third returns paise, or that the "close"
 * column means three different things depending on who you ask. When a provider
 * changes, or a second is added, this directory is what moves.
 *
 * The interface is deliberately batch-shaped: `fetchQuotes(symbols)` rather than
 * `fetchQuote(symbol)`. That shape is what makes fan-in possible. Ingestion
 * subscribes to the union of every symbol any user watches and asks for all of
 * them at once, so the cost of the system scales with the size of the exchange
 * rather than with the number of users multiplied by their list lengths.
 */
import { toPaise, type Paise } from "../core/money.js";
import { TokenBucket, CircuitBreaker, backoffDelay, withTimeout } from "./resilience.js";

export interface RawQuote {
  symbol: string;
  ltp: Paise | null;
  prevClose: Paise | null;
  dayHigh: Paise | null;
  dayLow: Paise | null;
  volume: number | null;
  week52High: Paise | null;
  week52Low: Paise | null;
  /** Exchange-stamped. Null when the provider does not supply one, which is
   *  itself a quality signal: we will not invent a timestamp. */
  exchangeTs: number | null;
}

export interface FetchResult {
  quotes: Map<string, RawQuote>;
  /** symbol -> why it failed. Partial success is the normal case, not an error. */
  failures: Map<string, string>;
  /** Provider-level health, surfaced on the status endpoint. */
  health: ProviderHealth;
}

export interface ProviderHealth {
  name: string;
  breaker: string;
  lastSuccessTs: number | null;
  lastErrorTs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface MarketDataProvider {
  readonly name: string;
  /** How often this provider is expected to produce a new print, in ms. */
  readonly cadenceMs: number;
  /** Declared semantics of any historical closes this provider supplies. */
  readonly closeAdjustment: "RAW" | "SPLIT_ADJUSTED" | "SPLIT_AND_DIVIDEND_ADJUSTED";
  fetchQuotes(symbols: string[]): Promise<FetchResult>;
  health(): ProviderHealth;
}

// ---------------------------------------------------------------- Yahoo ----

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface YahooOptions {
  /** Sustained requests per second. Kept well under what the endpoint tolerates. */
  ratePerSec?: number;
  timeoutMs?: number;
  now?: () => number;
}

export class YahooProvider implements MarketDataProvider {
  readonly name = "yahoo";
  readonly cadenceMs = 60_000; // the free endpoint is delayed; treat it as such
  readonly closeAdjustment = "SPLIT_ADJUSTED" as const;

  private readonly bucket: TokenBucket;
  private readonly breaker = new CircuitBreaker(5, 30_000);
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private lastSuccessTs: number | null = null;
  private lastErrorTs: number | null = null;
  private lastError: string | null = null;
  private attempt = 0;

  constructor(opts: YahooOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.bucket = new TokenBucket(12, opts.ratePerSec ?? 5, this.now());
  }

  async fetchQuotes(symbols: string[]): Promise<FetchResult> {
    const quotes = new Map<string, RawQuote>();
    const failures = new Map<string, string>();

    if (!this.breaker.allow(this.now())) {
      for (const s of symbols) failures.set(s, "circuit open: provider is failing, serving last known good");
      return { quotes, failures, health: this.health() };
    }

    let anySuccess = false;
    for (const symbol of symbols) {
      const wait = this.bucket.take(this.now());
      if (wait > 0) await sleep(wait);
      try {
        const q = await withTimeout(this.fetchOne(symbol), this.timeoutMs, `yahoo ${symbol}`);
        quotes.set(symbol, q);
        anySuccess = true;
      } catch (e) {
        failures.set(symbol, e instanceof Error ? e.message : String(e));
      }
    }

    if (anySuccess) {
      this.breaker.succeed();
      this.attempt = 0;
      this.lastSuccessTs = this.now();
    } else if (symbols.length > 0) {
      this.breaker.fail(this.now());
      this.attempt++;
      this.lastErrorTs = this.now();
      this.lastError = [...failures.values()][0] ?? "unknown";
      // Back off before the caller's next cycle, with jitter so a fleet of
      // symbols that failed together does not retry in lockstep.
      await sleep(backoffDelay(this.attempt));
    }

    return { quotes, failures, health: this.health() };
  }

  private async fetchOne(symbol: string): Promise<RawQuote> {
    const y = symbol.startsWith("^") ? symbol : symbol + ".NS";
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}` +
      `?interval=1m&range=1d`;

    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    const meta = body?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error("no result in payload");

    return {
      symbol,
      ltp: toPaise(meta.regularMarketPrice),
      prevClose: toPaise(meta.chartPreviousClose ?? meta.previousClose),
      dayHigh: toPaise(meta.regularMarketDayHigh),
      dayLow: toPaise(meta.regularMarketDayLow),
      volume: typeof meta.regularMarketVolume === "number" ? meta.regularMarketVolume : null,
      week52High: toPaise(meta.fiftyTwoWeekHigh),
      week52Low: toPaise(meta.fiftyTwoWeekLow),
      // Seconds from the provider; we work in milliseconds everywhere.
      exchangeTs: typeof meta.regularMarketTime === "number" ? meta.regularMarketTime * 1000 : null,
    };
  }

  health(): ProviderHealth {
    const snap = this.breaker.snapshot(this.now());
    return {
      name: this.name,
      breaker: snap.state,
      lastSuccessTs: this.lastSuccessTs,
      lastErrorTs: this.lastErrorTs,
      lastError: this.lastError,
      consecutiveFailures: snap.failures,
    };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
