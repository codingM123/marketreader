/**
 * Quote quality classification.
 *
 * Most watchlists have two states: a number, or a spinner. That is not enough
 * to be honest with a user. "This price is 20 minutes old" has at least four
 * distinct causes, and each one demands a different thing on screen:
 *
 *   - the market is closed              -> the old price is the RIGHT answer
 *   - this stock simply has not traded  -> the price is real, the stock is thin
 *   - our feed has fallen over          -> we do not know the price
 *   - the value itself is impossible    -> we know the price is WRONG
 *
 * Collapsing these into one "stale" badge is how a product ends up either
 * crying wolf every evening or hiding a real outage. The taxonomy below is the
 * single most load-bearing piece of the resilience story.
 */
import type { Paise } from "./money.js";
import type { SessionState } from "./calendar.js";

export type Quality =
  | "LIVE"        // fresh, market open, trading normally
  | "DELAYED"     // older than the source's cadence, still plausible
  | "ILLIQUID"    // this symbol has not printed; the feed itself is healthy
  | "STALE"       // the feed is not delivering; we do not trust this number
  | "CLOSED"      // market shut; last close is correct, not stale
  | "SUSPECT"     // value fails a sanity or circuit-band check
  | "UNAVAILABLE"; // no quote at all (delisted, renamed, never fetched)

export interface QuoteLike {
  symbol: string;
  ltp: Paise | null;
  prevClose: Paise | null;
  /** Exchange-stamped time of the last trade. Never our own clock. */
  exchangeTs: number | null;
  ingestTs: number | null;
}

export interface Assessment {
  quality: Quality;
  /** Age of the last trade print, in ms. Null when unavailable. */
  ageMs: number | null;
  /** Human-readable justification. Rendered in the UI, not just logged. */
  reason: string;
  /** True when the number may be shown as a current price. */
  displayable: boolean;
  /** True when this quote may drive change detection. */
  usableForSignals: boolean;
}

export interface QualityInputs {
  now: number;
  /**
   * Set when the provider explicitly declined to return this symbol, with the
   * reason it gave. Distinct from "we have not seen a print": the provider is
   * telling us something, and inferring the same conclusion from silence would
   * take longer and be less certain.
   */
  providerFailure?: { since: number; reason: string } | null;
  session: SessionState;
  /** How often the provider claims to refresh, in ms. */
  cadenceMs: number;
  /**
   * Freshest exchange timestamp seen across the whole universe. Lets us tell an
   * untraded stock apart from a dead feed — the single distinction that stops
   * illiquid smallcaps from looking like an outage every afternoon.
   */
  universeFreshestTs: number | null;
  /** Sanity band as a fraction. Values beyond it are not prices. See SANITY_BAND. */
  circuitBand: number;
}

/**
 * Two different bands, for two different questions.
 *
 * SANITY_BAND asks "is this a price at all". It is deliberately far wider than
 * any regulatory band, because real Indian equities do move past 20% in a
 * session: Adani Enterprises fell 28% during the January 2023 short-seller
 * report, and stocks in the F&O segment have no fixed band at all. Rejecting
 * those as corrupt would be worse than useless, since the whole point of a
 * watchlist is to be right on the day something actually happens. Anything past
 * 50% is either bad data or a structural event, and detect() has better
 * language for the latter than "suspect".
 *
 * DEFAULT_CIRCUIT_BAND is the regulatory band, used to notice that a scrip is
 * locked at its limit, which is a fact about tradability rather than about
 * price. In production this comes per-scrip from the exchange's daily band
 * file; 20% is the most permissive of the standard tiers.
 */
export const SANITY_BAND = 0.95;
export const DEFAULT_CIRCUIT_BAND = 0.2;
/** Indices have no scrip-level band; market-wide halts trigger at 10/15/20%. */
export const INDEX_CIRCUIT_BAND = 0.25;

