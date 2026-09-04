/**
 * Composition root and the digest pipeline.
 *
 * Everything above this file is pure: given a quote, a baseline and a
 * watermark, `detect` returns signals and cannot do anything else. Everything
 * below it is I/O. This is the one place where the two meet, and it is
 * deliberately the only place that knows about both.
 */
import { join } from "node:path";
import { VirtualClock, type Clock } from "./core/clock.js";
import { sessionAt, detectUnexpectedlyQuiet, lastRegularClose, sessionBands, type SessionBand } from "./core/calendar.js";
import { assess, SANITY_BAND, DEFAULT_CIRCUIT_BAND, INDEX_CIRCUIT_BAND } from "./core/quality.js";
import { computeBaseline, emptyBaseline, type Baseline } from "./core/baseline.js";
import { detect, PRESETS, type Policy, type Signal } from "./core/detect.js";
import { rank, type RankedSignal, type Suppressed, type MarketContext } from "./core/rank.js";
import { buildDigest, describeAbsence, narrate, type Digest, type PathPoint } from "./core/digest.js";
import { decomposeReturn, NO_ACTIONS, type CorporateActions } from "./core/corporate.js";
import { ret, type Paise } from "./core/money.js";
import { loadHistoryDir, adjustmentMismatches, type SymbolHistory, type AdjustmentMismatch } from "./data/history.js";
import { PriceOracle } from "./data/oracle.js";
import { ReplayProvider, NO_FAULT, type Fault } from "./data/replay.js";
import { YahooProvider, type MarketDataProvider } from "./data/provider.js";
import { QuoteStore } from "./store/quotes.js";
import { IngestWorker } from "./ingest/worker.js";
import * as store from "./store/db.js";
import { readFileSync, existsSync } from "node:fs";

export const INDEX_SYMBOL = "^NSEI";
export const INDEX_LABEL = "NIFTY 50";

export interface SymbolRow {
  symbol: string;
  name: string;
  price: Paise | null;
  prevClose: Paise | null;
  /** Move since the previous session close. The conventional number. */
  changeToday: number | null;
  /** Move since THIS user last acknowledged the symbol. The one that matters. */
  changeSinceSeen: number | null;
  /** Same window, uncorrected. Shown in the audit view to expose the difference. */
  rawSinceSeen: number | null;
  watermarkTs: number;
  watermarkPrice: Paise | null;
  quality: string;
  qualityReason: string;
  ageMs: number | null;
  displayable: boolean;
  week52High: Paise | null;
  week52Low: Paise | null;
  dailyVol: number | null;
  beta: number | null;
  observations: number;
  corporateActions: number;
}

export interface DigestResponse {
  digest: Digest;
  rows: SymbolRow[];
  /** Sparkline over each surfaced card's own window, keyed by symbol. */
  paths: Record<string, PathPoint[]>;
  /** Narrative facts, present only when the absence was long enough to need them. */
  narratives: Record<string, ReturnType<typeof narrate>>;
  session: ReturnType<typeof sessionAt> & { unexpectedlyQuiet: boolean };
  /** Open-market windows inside the absence, for shading the ruler. */
  sessionBands: SessionBand[];
  policy: Policy & { name: string };
}

export interface AppOptions {
  dataDir: string;
  dbPath: string;
  mode: "replay" | "live";
  intervalMs?: number;
}

export class App {
  readonly db: store.DB;
  readonly quotes = new QuoteStore();
  readonly clock: VirtualClock;
  readonly provider: MarketDataProvider;
  readonly replay: ReplayProvider | null;
  readonly worker: IngestWorker;
  readonly oracle: PriceOracle;
  readonly history: Map<string, SymbolHistory>;
  private readonly baselines = new Map<string, Baseline>();
  readonly mode: "replay" | "live";
  /**
   * Symbols whose recorded data contradicts the declared price-adjustment
   * semantics. Checked at boot and surfaced on /api/status: a silent
   * disagreement here corrupts every volatility estimate downstream, which is
   * the one bug in this project that cost the most to find.
   */
  readonly adjustmentMismatches: AdjustmentMismatch[];

