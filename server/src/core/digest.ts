/**
 * The digest: what a returning user actually reads.
 *
 * The central idea in this build is that **the granularity of a diff should be
 * a function of how long the user was away.**
 *
 * If you were gone ten minutes, the honest answer is a tick-level delta: three
 * prices moved, here they are. If you were gone a week, the same code path
 * produces a firehose of fourteen hundred price changes, which is technically a
 * complete answer and practically useless. A week's absence needs a different
 * shape of answer entirely: what is the net position, what was the single worst
 * day inside the window, how far did it fall before it recovered, did anything
 * structural happen to the instrument.
 *
 * Most watchlists have exactly one answer shape, usually "% change today", and
 * so they are wrong for every user who is not checking in daily. This module
 * picks the shape first and fills it second.
 */
import type { Paise } from "./money.js";
import { formatPct, ret } from "./money.js";
import { sessionsBetween, istDate } from "./calendar.js";
import type { RankedSignal, Suppressed, MarketContext } from "./rank.js";

export type DigestMode = "GLANCE" | "SESSION" | "NARRATIVE";

export interface Absence {
  fromTs: number;
  toTs: number;
  ms: number;
  sessions: number;
  label: string;
  /** True the very first time a user opens a symbol: there is no "since". */
  isFirstVisit: boolean;
}

/** A price path over the absence window, split-adjusted, oldest first. */
export interface PathPoint {
  ts: number;
  price: Paise;
}

export interface NarrativeFacts {
  netReturn: number | null;
  /** Worst peak-to-trough drop experienced *inside* the window. */
  maxDrawdown: number | null;
  /** The single session that contributed most, either direction. */
  biggestSession: { date: string; ret: number } | null;
  /** True when the round trip hid the journey: ended flat, moved a lot. */
  roundTripped: boolean;
}

export interface Coverage {
  symbolsWatched: number;
  evaluated: number;
  degraded: number;
  unavailable: number;
}

export interface Digest {
  generatedAt: number;
  mode: DigestMode;
  absence: Absence;
  headline: string;
  subhead: string;
  market: MarketContext | null;
  cards: RankedSignal[];
  suppressed: {
    count: number;
    byReason: Record<string, number>;
    items: Suppressed[];
  };
  coverage: Coverage;
}

/**
 * Mode selection. The boundaries are in *trading sessions*, not wall-clock:
 * a Friday-evening to Monday-morning gap is 62 hours but zero sessions, and
 * telling someone "you were away 3 days" when the market never opened would be
 * technically true and actively misleading.
 */
export function pickMode(sessions: number): DigestMode {
  if (sessions < 1) return "GLANCE";
  if (sessions <= 3) return "SESSION";
  return "NARRATIVE";
}

export function describeAbsence(fromTs: number, toTs: number, isFirstVisit: boolean): Absence {
  const ms = Math.max(0, toTs - fromTs);
  const sessions = sessionsBetween(fromTs, toTs);
  return { fromTs, toTs, ms, sessions, label: humanize(ms, sessions), isFirstVisit };
}

function humanize(ms: number, sessions: number): string {
  if (ms < 90_000) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return mins + (mins === 1 ? " minute" : " minutes");
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour" : " hours");
  const days = Math.round(hours / 24);
  const base = days + (days === 1 ? " day" : " days");
  // Surface the distinction between elapsed time and market time explicitly.
  if (sessions < 1) return base + " (the market did not open)";
  const s = Math.floor(sessions);
  if (s > 0 && s !== days) return base + ", " + s + (s === 1 ? " session" : " sessions");
  return base;
}

/**
 * Facts that only make sense once the window is long enough to have a shape.
 *
 * `maxDrawdown` is the one people are most surprised by: a stock that is flat
 * over a week may have been down 9% mid-week. "Nothing changed" is false in a
 * way that matters, and a naive endpoint-to-endpoint diff can never see it.
 */
