/**
 * The four supporting surfaces.
 *
 * Each shows something the server already did and had nowhere to put. The event
 * log and the ingestion status matter most: they carry two arguments this
 * project leans on — an immutable log with read state held separately, and a
 * fan-in design whose cost is bounded by the exchange rather than the user
 * count — and an argument nobody can see is a claim.
 */
import { useEffect, useState } from "react";
import { AddSymbol, RemoveSymbol } from "../AddSymbol.js";
import { age, money, pct, stamp } from "../format.js";
import { AccountPicker, api, useWorkspace } from "./data.js";
import { Empty, Shell, Stat } from "./Shell.js";
import type { Row } from "../types.js";

// ─────────────────────────────────────────────────────────── all symbols ───

export function AllSymbolsPage() {
  const { user, data, error, refresh } = useWorkspace();
  if (!data) {
    return <Loading title="All symbols" lede="The full list, and adding to it." error={error} />;
  }

  const watched = new Set(data.rows.map((r) => r.symbol));

  return (
    <Shell
      title="All symbols"
      lede="Every symbol on this list, whether or not it surfaced. Deliberately colourless: these are the rows the system decided are not worth your attention, and painting them would undo that decision."
      session={data.session}
      actions={<AccountPicker />}
    >
      <div className="table-scroll">
        <table className="rows">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Price</th>
              <th>Since seen</th>
              <th>Today</th>
              <th>σ / day</th>
              <th>Beta</th>
              <th>52-week</th>
              <th>Data</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.symbol}>
                <td title={r.name}>{r.symbol}</td>
                <td>{r.displayable ? money(r.price) : "—"}</td>
                <td>{pct(r.changeSinceSeen)}</td>
                <td>{pct(r.changeToday)}</td>
                <td>{r.dailyVol == null ? "—" : `${(r.dailyVol * 100).toFixed(2)}%`}</td>
                <td>{r.beta == null ? "—" : r.beta.toFixed(2)}</td>
                <td>
                  {r.week52Low == null || r.week52High == null
                    ? "—"
                    : `${money(r.week52Low)} – ${money(r.week52High)}`}
                </td>
                <td>
                  <span className="badge" data-q={r.quality} title={r.qualityReason}>
                    {r.quality === "LIVE" ? `live ${age(r.ageMs)}` : r.quality.toLowerCase()}
                  </span>
                </td>
                <td className="rowaction-cell">
                  <RemoveSymbol user={user} symbol={r.symbol} onChanged={refresh} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="quiet-foot">
        <AddSymbol user={user} watched={watched} onChanged={refresh} />
        <p className="quiet-hint">
          Anything added starts its own window from now. There is no “since” for it yet, so it will
          not be flagged until your next visit — which is the honest answer, not a limitation.
        </p>
      </div>
    </Shell>
  );
}

// ──────────────────────────────────────────────────────────── held back ───

const REASON_COPY: Record<string, string> = {
  COOLDOWN: "Already shown recently. The same event re-detected on every poll is one event.",
  MARKET_WIDE: "Moved with the index. On a red day, twenty cards saying so is one thing said twenty times.",
  WEAKER_THAN_SIBLING: "A second signal about a symbol that already has a stronger one.",
  BELOW_CAP: "Real, but ranked below the cap. Attention is the scarce resource, not screen space.",
  NOTHING_UNUSUAL: "Inside its own normal range.",
};