  constructor(opts: AppOptions) {
    this.mode = opts.mode;
    this.db = store.openDb(opts.dbPath);
    this.history = loadHistoryDir(join(opts.dataDir, "history"));
    this.oracle = new PriceOracle(this.history);

    // The clock is virtual even in live mode, sitting at zero offset. Making it
    // the same object in both modes means the time-travel path is exercised by
    // ordinary use rather than only in the demo.
    this.clock = new VirtualClock(Date.now(), 1);

    const tickPath = join(opts.dataDir, "ticks.jsonl");
    this.replay = opts.mode === "replay" ? ReplayProvider.fromFile(this.clock, tickPath) : null;

    if (this.replay?.hasData()) {
      // Land the clock inside the recorded session, a little after its start so
      // there is history behind the opening view.
      const span = this.replay.to - this.replay.from;
      this.clock.seek(this.replay.from + Math.min(span * 0.35, span));
      this.loadIntradayFromTicks(tickPath);
    }

    this.provider = this.replay?.hasData() ? this.replay : new YahooProvider();

    this.adjustmentMismatches = adjustmentMismatches(this.history);
    if (this.adjustmentMismatches.length > 0) {
      // Loud, at boot, on stderr. Not a throw: refusing to start would take the
      // whole product down over a handful of symbols, and every other symbol's
      // numbers are still correct. But it must never be silent.
      for (const m of this.adjustmentMismatches) {
        process.stderr.write(
          `[adjustment] ${m.symbol}: provider declares ${m.declared} but the data shows ` +
            `${m.observed}. Volatility for this symbol will be wrong until this is resolved.\n`,
        );
      }
    }

    for (const h of this.history.values()) {
      store.upsertSymbol(this.db, h.symbol, h.displayName, h.symbol.startsWith("^"));
      this.baselines.set(
        h.symbol,
        computeBaseline(h.symbol, h.bars, h.actions, this.history.get(INDEX_SYMBOL)?.bars ?? null, {
          // No session the clock says is still open.
          asOf: this.clock.now(),
          // The declaration that belongs to *these bars*, not to whichever live
          // quote provider happens to be wired in. Using the provider's was
          // correct only by coincidence: both say SPLIT_ADJUSTED today, and a
          // second provider declaring RAW would have silently double-adjusted
          // the historical series -- reintroducing, through a different seam,
          // the exact bug this field was added to prevent.
          closeAdjustment: h.closeAdjustment,
        }),
      );
    }

    this.worker = new IngestWorker({
      provider: this.provider,
      store: this.quotes,
      clock: this.clock,
      universe: () => {
        // The index is always ingested: without it there is no market-relative
        // view, and market-relative is what keeps a red day readable.
        const watched = store.watchedUniverse(this.db);
        return [...new Set([INDEX_SYMBOL, ...watched])];
      },
      naiveDemand: () =>
        (this.db.prepare(`SELECT COUNT(*) AS n FROM watchlist_items`).get() as { n: number }).n,
      intervalMs: opts.intervalMs ?? 15_000,
    });
  }

