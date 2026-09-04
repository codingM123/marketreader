/**
 * NSE trading calendar and session state.
 *
 * "Stale" only means something relative to whether the market is supposed to be
 * moving. A quote from 18 hours ago is *correct* at 6am on a Sunday and a
 * *fault* at 11am on a Tuesday. Every freshness decision in this system routes
 * through here.
 *
 * Timezone: IST is UTC+05:30 year-round with no DST, so a fixed offset is
 * exact, not an approximation. We store every timestamp as a UTC epoch and
 * convert only at the boundaries where market semantics apply.
 */

export const IST_OFFSET_MIN = 330;

export type Session =
  | "PRE_OPEN"    // 09:00-09:15 order collection, indicative prices only
  | "REGULAR"     // 09:15-15:30 continuous trading
  | "POST_CLOSE"  // 15:40-16:00 closing-price session
  | "CLOSED"      // trading day, outside hours
  | "WEEKEND"
  | "HOLIDAY";

export interface SessionState {
  session: Session;
  /** True only when prices are expected to be actively changing. */
  isLive: boolean;
  /** ISO date (IST) of the session this timestamp belongs to. */
  tradingDate: string;
  /** Epoch ms of the most recent regular-session close at or before `at`. */
  lastCloseTs: number;
}

/** Minutes since IST midnight. */
function istMinutes(utcMs: number): number {
  const d = new Date(utcMs + IST_OFFSET_MIN * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** YYYY-MM-DD in IST. */
export function istDate(utcMs: number): string {
  return new Date(utcMs + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** 0=Sun .. 6=Sat, in IST. */
function istDay(utcMs: number): number {
  return new Date(utcMs + IST_OFFSET_MIN * 60_000).getUTCDay();
}

/** Epoch ms for a given IST date + minutes-since-midnight. */
export function istAt(dateISO: string, minutes: number): number {
  return Date.parse(dateISO + "T00:00:00Z") + minutes * 60_000 - IST_OFFSET_MIN * 60_000;
}

const PRE_OPEN_START = 9 * 60;       // 09:00
const OPEN = 9 * 60 + 15;            // 09:15
const CLOSE = 15 * 60 + 30;          // 15:30
const POST_START = 15 * 60 + 40;     // 15:40
const POST_END = 16 * 60;            // 16:00

/**
 * Trading holidays, as IST dates.
 *
 * This list is *data*, not logic — it is seeded from the exchange's published
 * annual circular and is expected to be re-synced, because several Indian
 * market holidays move with the lunar calendar and are only confirmed a few
 * months ahead. `unverifiedAfter` marks the point past which this build should
 * not be trusted to know the calendar; beyond it we fall back to the runtime
 * quiet-market detector below rather than asserting a wrong answer.
 */
export const HOLIDAYS = new Set<string>([
  // 2025
  "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14",
  "2025-04-18", "2025-05-01", "2025-08-15", "2025-08-27", "2025-10-02",
  "2025-10-21", "2025-10-22", "2025-11-05", "2025-12-25",
  // 2026 — fixed-date holidays only. Lunar-calendar dates intentionally absent.
  "2026-01-26", "2026-04-03", "2026-04-14", "2026-05-01", "2026-08-15",
  "2026-10-02", "2026-12-25",
]);

/**
 * The last date this holiday list is complete for.
 *
 * This said 2026-12-31, which was the wrong end of the problem: the 2026
 * entries are fixed-date holidays only, by the deliberate choice recorded
 * above, so the list is knowingly incomplete for all of 2026 -- Ganesh
 * Chaturthi, Diwali and the rest are missing -- and a horizon set past them
 * meant the check could never fire for the gap it exists to describe. 2025 is
 * the last year genuinely covered.
 */
export const CALENDAR_VERIFIED_UNTIL = "2025-12-31";

/**
 * Whether the holiday list can be trusted for this date.
 *
 * Stating a verified horizon and then never reading it is worse than not having
 * one, because it reads like a safeguard. Callers past the horizon should treat
 * a "trading day" answer as a guess and lean on the runtime quiet-market
 * detector below instead.
 */
export function calendarIsVerified(utcMs: number): boolean {
  return istDate(utcMs) <= CALENDAR_VERIFIED_UNTIL;
}

export function isTradingDay(utcMs: number): boolean {
  const d = istDay(utcMs);
  if (d === 0 || d === 6) return false;
  return !HOLIDAYS.has(istDate(utcMs));
}

export function sessionAt(utcMs: number): SessionState {
  const date = istDate(utcMs);
  const day = istDay(utcMs);
  const min = istMinutes(utcMs);

  let session: Session;
  if (day === 0 || day === 6) session = "WEEKEND";
  else if (HOLIDAYS.has(date)) session = "HOLIDAY";
  else if (min >= PRE_OPEN_START && min < OPEN) session = "PRE_OPEN";
  else if (min >= OPEN && min < CLOSE) session = "REGULAR";
  else if (min >= POST_START && min < POST_END) session = "POST_CLOSE";
  else session = "CLOSED";

  return {
    session,
    isLive: session === "REGULAR",
    tradingDate: date,
    lastCloseTs: lastRegularClose(utcMs),
  };
}

/** Most recent 15:30 IST close at or before `utcMs`, skipping non-trading days. */
export function lastRegularClose(utcMs: number): number {
  let probe = utcMs;
  for (let i = 0; i < 15; i++) {
    const date = istDate(probe);
    const closeTs = istAt(date, CLOSE);
    if (closeTs <= utcMs && isTradingDay(closeTs)) return closeTs;
    probe -= 24 * 3600_000;
  }
  return utcMs; // pathological: >2 weeks of holidays. Degrade, don't throw.
}

/** Next IST calendar date, as YYYY-MM-DD. */
function nextDate(dateISO: string): string {
  return new Date(Date.parse(dateISO + "T00:00:00Z") + 24 * 3600_000).toISOString().slice(0, 10);
}

/** Minutes in one regular session: 09:15 to 15:30. */
export const SESSION_MINUTES = CLOSE - OPEN; // 375

/**
 * Elapsed *market* minutes between two instants: the intersection of the
 * interval with the regular sessions it spans.
 *
 * Counting whole days and patching up the ends is where this originally went
 * wrong. Friday 16:00 to Monday 09:00 is 65 wall-clock hours, and a day-stepping
 * loop counts Monday as a session that has not happened yet. Intersecting
 * against each day's open/close window instead makes both ends partial by
 * construction, so there is no end case left to get wrong.
 */
export function marketMinutesBetween(fromUtcMs: number, toUtcMs: number): number {
  if (toUtcMs <= fromUtcMs) return 0;
  let total = 0;
  let date = istDate(fromUtcMs);
  const endDate = istDate(toUtcMs);
  for (let i = 0; i < 800; i++) {
    const dayOpen = istAt(date, OPEN);
    if (isTradingDay(dayOpen)) {
      const a = Math.max(fromUtcMs, dayOpen);
      const b = Math.min(toUtcMs, istAt(date, CLOSE));
      if (b > a) total += (b - a) / 60_000;
    }
    if (date === endDate) break;
    date = nextDate(date);
  }
  return total;
}

/**
 * The same quantity in units of full sessions. Elapsed *trading* time.
 */
export function sessionsBetween(fromUtcMs: number, toUtcMs: number): number {
  return marketMinutesBetween(fromUtcMs, toUtcMs) / SESSION_MINUTES;
}

/** The instant this timestamp's trading session closes (15:30 IST). */
export function sessionCloseOf(utcMs: number): number {
  return istAt(istDate(utcMs), CLOSE);
}

/** Number of session opens in the half-open interval (from, to]. */
export function sessionOpensBetween(fromUtcMs: number, toUtcMs: number, maxDays = 800): number {
  if (toUtcMs <= fromUtcMs) return 0;
  let n = 0;
  let date = istDate(fromUtcMs);
  const endDate = istDate(toUtcMs);
  for (let i = 0; i < maxDays; i++) {
    const open = istAt(date, OPEN);
    if (isTradingDay(open) && open > fromUtcMs && open <= toUtcMs) n++;
    if (date === endDate) break;
    date = nextDate(date);
  }
  return n;
}

/**
 * The horizon volatility is scaled over — which is *not* the same as elapsed
 * trading time, and conflating the two was the most expensive bug in this
 * codebase.
 *
 * Baseline volatility is estimated from close-to-close returns. A close-to-close
 * return contains an entire overnight gap plus a full session, and on this
 * universe the gap alone is a median 24% of daily variance. But
 * `sessionsBetween` counts only minutes the market was open, so a user who left
 * at Friday's close and returned at Monday's open has been away for *zero*
 * sessions — while the price in front of them has absorbed a whole weekend of
 * news.
 *
 * Dividing a close-to-close sigma down to that horizon inflates the z-score by
 * up to nineteen times. Measured on the recorded history, 66% of ordinary
 * overnight gaps then cleared two sigma and 10% cleared twelve, which is the
 * threshold at which this system stops reporting a price move and starts
 * telling the user their data is probably broken. A 1.5% gap in Infosys was a
 * seventeen-sigma event.
 *
 * The fix charges the gap what the gap is worth. Measured across all 51 recorded
 * histories, overnight variance is 23.8% of close-to-close variance (that is
 * the median across the 51 shipped histories; pooled is 24.6%, and the
 * per-symbol range runs 14.9% to 49.9%), so a close-to-close return is
 * roughly a quarter gap and three quarters
 * session. Variance is additive, so the horizon is too:
 *
 *     horizon = opens_crossed x 0.24  +  trading_time x 0.76
 *
 * which returns exactly 1.0 for a full close-to-close window, 0.24 for a
 * weekend that ends at Monday's open, and the intraday fraction inside a single
 * session.
 *
 * The first version of this fix took the *maximum* of the two terms, which
 * charged a whole session for a gap worth a quarter of one. That replaced a 19x
 * inflation with a 2x deflation of the same window -- and the paragraph above
 * already contained the number that disproved it. Same error, opposite sign,
 * and it took a second reviewer to notice that the comment and the code
 * disagreed.
 */
export const GAP_VARIANCE_SHARE = 0.238;
export function riskHorizonSessions(fromUtcMs: number, toUtcMs: number): number {
  const elapsed = sessionsBetween(fromUtcMs, toUtcMs);
  const gaps = sessionOpensBetween(fromUtcMs, toUtcMs);
  return gaps * GAP_VARIANCE_SHARE + elapsed * (1 - GAP_VARIANCE_SHARE);
}

/**
 * Runtime backstop for a calendar we cannot fully trust.
 *
 * If the clock says REGULAR but nothing in the entire universe of watched
 * symbols has printed a trade in `quietMs`, the more likely explanations are an
 * unlisted holiday or a total feed outage — not that every stock in India
 * stopped trading. Either way the correct product behaviour is identical: stop
 * claiming the market is live.
 */
export function detectUnexpectedlyQuiet(
  state: SessionState,
  newestExchangeTsAcrossUniverse: number | null,
  now: number,
  quietMs = 15 * 60_000,
): boolean {
  // Past the verified horizon the calendar is a guess, so the runtime check
  // matters more, not less. Deliberately not disabled there.
  if (state.session !== "REGULAR") return false;
  if (newestExchangeTsAcrossUniverse == null) return true;
  return now - newestExchangeTsAcrossUniverse > quietMs;
}

export interface SessionBand {
  from: number;
  to: number;
}

/**
 * The regular-session windows inside a range.
 *
 * Sent to the client so the absence ruler can shade the hours the market was
 * actually open. Computing it in the browser instead would mean a second
 * implementation of the trading calendar, and two calendars that disagree is
 * strictly worse than one that is occasionally wrong: the user would see a
 * chart whose shading contradicts the numbers printed beside it.
 */
export function sessionBands(fromUtcMs: number, toUtcMs: number, maxDays = 400): SessionBand[] {
  const out: SessionBand[] = [];
  if (toUtcMs <= fromUtcMs) return out;
  let date = istDate(fromUtcMs);
  const endDate = istDate(toUtcMs);
  for (let i = 0; i < maxDays; i++) {
    const open = istAt(date, OPEN);
    if (isTradingDay(open)) {
      const a = Math.max(fromUtcMs, open);
      const b = Math.min(toUtcMs, istAt(date, CLOSE));
      if (b > a) out.push({ from: a, to: b });
    }
    if (date === endDate) break;
    date = nextDate(date);
  }
  return out;
}
