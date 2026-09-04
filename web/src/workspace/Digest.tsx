/**
 * The digest. The product.
 *
 * Everything else in the workspace exists to make this page checkable; this is
 * the page a person would actually open.
 */
import { Ruler, Spark } from "../Chart.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { Link } from "../router.js";
import { evidenceValue, humanKey, money, pct, stamp } from "../format.js";
import { AccountPicker, api, useWorkspace } from "./data.js";
import { Empty, Shell, Stat } from "./Shell.js";
import type { Card, DigestResponse, Row } from "../types.js";

const POLICIES = ["signal", "balanced", "everything"] as const;
const DEVICE = `web-${Math.random().toString(36).slice(2, 7)}`;

export function DigestPage() {
  const { user, data, error, refresh } = useWorkspace();

  const setPolicy = async (policy: string) => {
    await api(`/policy?user=${encodeURIComponent(user)}`, {
      method: "PUT",
      body: JSON.stringify({ policy }),
    });
    await refresh();
  };

  /**
   * Acknowledgement is explicit, and separate from rendering.
   *
   * Fetching this page marks nothing as seen: a background refresh, a preload,
   * or a phone restoring a tab in a pocket would otherwise consume news nobody
   * read. This button is the moment a person says they have looked.
   */
  const acknowledge = async () => {
    const symbols = data?.rows.map((r) => r.symbol) ?? [];
    if (symbols.length === 0) return;
    await api(`/ack?user=${encodeURIComponent(user)}`, {
      method: "POST",
      body: JSON.stringify({ symbols, device: DEVICE }),
    });
    await refresh();
  };

  if (!data) {
    return (
      <Shell title="Digest" lede="What meaningfully changed since you last looked.">
        <p className="loading">{error ? `Could not reach the server. ${error}` : "Reading the market…"}</p>
      </Shell>
    );
  }

  const { digest, session, sessionBands, policy } = data;
  const idx = POLICIES.indexOf(policy.name as (typeof POLICIES)[number]);
  const surfaced = new Set(digest.cards.map((c) => c.symbol));

  // Held back and quiet are different outcomes, and the footer used to report
  // the same symbols as both: `quiet` was everything without a card, which
  // includes every row already counted in the suppression ledger. On the seeded
  // demo account that rendered "held back 13" beside "checked and quiet 13" on
  // a list of fifteen -- twenty-six outcomes for fifteen symbols. A symbol the
  // system considered and refused is not a symbol it had nothing to say about.
  const held = new Set(digest.suppressed.items.map((r) => r.symbol));
  const quiet = data.rows.filter((r) => !surfaced.has(r.symbol) && !held.has(r.symbol));
  const bySymbol = new Map(data.rows.map((r) => [r.symbol, r]));

  return (
    <Shell
      title="Digest"
      lede="What meaningfully changed since you last looked."
      session={session}
      actions={
        <>
          <AccountPicker />
          <label className="knob">
            Signal
            <input
              type="range"
              min={0}
              max={2}
              step={1}
              value={idx < 0 ? 1 : idx}
              onChange={(e) => setPolicy(POLICIES[Number(e.target.value)]!)}
              aria-label="How much to surface: from signal only, to everything"
            />
            Everything
          </label>
          <button className="btn" onClick={acknowledge}>
            Mark all as seen
          </button>
        </>
      }
    >
      <section className="dg-head">
        <h2 className="dg-headline">{digest.headline}</h2>
        <p className="dg-sub">{digest.subhead}</p>

        {session.unexpectedlyQuiet && (
          <p className="notice is-attn">
            The clock says the market is open, but nothing on your list has printed a trade in a
            while. Either today is a holiday this build does not know about, or our feed is down.
            Prices below are the last we are sure of.
          </p>
        )}

        <ErrorBoundary label="absence ruler">
          <Ruler from={digest.absence.fromTs} to={digest.absence.toTs} bands={sessionBands} />
        </ErrorBoundary>
      </section>

      {digest.market && (
        <p className="notice">
          <strong>
            {digest.market.label} {pct(digest.market.return)}.
          </strong>{" "}
          {digest.market.explain}.
        </p>
      )}

      <section className="cards">
        {digest.cards.length === 0 && (
          <Empty title="Nothing crossed the bar">
            Every symbol on this list moved inside its own normal range. That is a real answer, and
            most watchlists cannot give it — they have no notion of what normal looks like for a
            given stock, so they show the same numbers whether or not anything happened.
          </Empty>
        )}
        {digest.cards.map((c, i) => (
          <ErrorBoundary key={c.dedupeKey} label={c.symbol}>
            <CardView
              card={c}
              row={bySymbol.get(c.symbol)}
              path={data.paths[c.symbol] ?? []}
              narrative={data.narratives[c.symbol]}
              from={digest.absence.fromTs}
              to={digest.absence.toTs}
              bands={sessionBands}
              index={i}
            />
          </ErrorBoundary>
        ))}
      </section>

      <div className="dg-foot">
        <Stat
          label="Held back"
          value={digest.suppressed.count}
          note={
            digest.suppressed.count > 0 ? (
              <Link to="/watch/held-back">see why</Link>
            ) : (
              "nothing was suppressed this window"
            )
          }
        />
        <Stat
          label="Checked and quiet"
          value={quiet.length}
          note={<Link to="/watch/all">see the full list</Link>}
        />
        <Stat
          label="Window"
          value={digest.absence.label}
          note={`${stamp(digest.absence.fromTs)} → ${stamp(digest.absence.toTs)} IST`}
        />
        <Stat
          label="Coverage"
          value={`${digest.coverage.evaluated}/${digest.coverage.symbolsWatched}`}
          note={
            digest.coverage.unavailable + digest.coverage.degraded > 0
              ? `${digest.coverage.unavailable} unavailable · ${digest.coverage.degraded} degraded`
              : "every symbol evaluated"
          }
        />
      </div>

      {error && <p className="notice is-attn">{error}</p>}
    </Shell>
  );
}

