/**
 * The absence ruler, and the sparklines that share its axis.
 *
 * This is the one idea the interface is built around. A conventional watchlist
 * draws each stock a chart over a fixed period — 1D, 1W, 1M — chosen by the
 * product. Here the period is chosen by the reader: it runs from the moment
 * they last acknowledged this list to right now, and it is different for every
 * user and every visit.
 *
 * Because there is one such window, there is one axis, drawn once at the top
 * and reused by every card below it. That makes vertical alignment carry
 * meaning: two moves at the same horizontal position happened at the same
 * moment, which is usually the market rather than the company. It also makes
 * the shape of the absence visible — a weekend is a wide empty gap, a
 * three-day trip is three narrow bars of trading separated by long nights.
 */
import { day, stamp } from "./format.js";
import type { PathPoint } from "./types.js";

export interface Band {
  from: number;
  to: number;
}

interface Scale {
  from: number;
  to: number;
  width: number;
}

const x = (ts: number, s: Scale) =>
  s.to === s.from ? 0 : ((ts - s.from) / (s.to - s.from)) * s.width;

const VIEW_W = 1000;

/** Day boundaries (IST midnight) inside a range, for tick labels. */
function dayTicks(from: number, to: number): number[] {
  const out: number[] = [];
  const IST = 330 * 60_000;
  let d = Math.floor((from + IST) / 86_400_000) * 86_400_000 - IST;
  for (let i = 0; i < 40 && d <= to; i++) {
    if (d > from) out.push(d);
    d += 86_400_000;
  }
  return out;
}