export function narrate(path: readonly PathPoint[]): NarrativeFacts {
  const empty: NarrativeFacts = {
    netReturn: null,
    maxDrawdown: null,
    biggestSession: null,
    roundTripped: false,
  };
  if (path.length < 2) return empty;

  const first = path[0]!;
  const last = path[path.length - 1]!;
  const netReturn = ret(first.price, last.price);

  let peak = first.price;
  let maxDD = 0;
  for (const p of path) {
    if (p.price > peak) peak = p.price;
    const dd = (p.price - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Largest single-session contribution, measured close to close.
  //
  // The first version measured the move *within* each date, which reads well
  // and is silently wrong for any window longer than a few days: over a long
  // absence the path is one closing price per session, so first and last are
  // the same point and every day scores zero. A user who watched a stock gain
  // 18% over a month was being told its biggest day was -0.13%.
  //
  // Close to close is also what people mean by "the day it moved". Where
  // intraday points exist, the last price of each date is its close.
  const closeByDate = new Map<string, Paise>();
  for (const p of path) closeByDate.set(istDate(p.ts), p.price);
  const dates = [...closeByDate.keys()].sort();

  let biggest: { date: string; ret: number } | null = null;
  for (let i = 1; i < dates.length; i++) {
    const r = ret(closeByDate.get(dates[i - 1]!)!, closeByDate.get(dates[i]!)!);
    if (r == null) continue;
    if (biggest == null || Math.abs(r) > Math.abs(biggest.ret)) biggest = { date: dates[i]!, ret: r };
  }

  const roundTripped =
    netReturn != null && Math.abs(netReturn) < 0.01 && Math.abs(maxDD) > 0.04;

  return { netReturn, maxDrawdown: maxDD === 0 ? null : maxDD, biggestSession: biggest, roundTripped };
}

export interface BuildDigestInput {
  now: number;
  absence: Absence;
  cards: RankedSignal[];
  suppressed: Suppressed[];
  market: MarketContext | null;
  coverage: Coverage;
}

export function buildDigest(i: BuildDigestInput): Digest {
  const mode = pickMode(i.absence.sessions);

  // On a first visit there is no "since", so nothing can have changed since it.
  // The headline said as much while the cards below it said otherwise, which is
  // the worst of both: a screen that contradicts itself in its first two lines.
  // Data-quality and lifecycle findings are not changes either -- a symbol the
  // provider will not return is a fact about the list, and it belongs in the
  // table with the rest of the list until there is a window to compare against.
  const cards = i.absence.isFirstVisit ? [] : i.cards;
  const n = cards.length;

  const byReason: Record<string, number> = {};
  for (const s of i.suppressed) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;

  let headline: string;
  let subhead: string;

  if (i.coverage.symbolsWatched === 0) {
    // Distinct from a first visit. "No watermark yet" and "no symbols yet" are
    // different states with different next actions, and collapsing them left an
    // empty account being told about baselines it has nothing to compute.
    headline = "Your watchlist is empty";
    subhead =
      "Add a symbol and it starts its own window from that moment. There is no 'since' for it until your next visit, which is the honest answer rather than a limitation.";
  } else if (i.absence.isFirstVisit) {
    headline = "Starting your baseline";
    subhead =
      "Nothing is flagged on a first visit. There is no 'since' yet, so anything we showed you now would be noise dressed up as news. From your next visit, changes are measured against this moment.";
  } else if (n === 0) {
    // Saying nothing happened, confidently, is a feature. Most watchlists
    // cannot do it: they have no notion of "normal", so they show the same
    // numbers whether or not anything occurred, and the user has to decide.
    headline =
      i.absence.label === "just now"
        ? "Nothing new since you looked"
        : "Nothing meaningful in " + i.absence.label;
    subhead =
      i.coverage.evaluated +
      " symbols checked. Every one of them moved inside its own normal range" +
      (i.market ? ", and the index was " + formatPct(i.market.return) : "") +
      ".";
  } else {
    headline =
      "You were away " + i.absence.label + ". " + n + (n === 1 ? " thing" : " things") + " worth your attention.";
    const quiet = i.coverage.evaluated - n;
    subhead =
      mode === "NARRATIVE"
        ? "Summarised across " +
          Math.floor(i.absence.sessions) +
          " sessions rather than replayed tick by tick."
        : quiet > 0
          ? quiet + " other " + (quiet === 1 ? "symbol" : "symbols") + " checked and nothing unusual."
          : "";
  }

  if (i.coverage.degraded > 0) {
    subhead +=
      (subhead ? " " : "") +
      i.coverage.degraded +
      " " +
      (i.coverage.degraded === 1 ? "symbol has" : "symbols have") +
      " degraded data and were excluded from detection.";
  }

  return {
    generatedAt: i.now,
    mode,
    absence: i.absence,
    headline,
    subhead,
    market: i.market,
    cards,
    suppressed: { count: i.suppressed.length, byReason, items: i.suppressed },
    coverage: i.coverage,
  };
}