  /** Index recorded ticks so intraday windows resolve at tick resolution. */
  private loadIntradayFromTicks(path: string): void {
    if (!existsSync(path)) return;
    const bySymbol = new Map<string, { ts: number; price: Paise }[]>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        if (t?.ltp == null || typeof t.poll_ts !== "number") continue;
        const arr = bySymbol.get(t.sym) ?? [];
        arr.push({ ts: t.poll_ts * 1000, price: Math.round(t.ltp * 100) });
        bySymbol.set(t.sym, arr);
      } catch {
        // Truncated trailing line while the recorder is still running.
      }
    }
    for (const [sym, pts] of bySymbol) this.oracle.loadIntraday(sym, pts);
  }

  baselineFor(symbol: string): Baseline {
    return this.baselines.get(symbol) ?? emptyBaseline(symbol);
  }

  actionsFor(symbol: string): CorporateActions {
    return this.history.get(symbol)?.actions ?? NO_ACTIONS(symbol);
  }

  nameFor(symbol: string): string {
    return this.history.get(symbol)?.displayName ?? symbol;
  }

  policyFor(userId: string): Policy & { name: string } {
    const u = store.getUser(this.db, userId);
    const name = (u?.policy ?? "balanced") as keyof typeof PRESETS;
    const p = PRESETS[name] ?? PRESETS.balanced;
    return { ...p, name };
  }

  // ------------------------------------------------------------- digest --

  /**
   * Compute a digest. Pure with respect to the database: reads, never writes.
   *
   * Splitting this out fixed a real problem and enabled a feature. GET
   * /api/digest used to append to the event log, so a query-named endpoint was
   * a command -- and the SSE stream calls it every three seconds per connected
   * reader, which meant the "immutable event log" was being appended to on a
   * timer by anyone with a browser tab open.
   *
   * `awayOverrideMs` answers "what would I see if I had last looked N ago?"
   * without touching anyone's watermark. The landing page is built on it: a
   * reader drags one slider and the digest rewrites itself from real recorded
   * prices, which is the entire thesis demonstrated rather than described.
   */
  computeDigest(userId: string, awayOverrideMs?: number): DigestResponse {
    const now = this.clock.now();
    const session = sessionAt(now);
    const policy = this.policyFor(userId);
    const items = store.listWatch(this.db, userId);
    const marks = store.getWatermarks(this.db, userId);
    const freshest = this.quotes.freshestExchangeTs();

    const rows: SymbolRow[] = [];
    const signals: Signal[] = [];
    let degraded = 0;
    let unavailable = 0;

    // The absence window shown at the top is the oldest acknowledgement across
    // the list: the user's real gap, not a per-symbol average.
    let oldestSeen = now;
    let anyRealWatermark = false;

    for (const item of items) {
      const symbol = item.symbol;
      const wm = marks.get(symbol);
      const watermarkTs =
        awayOverrideMs != null ? now - awayOverrideMs : (wm?.seen_ts ?? item.added_at);
      if (awayOverrideMs != null || (wm && wm.is_seed === 0)) {
        anyRealWatermark = true;
        oldestSeen = Math.min(oldestSeen, watermarkTs);
      }

      const q = this.quotes.get(symbol);
      const isIndex = symbol.startsWith("^");
      const assessment = assess(
        {
          symbol,
          ltp: q?.ltp ?? null,
          prevClose: q?.prevClose ?? null,
          exchangeTs: q?.exchangeTs ?? null,
          ingestTs: q?.ingestTs ?? null,
        },
        {
          now,
          session,
          cadenceMs: this.provider.cadenceMs,
          universeFreshestTs: freshest,
          providerFailure: this.quotes.failureFor(symbol),
          // A wide sanity band, not the regulatory one. Its job is to reject
          // values that are not prices; genuine large moves are the detector's
          // problem, and it has better language for them than "suspect".
          circuitBand: SANITY_BAND,
        },
      );

      if (assessment.quality === "UNAVAILABLE") unavailable++;
      else if (!assessment.usableForSignals) degraded++;

      const baseline = this.baselineFor(symbol);
      const actions = this.actionsFor(symbol);

      // Prefer the price recorded at acknowledgement. Falling back to the
      // oracle is correct but weaker: a series can be re-adjusted underneath us,
      // and the number the user actually saw cannot.
      const watermarkPrice =
        awayOverrideMs != null
          ? (this.oracle.priceAt(symbol, watermarkTs)?.price ?? null)
          : (wm?.seen_price ?? this.oracle.priceAt(symbol, watermarkTs)?.price ?? null);

      const marketReturn =
        symbol === INDEX_SYMBOL ? null : this.oracle.returnBetween(INDEX_SYMBOL, watermarkTs, now);

      const found = detect({
        symbol,
        now,
        watermarkTs,
        watermarkPrice,
        price: q?.ltp ?? null,
        prevClose: q?.prevClose ?? null,
        exchangeTs: q?.exchangeTs ?? null,
        dayVolume: q?.volume ?? null,
        // The worst single session inside the window, which is what tells a
        // demerger apart from a long decline. Falls back inside detect() to the
        // move against the previous close when no path is known.
        maxSessionMove: this.oracle.maxSessionMove(symbol, watermarkTs, now),
        assessment,
        baseline,
        actions,
        marketReturn,
        circuitBand: isIndex ? INDEX_CIRCUIT_BAND : DEFAULT_CIRCUIT_BAND,
        policy,
      });
      signals.push(...found);

      const dec = decomposeReturn(watermarkPrice, watermarkTs, q?.ltp ?? null, q?.exchangeTs ?? now, actions);
      rows.push({
        symbol,
        name: this.nameFor(symbol),
        price: q?.ltp ?? null,
        prevClose: q?.prevClose ?? null,
        changeToday: ret(q?.prevClose ?? null, q?.ltp ?? null),
        changeSinceSeen: dec.adjusted,
        rawSinceSeen: dec.raw,
        watermarkTs,
        watermarkPrice,
        quality: assessment.quality,
        qualityReason: assessment.reason,
        ageMs: assessment.ageMs,
        displayable: assessment.displayable,
        week52High: baseline.week52High,
        week52Low: baseline.week52Low,
        dailyVol: baseline.dailyVol,
        beta: baseline.beta,
        observations: baseline.observations,
        corporateActions: dec.actions.length,
      });
    }

    const windowFrom = anyRealWatermark ? oldestSeen : lastRegularClose(now);
    const absence = describeAbsence(windowFrom, now, !anyRealWatermark);
    const marketReturn = this.oracle.returnBetween(INDEX_SYMBOL, windowFrom, now);

    const qty = new Map(items.map((i) => [i.symbol, i.quantity]));
    const ranked = rank({
      signals,
      policy,
      lastShownAt: store.lastShownMap(this.db, userId),
      now,
      marketReturn,
      marketSymbol: INDEX_SYMBOL,
      marketLabel: INDEX_LABEL,
      // A move in something you actually hold outranks the same move in
      // something you are only curious about. Capped, so one large position
      // cannot monopolise the digest.
      weightOf: (s) => {
        const q = qty.get(s);
        return q && q > 0 ? Math.min(1.5, 1 + Math.log10(1 + q) / 6) : 1;
      },
    });

    const digest = buildDigest({
      now,
      absence,
      cards: ranked.surfaced,
      suppressed: ranked.suppressed,
      market: ranked.market,
      coverage: {
        symbolsWatched: items.length,
        evaluated: items.length - unavailable,
        degraded,
        unavailable,
      },
    });

    const paths: Record<string, PathPoint[]> = {};
    const narratives: Record<string, ReturnType<typeof narrate>> = {};
    for (const c of ranked.surfaced) {
      const p = this.oracle.pathBetween(c.symbol, c.windowFrom, c.windowTo);
      paths[c.symbol] = p;
      if (digest.mode === "NARRATIVE") narratives[c.symbol] = narrate(p);
    }

    return {
      digest,
      rows,
      paths,
      narratives,
      session: {
        ...session,
        unexpectedlyQuiet: detectUnexpectedlyQuiet(session, freshest, now),
      },
      sessionBands: sessionBands(windowFrom, now),
      policy,
    };
  }

  /**
   * Compute, then record. The write path.
   *
   * Events are the durable record of what the system decided; whether this user
   * has been shown them is tracked separately in `event_reads`, and only
   * advances when the client acknowledges.
   */
  buildDigestFor(userId: string): DigestResponse {
    const result = this.computeDigest(userId);
    const now = this.clock.now();
    for (const c of result.digest.cards) {
      store.recordEvent(this.db, {
        user_id: userId,
        symbol: c.symbol,
        kind: c.kind,
        dedupe_key: c.dedupeKey,
        window_from: c.windowFrom,
        window_to: c.windowTo,
        strength: c.strength,
        payload: JSON.stringify(c),
        created_at: now,
      });
    }
    return result;
  }

  /**
   * Acknowledge that a user has seen the current state of these symbols.
   *
   * Separate from reading the digest on purpose. Fetching a page is not the
   * same as a person having looked at it: a background refresh, a preload, or a
   * tab restored on a phone in a pocket would all silently swallow news if the
   * read itself advanced the watermark.
   */
  acknowledge(userId: string, symbols: string[], device: string): { advanced: string[]; alreadyAhead: string[] } {
    const now = this.clock.now();
    const advanced: string[] = [];
    const alreadyAhead: string[] = [];
    for (const symbol of symbols) {
      const q = this.quotes.get(symbol);
      // Acknowledge at the later of the last trade and now.
      //
      // Using the exchange timestamp alone looks more principled and is wrong:
      // a watchlist entry is seeded with a watermark at wall-clock time, every
      // exchange timestamp is older than that by construction, and the
      // monotonic guard then rejects the write. The result was that the primary
      // interaction in the product -- the button that says you have looked at
      // this -- silently did nothing on the first click, and did nothing at all
      // while the market was shut, which is when the app is most often opened.
      const seenTs = Math.max(q?.exchangeTs ?? 0, now);
      const ok = store.advanceWatermark(this.db, userId, symbol, seenTs, q?.ltp ?? null, device, now);
      (ok ? advanced : alreadyAhead).push(symbol);
    }
    const keys = store
      .recentEvents(this.db, userId, 200)
      .filter((e) => symbols.includes(e.symbol))
      .map((e) => e.dedupe_key);
    if (keys.length) store.markShown(this.db, userId, keys, now);
    return { advanced, alreadyAhead };
  }

  /**
   * Drop the hot quotes when the lab moves the clock backwards.
   *
   * The store rejects any print older than the one it holds, which is correct
   * for a real feed and exactly wrong for time travel: after a rewind every
   * cached quote carries an exchange timestamp in the future, and the quality
   * layer dutifully reports clock skew across the whole watchlist. Rather than
   * weaken the monotonic guard — which exists precisely so a re-delivered old
   * print cannot walk a price backwards — the lab discards the cache and lets
   * it refill from the new position. Time only runs backwards here.
   */
  rewindQuotesIfClockWentBack(previousNow: number): void {
    if (this.clock.now() < previousNow - 1000) this.quotes.clear();
  }

  setFault(f: Fault): void {
    this.replay?.setFault(f);
  }

  currentFault(): Fault {
    return this.replay?.currentFault() ?? NO_FAULT;
  }

  status() {
    const now = this.clock.now();
    return {
      mode: this.mode,
      now,
      clock: this.clock.state(),
      session: sessionAt(now),
      ingest: this.worker.stats(),
      replay: this.replay?.hasData()
        ? { from: this.replay.from, to: this.replay.to, symbols: this.replay.symbolsAvailable().length }
        : null,
      fault: this.currentFault(),
      universe: this.history.size,
      baselines: this.baselines.size,
      adjustmentMismatches: this.adjustmentMismatches,
    };
  }

  close(): void {
    this.worker.stop();
    this.db.close();
  }
}

export { store };
export type { Clock, RankedSignal, Suppressed, MarketContext };