export function Ruler({ from, to, bands = [] }: { from: number; to: number; bands?: Band[] }) {
  const s: Scale = { from, to, width: VIEW_W };
  const ticks = dayTicks(from, to);
  const spanDays = (to - from) / 86_400_000;
  const label = `Market open periods between ${stamp(from)} and ${stamp(to)} IST`;

  return (
    <div className="ruler">
      <svg viewBox={`0 0 ${VIEW_W} 46`} preserveAspectRatio="none" role="img" aria-label={label}>
        {/* Closed time is the ground; open time is drawn on top of it. */}
        <line x1="0" y1="26" x2={VIEW_W} y2="26" stroke="var(--rule)" strokeWidth="1" vectorEffect="non-scaling-stroke" />

        {bands.map((b, i) => (
          <rect
            key={i}
            x={x(b.from, s)}
            y={18}
            width={Math.max(1.5, x(b.to, s) - x(b.from, s))}
            height={16}
            fill="var(--rule-strong)"
            opacity="0.85"
          />
        ))}

        {spanDays < 40 &&
          ticks.map((t) => (
            <g key={t}>
              <line
                x1={x(t, s)}
                y1={14}
                x2={x(t, s)}
                y2={38}
                stroke="var(--rule)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}

        {/* The two ends of the window: where you left, and where you are. */}
        <line x1="0.5" y1="8" x2="0.5" y2="44" stroke="var(--ink)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <line
          x1={VIEW_W - 0.5}
          y1="8"
          x2={VIEW_W - 0.5}
          y2="44"
          stroke="var(--ink)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="ruler-labels">
        <span>
          <em>you last looked</em> · {stamp(from)}
        </span>
        {/* The session count lives in the headline above, which counts whole
            sessions while this counted shaded bands including a partial one —
            so the two disagreed by one, forty pixels apart. One of them had to
            go, and the headline is the one people read. */}
        <span>
          <em>now</em> · {stamp(to)}
        </span>
      </div>
    </div>
  );
}

/**
 * A price path plotted on the shared time axis.
 *
 * The *time* axis is shared and the *price* axis is not. Every card spans the
 * same window, so a stock that only moved in the last hour of a week's absence
 * shows a flat line and then a kink at the far right, which is the true shape
 * of what happened and is the reason for drawing them all on one scale. The
 * vertical extent is per-card, because two instruments trading at 15 and at
 * 27,000 rupees cannot share one.
 *
 * So vertical amplitude is not comparable between cards, and the number beside
 * the card is what carries magnitude. An earlier version of this comment
 * claimed otherwise about both axes, which was worse than saying nothing:
 * anyone who read it would have trusted a comparison the picture cannot
 * support.
 */
export function Spark({
  points,
  from,
  to,
  bands = [],
  direction,
  anchorPrice,
}: {
  points: PathPoint[];
  from: number;
  to: number;
  bands?: Band[];
  direction: "UP" | "DOWN" | "NEUTRAL";
  anchorPrice: number | null;
}) {
  const H = 62;
  const s: Scale = { from, to, width: VIEW_W };

  if (points.length < 2) {
    // No path is a real state, not an error: a symbol the provider has stopped
    // returning has no prices to draw. Say so in words rather than showing an
    // empty box the reader has to interpret.
    return (
      <div className="card-chart card-chart--empty">
        <span>no price path in this window</span>
      </div>
    );
  }

  /** The gaps between sessions: nights, weekends, holidays. */
  const closed: Band[] = [];
  let cursor = from;
  for (const b of bands) {
    if (b.from > cursor) closed.push({ from: cursor, to: b.from });
    cursor = Math.max(cursor, b.to);
  }
  if (cursor < to) closed.push({ from: cursor, to });

  const prices = points.map((p) => p.price);
  const anchors = anchorPrice != null ? [...prices, anchorPrice] : prices;
  const lo = Math.min(...anchors);
  const hi = Math.max(...anchors);
  const pad = (hi - lo) * 0.18 || Math.max(1, hi * 0.002);
  const y = (p: number) => H - 6 - ((p - (lo - pad)) / (hi - lo + pad * 2)) * (H - 12);

  // Break the path wherever the market was shut.
  //
  // The comment above used to claim the line was not drawn across a weekend,
  // while a single continuous polyline ran straight through every gap. Joining
  // Friday's close to Monday's open with a diagonal invents a journey the price
  // never took: it draws the stock drifting through the weekend, which is the
  // one thing prices provably do not do. A lifted pen is the honest rendering
  // of "nothing happened here, and then this was the next print".
  const sessionOf = (ts: number) => bands.findIndex((b) => ts >= b.from && ts <= b.to);
  const gapBetween = (a: PathPoint, b: PathPoint): boolean => {
    const ia = sessionOf(a.ts);
    const ib = sessionOf(b.ts);
    if (ia === -1 || ib === -1) return false; // cannot tell; do not invent a break
    return ia !== ib;
  };

  const lifts = points.map((p, i) => i === 0 || gapBetween(points[i - 1]!, p));

  // A session that printed once is a dot, not a line.
  //
  // Lifting the pen at every boundary is right, but a subpath of a single point
  // draws nothing at all -- SVG has no length to stroke. Over a five-session
  // absence, where each session contributes one close, every subpath was a lone
  // moveto and the whole path silently disappeared. Intraday windows have many
  // prints per session, which is why this only ever broke the long-absence case,
  // which is the case this product is about. An isolated print is still a fact;
  // it gets a mark of its own rather than being dropped.
  const isolated = points.filter(
    (_, i) => lifts[i] && (i === points.length - 1 || lifts[i + 1]),
  );

  const d = points
    .map((p, i) => `${lifts[i] ? "M" : "L"}${x(p.ts, s).toFixed(2)},${y(p.price).toFixed(2)}`)
    .join(" ");
  const stroke = direction === "UP" ? "var(--up)" : direction === "DOWN" ? "var(--down)" : "var(--attn)";
  const net = ((points[points.length - 1]!.price - points[0]!.price) / points[0]!.price) * 100;

  return (
    <div className="card-chart">
      <svg
        viewBox={`0 0 ${VIEW_W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Price path from ${day(from)} to ${day(to)}, net ${net.toFixed(2)} percent`}
      >
        {/* Hours the market was shut, receding. A flat stretch across a
            weekend is not the stock being quiet; it is nothing having
            happened, and the two deserve to look different. */}
        {closed.map((b, i) => (
          <rect
            key={i}
            x={x(b.from, s)}
            y={0}
            width={Math.max(1, x(b.to, s) - x(b.from, s))}
            height={H}
            fill="var(--ink)"
            opacity="0.045"
          />
        ))}

        {anchorPrice != null && (
          <line
            x1="0"
            y1={y(anchorPrice)}
            x2={VIEW_W}
            y2={y(anchorPrice)}
            stroke="var(--ink-faint)"
            strokeWidth="1"
            strokeDasharray="3 4"
            vectorEffect="non-scaling-stroke"
          />
        )}

        <path
          className="path-draw"
          style={{ ["--len" as string]: "2000" }}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {isolated.map((p, i) => (
          <circle key={i} cx={x(p.ts, s)} cy={y(p.price)} r="2.5" fill={stroke} />
        ))}
        <circle cx={x(points[points.length - 1]!.ts, s)} cy={y(points[points.length - 1]!.price)} r="2.5" fill={stroke} />
      </svg>
    </div>
  );
}