export function HeldBackPage() {
  const { data, error } = useWorkspace();
  if (!data) {
    return <Loading title="Held back" lede="What was not shown, and why." error={error} />;
  }

  const { suppressed, coverage, cards } = data.digest;
  const quiet = coverage.evaluated - cards.length - suppressed.count;

  return (
    <Shell
      title="Held back"
      lede="Everything the system generated and chose not to show you. Nothing is dropped silently — a watchlist that hides its own decisions cannot be trusted with money."
      session={data.session}
      actions={<AccountPicker />}
    >
      <div className="dg-foot">
        <Stat label="Surfaced" value={cards.length} note="shown on the digest" />
        <Stat label="Suppressed" value={suppressed.count} note="generated, then held back" />
        <Stat
          label="Quiet"
          value={Math.max(0, quiet)}
          note="evaluated and produced nothing at all"
        />
      </div>

      {suppressed.count === 0 ? (
        <Empty title="Nothing was suppressed over this window">
          Every candidate that was generated is on the digest. The {Math.max(0, quiet)} symbols not
          shown produced no signal in the first place — they are counted rather than listed, because
          a list of things that did not happen is not information.
        </Empty>
      ) : (
        <ul className="ledger-list">
          {suppressed.items.map((s, i) => (
            <li key={`${s.symbol}-${s.kind}-${i}`}>
              <code>{s.symbol}</code>
              <div>
                <p className="ledger-kind">
                  <span className="ledger-reason">{s.reason.replace(/_/g, " ").toLowerCase()}</span>
                  <span className="ledger-strength">{s.strength.toFixed(1)}σ · {s.kind.toLowerCase()}</span>
                </p>
                <p>{s.explain}</p>
                {REASON_COPY[s.reason] && <p className="ledger-why">{REASON_COPY[s.reason]}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

// ────────────────────────────────────────────────────────────── history ───

interface EventRow {
  id: number;
  symbol: string;
  kind: string;
  dedupeKey: string;
  windowFrom: number;
  windowTo: number;
  strength: number;
  createdAt: number;
  shownAt: number | null;
  payload: { headline?: string; because?: string };
}

export function HistoryPage() {
  const { user, data } = useWorkspace();
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    setEvents(null);
    setFailed(null);
    void api<{ events: EventRow[] }>(`/events?user=${encodeURIComponent(user)}`)
      .then((r) => setEvents(r.events))
      // An empty array here would render "nothing recorded yet", stating a fact
      // about the user's data on the strength of a network error. On the page
      // whose whole argument is that the log is the record, that is the worst
      // possible thing to get wrong.
      .catch((e) => setFailed(e instanceof Error ? e.message : String(e)));
  }, [user]);

  return (
    <Shell
      title="History"
      lede="Every event this account has ever produced, and whether it was acknowledged. The log is append-only; whether you have seen a row is a separate fact stored separately."
      session={data?.session}
      actions={<AccountPicker />}
    >
      <p className="notice">
        The tempting design is a <code>seen</code> boolean on the event. Once flipped, the fact that
        the event happened at all becomes unrecoverable — so history views and any post-hoc
        debugging of a bad alert become impossible. Events are facts about the market. Whether a
        particular person looked at one is a fact about that person.
      </p>

      {failed ? (
        <p className="lab-fault">
          Could not read the log: {failed}. This is a failure to fetch, not an empty log — the rows
          are still there.
        </p>
      ) : events == null ? (
        <p className="loading">Reading the log…</p>
      ) : events.length === 0 ? (
        <Empty title="Nothing recorded yet">
          Events are written when the digest surfaces something. Open the digest, or use the lab to
          rewind this account’s watermark, and rows will appear here.
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="rows">
            <thead>
              <tr>
                <th>Recorded</th>
                <th>Symbol</th>
                <th>Kind</th>
                <th>Strength</th>
                <th>Window</th>
                <th>Acknowledged</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{stamp(e.createdAt)}</td>
                  <td title={e.payload.because ?? ""}>{e.symbol}</td>
                  <td>{e.kind.replace(/_/g, " ").toLowerCase()}</td>
                  <td>{e.strength.toFixed(2)}</td>
                  <td>{stamp(e.windowFrom)} → {stamp(e.windowTo)}</td>
                  <td>
                    {/* Unacknowledged is the ordinary state, not a warning.
                        Amber means "we cannot tell you" everywhere else in this
                        product, and spending it on every row of a table spends
                        it on nothing. */}
                    {e.shownAt ? stamp(e.shownAt) : <span className="is-quiet">not yet</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────── health ───

interface Status {
  mode: string;
  now: number;
  session: { session: string; isLive: boolean };
  universe: number;
  baselines: number;
  lab: boolean;
  adjustmentMismatches: { symbol: string; declared: string; observed: string }[];
  replay: { from: number; to: number; symbols: number } | null;
  ingest: {
    provider: string;
    cadenceMs: number;
    intervalMs: number;
    cycles: number;
    distinctSymbols: number;
    watchlistRowsAcrossUsers: number;
    fetchesSavedPerCycle: number;
    fanInRatio: number;
    providerHealth: { breaker: string; consecutiveFailures: number; lastError: string | null };
    lastCycle: { durationMs: number; requested: number; accepted: number; failed: number } | null;
    store: {
      symbols: number;
      accepted: number;
      outOfOrder: number;
      duplicates: number;
      invalid: number;
      medianLagMs: number | null;
    };
  };
}

export function SystemPage() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    api<Status>("/status")
      .then((v) => {
        setS(v);
        // Clear on success. Latching the error meant one blip in the five-second
        // poll pinned the page to a failure screen for the rest of the session
        // while fresh data kept arriving behind it.
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  if (!s) return <Loading title="Health" lede="Ingestion, provider, and data checks." error={err} />;

  const i = s.ingest;

  return (
    <Shell
      title="Health"
      lede="What the ingestion worker is actually doing, and whether the data underneath it can be trusted."
      session={s.session}
      wide
    >
      <h3 className="sec-label">Fan-in</h3>
      <p className="notice">
        One fetch per symbol <em>anyone</em> watches, not per symbol per user. There is one current
        price for Reliance whether one person or a million watch it, so cost is bounded by the size
        of the exchange rather than by the user count. The ratio is small here because three seeded
        accounts is a small sample — the gap widens without bound as accounts are added, because the
        numerator grows and the denominator is capped by the exchange.
      </p>
      <div className="dg-foot">
        <Stat label="Fetched per cycle" value={i.distinctSymbols} note="distinct symbols" />
        <Stat
          label="A per-user design would fetch"
          value={i.watchlistRowsAcrossUsers}
          note="watchlist rows across accounts"
        />
        <Stat label="Saved per cycle" value={i.fetchesSavedPerCycle} note={`${i.fanInRatio}× ratio`} />
        <Stat label="Cycles run" value={i.cycles} note={`every ${Math.round(i.intervalMs / 1000)}s`} />
      </div>

      <h3 className="sec-label">Provider</h3>
      <div className="dg-foot">
        <Stat label="Source" value={i.provider} note={`${s.mode} mode`} />
        <Stat
          label="Circuit"
          value={i.providerHealth.breaker.toLowerCase()}
          tone={i.providerHealth.breaker === "CLOSED" ? undefined : "attn"}
          note={i.providerHealth.lastError ?? "no recent errors"}
        />
        <Stat
          label="Last cycle"
          value={i.lastCycle ? `${i.lastCycle.durationMs} ms` : "—"}
          note={
            i.lastCycle
              ? `${i.lastCycle.accepted} accepted · ${i.lastCycle.failed} failed of ${i.lastCycle.requested}`
              : "no cycle yet"
          }
        />
        <Stat
          label="Median lag"
          value={i.store.medianLagMs == null ? "—" : `${Math.round(i.store.medianLagMs / 1000)}s`}
          note="exchange stamp to our receipt"
        />
      </div>

      <h3 className="sec-label">Quote store</h3>
      <p className="notice">
        Ticks never touch disk. Writes are ordered on the <em>exchange</em> timestamp, never on
        arrival — retries and reconnects deliver old prints after new ones, and a store that takes
        the newest write lets a price walk backwards in time. Rejections are counted rather than
        swallowed, because a rising rejection rate is the earliest sign an upstream is misbehaving.
      </p>
      <div className="dg-foot">
        <Stat label="Symbols held" value={i.store.symbols} />
        <Stat label="Accepted" value={i.store.accepted} />
        <Stat
          label="Rejected, out of order"
          value={i.store.outOfOrder}
          tone={i.store.outOfOrder > 0 ? "attn" : undefined}
        />
        <Stat label="Rejected, duplicate" value={i.store.duplicates} note="same print re-delivered" />
      </div>

      <h3 className="sec-label">Data checks</h3>
      {err && <p className="lab-fault">Last refresh failed: {err}. Figures below may be stale.</p>}

      {s.adjustmentMismatches.length === 0 ? (
        <p className="notice">
          <strong>Price-adjustment semantics agree with the data</strong> for every symbol carrying a
          split to test against. This check exists because the most expensive bug in this project was
          silent: the provider back-adjusts closes for splits and does not say so, and applying our
          own adjustment on top fabricated a −90% return that inflated one symbol’s volatility more
          than twentyfold. Nothing threw. It is verified at boot now.
        </p>
      ) : (
        <ul className="ledger-list">
          {s.adjustmentMismatches.map((m) => (
            <li key={m.symbol}>
              <code>{m.symbol}</code>
              <div>
                <p>
                  Provider declares <strong>{m.declared}</strong>, the data shows{" "}
                  <strong>{m.observed}</strong>. Volatility for this symbol is not trustworthy until
                  this is resolved.
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="dg-foot">
        <Stat label="Universe" value={s.universe} note="symbols with history loaded" />
        <Stat label="Baselines" value={s.baselines} note="computed at boot" />
        {s.replay && (
          <Stat
            label="Recording"
            value={`${Math.round((s.replay.to - s.replay.from) / 60000)} min`}
            note={`${stamp(s.replay.from)} → ${stamp(s.replay.to)} IST`}
          />
        )}
        <Stat label="Clock" value={stamp(s.now)} note={`${s.session.session.toLowerCase()} · IST`} />
      </div>
    </Shell>
  );
}

function Loading({ title, lede, error }: { title: string; lede: string; error?: string | null }) {
  return (
    <Shell title={title} lede={lede}>
      {error ? (
        <p className="lab-fault">Could not reach the server: {error}</p>
      ) : (
        <p className="loading">Reading…</p>
      )}
    </Shell>
  );
}