export function assess(q: QuoteLike, io: QualityInputs): Assessment {
  const none = (reason: string): Assessment => ({
    quality: "UNAVAILABLE", ageMs: null, reason, displayable: false, usableForSignals: false,
  });

  if (q.ltp == null || q.exchangeTs == null) {
    return none(io.providerFailure?.reason ?? "no quote received for this symbol");
  }

  // The provider is actively refusing this symbol while serving others. That is
  // a lifecycle fact -- a rename, a suspension, a delisting -- not a quiet
  // market, and the last price we hold is of unknown vintage.
  //
  // Deliberately not gated on the market being open. It was, and that made a
  // delisted symbol produce ordinary price cards off a stale quote for the
  // three quarters of the week the exchange is shut -- which is also when this
  // product is most often opened. A rename does not become less true overnight.
  if (io.providerFailure) {
    const feedHealthy =
      io.universeFreshestTs == null ||
      !io.session.isLive ||
      io.now - io.universeFreshestTs <= io.cadenceMs * 3;
    if (feedHealthy) {
      return {
        quality: "UNAVAILABLE",
        ageMs: Math.max(0, io.now - q.exchangeTs),
        reason: `the provider has stopped returning this symbol (${io.providerFailure.reason}); the last price we hold is from ${fmtAge(io.now - q.exchangeTs)} ago`,
        displayable: false,
        usableForSignals: false,
      };
    }
  }

  // --- Sanity, before anything else. A wrong number is worse than no number. ---
  if (!Number.isFinite(q.ltp) || q.ltp <= 0) {
    return { quality: "SUSPECT", ageMs: null, reason: "non-positive price from provider",
             displayable: false, usableForSignals: false };
  }

  if (q.prevClose != null && q.prevClose > 0) {
    const move = Math.abs(q.ltp - q.prevClose) / q.prevClose;
    if (move > io.circuitBand) {
      // A move outside the band is not possible in a single session. Either a
      // corporate action has not been applied, or the tick is corrupt. Either
      // way it must never become a "+40%!" alert.
      return {
        quality: "SUSPECT",
        ageMs: io.now - q.exchangeTs,
        reason: `quoted at ${(move * 100).toFixed(0)}% away from the previous close — too far to be a price at all, most likely a units or encoding error upstream`,
        displayable: false,
        usableForSignals: false,
      };
    }
  }

  // Clock skew: a trade stamped in the future means our clock or theirs is off.
  // Clamp rather than reporting a negative age, and stop trusting it for signals.
  const rawAge = io.now - q.exchangeTs;
  if (rawAge < -60_000) {
    return { quality: "SUSPECT", ageMs: rawAge,
             reason: "exchange timestamp is in the future — clock skew between provider and server",
             displayable: true, usableForSignals: false };
  }
  const ageMs = Math.max(0, rawAge);

  // --- Market closed: an old price is the correct price. ---
  if (!io.session.isLive) {
    const label =
      io.session.session === "WEEKEND" ? "weekend" :
      io.session.session === "HOLIDAY" ? "trading holiday" :
      io.session.session === "PRE_OPEN" ? "pre-open session" :
      io.session.session === "POST_CLOSE" ? "post-close session" : "market closed";
    return {
      quality: "CLOSED", ageMs,
      reason: `${label} — showing the last traded price from the previous session`,
      displayable: true, usableForSignals: true,
    };
  }

  // --- Market open. Now age actually means something. ---
  if (ageMs <= io.cadenceMs * 2) {
    return { quality: "LIVE", ageMs, reason: "live", displayable: true, usableForSignals: true };
  }
  if (ageMs <= io.cadenceMs * 6) {
    return { quality: "DELAYED", ageMs,
             reason: `last trade ${fmtAge(ageMs)} ago`,
             displayable: true, usableForSignals: true };
  }

  // Is it this symbol, or is it us? If other symbols are printing normally the
  // feed is fine and this scrip is simply thin — a fact about the stock, which
  // the user deserves to know, not an error.
  const feedHealthy =
    io.universeFreshestTs != null && io.now - io.universeFreshestTs <= io.cadenceMs * 3;

  if (feedHealthy) {
    return {
      quality: "ILLIQUID", ageMs,
      reason: `no trade in ${fmtAge(ageMs)} — thinly traded, the feed is healthy`,
      displayable: true,
      // Still usable: an illiquid price is a real price. But detection must use
      // the trade time, not "now", when measuring the change window.
      usableForSignals: true,
    };
  }

  return {
    quality: "STALE", ageMs,
    reason: `market data delayed ${fmtAge(ageMs)} — this price may not be current`,
    displayable: true,      // shown, but visibly degraded
    usableForSignals: false, // never generate an alert off a price we distrust
  };
}

export function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
