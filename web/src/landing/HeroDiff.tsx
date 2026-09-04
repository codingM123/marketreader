/**
 * The hero, and the whole argument in one control.
 *
 * A landing page for this product could open with a number and a gradient. It
 * would be the template answer and it would be describing the thesis rather
 * than showing it, which is a problem here specifically: the claim is that the
 * *same market at the same instant* should produce a different answer depending
 * on when you last looked, and that is not something a static image can carry.
 *
 * So the hero is one slider. Drag it, and the digest below rewrites itself from
 * genuinely recorded NSE prices — an hour's absence surfaces a five-sigma move,
 * a three-month absence surfaces dividends that exist only because the window is
 * long enough to contain their ex-dates, and a ten-minute absence collapses to
 * almost nothing, which is a real answer most watchlists cannot give. Nothing
 * is mocked: it
 * calls `/api/preview`, which computes a digest and writes nothing, so nobody's
 * watermark moves because a stranger dragged a control.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { money, pct, stamp } from "../format.js";
import type { DigestResponse } from "../types.js";

const MINUTE = 60_000;
const DAY = 24 * 3600_000;

/** Discrete stops, because each is a unit a person actually thinks in. */
const STOPS: { label: string; short: string; ms: number }[] = [
  { label: "ten minutes", short: "10 min", ms: 10 * MINUTE },
  { label: "an hour", short: "1 hr", ms: 60 * MINUTE },
  { label: "a day", short: "1 day", ms: DAY },
  { label: "three days", short: "3 days", ms: 3 * DAY },
  { label: "a week", short: "1 wk", ms: 7 * DAY },
  { label: "a month", short: "1 mo", ms: 30 * DAY },
  { label: "three months", short: "3 mo", ms: 90 * DAY },
];

/**
 * What each mode means, phrased as what this panel is doing rather than as a
 * promise. The NARRATIVE note used to advertise a drawdown summary the hero
 * never rendered; it renders one now, and only says so when there is one.
 */
const MODE_NOTE: Record<string, string> = {
  GLANCE: "Inside a single session, so the comparison is tick against tick.",
  SESSION: "A few sessions. Still short enough to list what moved.",
  NARRATIVE: "Too long to replay, so it is summarised rather than listed.",
};

export function HeroDiff() {
  const [idx, setIdx] = useState(4); // a week
  const [data, setData] = useState<DigestResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const stop = STOPS[idx]!;

  useEffect(() => {
    const mine = ++seq.current;
    setPending(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/preview?user=demo&awayMs=${stop.ms}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as DigestResponse;
        if (seq.current !== mine) return;
        setData(body);
        setFailed(false);
      } catch {
        if (seq.current === mine) setFailed(true);
      } finally {
        if (seq.current === mine) setPending(false);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [stop.ms]);

  const cards = data?.digest.cards ?? [];
  const quiet = useMemo(() => {
    if (!data) return 0;
    const surfaced = new Set(cards.map((c) => c.symbol));
    return data.rows.filter((r) => !surfaced.has(r.symbol)).length;
  }, [data, cards]);

  return (
    <div className="hero-diff">
      <div className="hero-control">
        <label htmlFor="away">
          <span className="hero-control-lede">You last looked</span>
          <strong>{stop.label}</strong>
          <span className="hero-control-lede">ago.</span>
        </label>
        <input
          id="away"
          type="range"
          min={0}
          max={STOPS.length - 1}
          step={1}
          value={idx}
          onChange={(e) => setIdx(Number(e.target.value))}
          aria-valuetext={stop.label}
        />
        <div className="hero-ticks">
          {STOPS.map((s, i) => (
            <button
              key={s.short}
              type="button"
              data-on={i === idx}
              aria-pressed={i === idx}
              aria-label={`Set the absence to ${s.label}`}
              onClick={() => setIdx(i)}
            >
              {s.short}
            </button>
          ))}
        </div>
      </div>

      <div className={"hero-panel" + (pending ? " is-pending" : "")} aria-live="polite">
        {failed ? (
          <p className="hero-empty">
            The demo server is not running. Start it with <code>npm run serve</code> and this panel
            fills itself from the recorded session.
          </p>
        ) : !data ? (
          <p className="hero-empty">Reading the recorded session…</p>
        ) : (
          <>
            <div className="hero-panel-head">
              <p className="hero-headline">{data.digest.headline}</p>
              <p className="hero-sub">
                {MODE_NOTE[data.digest.mode]}{" "}
                <span className="hero-window">
                  {stamp(data.digest.absence.fromTs)} → {stamp(data.digest.absence.toTs)} IST
                </span>
              </p>
            </div>

            <ul className="hero-cards">
              {cards.slice(0, 4).map((c) => {
                const row = data.rows.find((r) => r.symbol === c.symbol);
                return (
                  <li key={c.dedupeKey} data-dir={c.direction}>
                    <div className="hero-card-top">
                      <code>{c.symbol}</code>
                      {c.kind === "MOVE" && row?.changeSinceSeen != null ? (
                        <span className="hero-delta">{pct(row.changeSinceSeen)}</span>
                      ) : (
                        <span className="hero-kind">{c.kind.replace(/_/g, " ").toLowerCase()}</span>
                      )}
                    </div>
                    <p>{c.because}</p>
                    {(() => {
                      const n = data.narratives[c.symbol];
                      if (!n || n.maxDrawdown == null || Math.abs(n.maxDrawdown) < 0.02) return null;
                      return (
                        <p className="hero-price">
                          down as much as {pct(n.maxDrawdown)} inside your window
                          {n.biggestSession && <> · worst session {pct(n.biggestSession.ret)}</>}
                        </p>
                      );
                    })()}
                    {row?.price != null && (
                      <p className="hero-price">
                        ₹{money(row.price)}
                        {row.watermarkPrice != null && <> · you last saw ₹{money(row.watermarkPrice)}</>}
                      </p>
                    )}
                  </li>
                );
              })}
              {cards.length === 0 && (
                <li data-dir="NEUTRAL" className="hero-none">
                  <p>
                    <strong>Nothing moved enough to tell you about.</strong> Every symbol on this
                    list stayed inside its own normal range over this window. Saying so is a real
                    answer, and most watchlists cannot give it — with no notion of what normal looks
                    like for a given stock, they show the same numbers whether or not anything
                    happened.
                  </p>
                </li>
              )}
            </ul>

            <p className="hero-quiet">
              {quiet} other {quiet === 1 ? "symbol" : "symbols"} checked and left alone
              {cards.length > 4 && <> · {cards.length - 4} more surfaced</>}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
