/** Mirrors the server's response shapes. Kept hand-written and small on
 *  purpose: a generated client would be more machinery than this earns. */

export type Direction = "UP" | "DOWN" | "NEUTRAL";

export interface Card {
  symbol: string;
  kind: string;
  direction: Direction;
  strength: number;
  headline: string;
  because: string;
  evidence: Record<string, number | string | boolean | null>;
  windowFrom: number;
  windowTo: number;
  dedupeKey: string;
  score: number;
  rank: number;
}

export interface Suppressed {
  symbol: string;
  kind: string;
  reason: string;
  explain: string;
  strength: number;
}

export interface MarketContext {
  symbol: string;
  label: string;
  return: number;
  collapsed: number;
  explain: string;
}

export interface Absence {
  fromTs: number;
  toTs: number;
  ms: number;
  sessions: number;
  label: string;
  isFirstVisit: boolean;
}

export interface Digest {
  generatedAt: number;
  mode: "GLANCE" | "SESSION" | "NARRATIVE";
  absence: Absence;
  headline: string;
  subhead: string;
  market: MarketContext | null;
  cards: Card[];
  suppressed: { count: number; byReason: Record<string, number>; items: Suppressed[] };
  coverage: { symbolsWatched: number; evaluated: number; degraded: number; unavailable: number };
}

export interface Row {
  symbol: string;
  name: string;
  price: number | null;
  prevClose: number | null;
  changeToday: number | null;
  changeSinceSeen: number | null;
  rawSinceSeen: number | null;
  watermarkTs: number;
  watermarkPrice: number | null;
  quality: string;
  qualityReason: string;
  ageMs: number | null;
  displayable: boolean;
  week52High: number | null;
  week52Low: number | null;
  dailyVol: number | null;
  beta: number | null;
  observations: number;
  corporateActions: number;
}

export interface PathPoint {
  ts: number;
  price: number;
}

export interface Narrative {
  netReturn: number | null;
  maxDrawdown: number | null;
  biggestSession: { date: string; ret: number } | null;
  roundTripped: boolean;
}

export interface DigestResponse {
  digest: Digest;
  rows: Row[];
  paths: Record<string, PathPoint[]>;
  narratives: Record<string, Narrative>;
  session: { session: string; isLive: boolean; unexpectedlyQuiet: boolean; tradingDate: string };
  sessionBands: { from: number; to: number }[];
  policy: { name: string; moveZ: number; maxCards: number; minAbsMove: number };
}

export interface LabState {
  clock: { now: number; speed: number; paused: boolean; offsetMs: number };
  replay: { from: number; to: number; symbols: string[] } | null;
  fault: { kind: string; symbol: string | null; since?: number };
  faultKinds: Record<string, string>;
}