export function CardView({
  card,
  row,
  path,
  narrative,
  from,
  to,
  bands,
  index,
}: {
  card: Card;
  row?: Row;
  path: { ts: number; price: number }[];
  narrative?: DigestResponse["narratives"][string];
  from: number;
  to: number;
  bands: { from: number; to: number }[];
  index: number;
}) {
  const change = row?.changeSinceSeen ?? null;
  const showsPct = card.kind === "MOVE" || card.kind === "CIRCUIT";

  return (
    <article className="card" data-dir={card.direction} style={{ animationDelay: `${index * 55}ms` }}>
      <div>
        <div className="card-head">
          <span className="ticker">{card.symbol}</span>
          {/* Providers sometimes return the ticker as the display name. Printing
              it twice reads as a rendering fault rather than as data. */}
          <span className="company">{row && row.name !== row.symbol ? row.name : ""}</span>
          {showsPct && change != null ? (
            <span className="delta">{pct(change)}</span>
          ) : (
            <span className="kindtag">{card.kind.replace(/_/g, " ").toLowerCase()}</span>
          )}
        </div>

        <p className="because">{card.because}</p>

        {row && row.price != null && (
          <p className="price-line">
            <b>₹{money(row.price)}</b>
            {row.watermarkPrice != null && <> · you last saw ₹{money(row.watermarkPrice)}</>}
            {row.quality !== "LIVE" && (
              <>
                {" "}
                ·{" "}
                <span className="badge" data-q={row.quality}>
                  {row.quality.toLowerCase()}
                </span>
              </>
            )}
          </p>
        )}

        {narrative && narrative.maxDrawdown != null && Math.abs(narrative.maxDrawdown) > 0.02 && (
          <p className="price-line">
            Inside your window it was down as much as {pct(narrative.maxDrawdown)} before it got here
            {narrative.biggestSession && (
              <>
                {" "}
                · worst session {pct(narrative.biggestSession.ret)} on{" "}
                <span className="nowrap">{narrative.biggestSession.date}</span>
              </>
            )}
          </p>
        )}
      </div>

      <Spark
        points={path}
        from={from}
        to={to}
        bands={bands}
        direction={card.direction}
        anchorPrice={row?.watermarkPrice ?? null}
      />

      <details className="why">
        <summary>Why this surfaced</summary>
        <dl className="evidence">
          {Object.entries(card.evidence).map(([k, v]) => (
            <div key={k}>
              <dt>{humanKey(k)}</dt>
              <dd>{evidenceValue(v)}</dd>
            </div>
          ))}
          <div>
            <dt>Rank score</dt>
            <dd>{card.score}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}
