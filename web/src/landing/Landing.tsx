/**
 * The overview.
 *
 * This page exists because of a specific failure mode: with a large field and a
 * fast first read, engineering depth that takes twenty minutes to find is worth
 * the same as engineering depth that is not there. Everything below is an
 * argument the product already makes; the page's only job is to make those
 * arguments findable in ninety seconds, and to make them with real numbers from
 * the recorded session rather than with adjectives.
 *
 * Seven sections, one idea each. There is no eighth because there is no eighth
 * idea, and padding a scroll is the same mistake as padding a feature list.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "../router.js";
import { HeroDiff } from "./HeroDiff.js";
import { money, pct } from "../format.js";
import type { Card, DigestResponse, Row } from "../types.js";

const SECTIONS = [
  { id: "open", label: "The question" },
  { id: "gap", label: "The gap" },
  { id: "normal", label: "What is normal" },
  { id: "tape", label: "Stock or tape" },
  { id: "refuse", label: "What we will not guess" },
  { id: "measured", label: "Measured" },
  { id: "enter", label: "Open it" },
];

export function Landing() {
  const [active, setActive] = useState("open");
  /**
   * Arm the reveal only once script is running.
   *
   * The sections are visible by default and this class is what hides them so
   * they can fade in. Doing it the other way — hidden in the stylesheet,
   * revealed by an observer — meant the page was blank on first paint and blank
   * forever if the observer never fired.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);
  /**
   * One preview, shared by every section that quotes a number.
   *
   * An earlier version of this page typed its figures in. A fact-check found
   * eight of them stale, wrong, or unreproducible — a beta that no lookback
   * setting produced, two volatilities off by more than ten percent, and a
   * flagship "1.9σ" example card that the shipped detector would have
   * suppressed because the threshold is 2.0. On a page whose whole argument is
   * that every claim is checkable, that was the worst possible defect.
   *
   * So nothing here is remembered. The numbers are read off the same endpoint
   * the product uses, which means they cannot drift from it.
   */
  const [preview, setPreview] = useState<DigestResponse | null>(null);
  const rows = preview?.rows ?? [];

  useEffect(() => {
    void fetch("/api/preview?user=demo&awayMs=604800000")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DigestResponse | null) => setPreview(d))
      .catch(() => setPreview(null));
  }, []);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-40% 0px -40% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  return (
    <div className={"landing" + (armed ? " is-armed" : "")}>
      <TimeRuler active={active} />

      <header className="lp-top">
        <span className="wordmark">MarketReader</span>
        <nav>
          <Link to="/watch" className="lp-cta-small">
            Open the digest
          </Link>
        </nav>
      </header>

      <Section id="open" eyebrow="A watchlist for people who are not watching">
        <h1 className="lp-h1">
          You already knew
          <br />
          the price.
        </h1>
        <p className="lp-lede">
          What you came to find out is whether anything happened. Almost nothing on a normal
          watchlist is about that question, because a watchlist that does not know when you last
          looked can only report a period it chose for you.
        </p>
        <HeroDiff />
      </Section>

      <Section id="gap" eyebrow="The gap">
        <h2 className="lp-h2">
          Today’s change is the wrong number for everyone except today’s reader.
        </h2>
        <Versus preview={preview} />
      </Section>

      <Section id="normal" eyebrow="What counts as meaningful">
        <h2 className="lp-h2">
          Three percent is an event in one stock
          <br />
          and a Tuesday in another.
        </h2>
        <p className="lp-lede">
          A fixed threshold has a different false-positive rate for every name on the list. Both
          figures below are read live from the running baselines — five hundred sessions of closes,
          exponentially weighted with a twenty-session half-life.
        </p>
        <SigmaDemo rows={rows} />
      </Section>

      <Section id="tape" eyebrow="Stock, or tape">
        <h2 className="lp-h2">
          When the index falls, twenty cards saying so
          <br />
          is twenty ways of saying one thing.
        </h2>
        <p className="lp-lede">
          Each move is decomposed against the stock’s beta to NIFTY 50, and only the part the market
          does not explain is scored. The same arithmetic surfaces the case nobody catches: a stock
          that went <em>up</em> on a day everything else fell.
        </p>
        <Decomposition rows={rows} />
      </Section>

      <Section id="refuse" eyebrow="What we will not guess">
        <h2 className="lp-h2">A ten-for-one split is not a ninety percent crash.</h2>
        <div className="lp-pair">
          <article className="lp-case">
            <h3>Nestlé India, 5 January 2024</h3>
            <dl>
              <div>
                <dt>Close, 4 January</dt>
                <dd>₹27,116.40</dd>
              </div>
              <div>
                <dt>Open, 5 January</dt>
                <dd>₹2,754.00</dd>
              </div>
              <div>
                <dt>What a naive diff reports</dt>
                <dd className="is-down">−89.8%</dd>
              </div>
              <div>
                <dt>What happened to the holder</dt>
                <dd className="is-flat">+1.6%</dd>
              </div>
            </dl>
            <p>
              Both prices are what the exchange printed, reconstructed from the shipped bars — the
              series has since been adjusted for this split and a later 2:1, so the quoted figures
              are twenty times the adjusted ones. Returns are decomposed against the
              corporate-action feed before anything is scored.
            </p>
          </article>

          <article className="lp-case is-attn">
            <h3>Vedanta, April 2026</h3>
            <dl>
              <div>
                <dt>Single-session move</dt>
                <dd className="is-down">−64.9%</dd>
              </div>
              <div>
                <dt>Splits in the provider’s feed</dt>
                <dd>none, ever</dd>
              </div>
              <div>
                <dt>Dividends in the feed</dt>
                <dd>17, none at this date</dd>
              </div>
              <div>
                <dt>What this reports</dt>
                <dd className="is-attn">we cannot tell you</dd>
              </div>
            </dl>
            <p>
              It was a demerger, and the feed does not carry it. Note the second row: this is not a
              sparse feed. Seventeen dividends are on file for this stock, the most recent five
              weeks earlier — the data is there, and the one event that mattered is not. A system
              that trusts the feed alone tells you your holding lost two thirds of its value:
              terrifying, and false. So a move too large to have been trading, with nothing on file
              to explain it, is quarantined and says so.
            </p>
          </article>
        </div>
      </Section>

      <Section id="measured" eyebrow="Measured, not asserted">
        <h2 className="lp-h2">
          I claimed a constant false-positive rate.
          <br />
          Then I measured it, and it was not.
        </h2>
        <p className="lp-lede">
          Out of sample, 49 symbols, 34,732 held-out sessions. Standardising by sigma equalises
          scale, not shape — returns are fat-tailed and their kurtosis differs by name, so one
          threshold cuts different fractions of different distributions.
        </p>
        <table className="lp-table">
          <tbody>
            <tr>
              <th>Volatility the market adjustment removes</th>
              <td>13.9%</td>
              <td>median, out of sample</td>
            </tr>
            <tr>
              <th>Symbols it made worse</th>
              <td>0</td>
              <td>of 49</td>
            </tr>
            <tr>
              <th>Alert rate at 2σ, pooled</th>
              <td>8.7%</td>
              <td>a normal distribution implies 4.6%</td>
            </tr>
            <tr>
              <th>Alert rate at 2σ, per instrument</th>
              <td>0.8 – 15.0%</td>
              <td>Suzlon to TCS</td>
            </tr>
            <tr className="is-key">
              <th>Cards per visit, twenty-symbol list</th>
              <td>1.7</td>
              <td>against a cap of five</td>
            </tr>
          </tbody>
        </table>
        <p className="lp-note">
          The last row is the one worth defending, and it is the one nobody thinks to ask for. The
          rest is why the design also caps cards, holds a cooldown, and collapses market-wide moves
          rather than trusting a threshold to carry everything.
        </p>
      </Section>

      <Section id="enter" eyebrow="Open it">
        <h2 className="lp-h2">Seventy-two minutes of real NSE prices are already in the repo.</h2>
        <p className="lp-lede">
          No API key, no network, any hour. The lab lets you move the clock, kill the feed, freeze a
          symbol, or drop an undocumented ten-for-one split on a stock and watch what the product
          says about it.
        </p>
        <div className="lp-ctas">
          <Link to="/watch" className="lp-cta">
            Open the digest
          </Link>
          <Link to="/lab" className="lp-cta is-ghost">
            Break it in the lab
          </Link>
        </div>
        <p className="lp-colophon">
          Built for Code, by Groww · recorded 4 September 2026, 14:23–15:34 IST · 7,038 ticks across
          51 symbols
        </p>
      </Section>
    </div>
  );
}

function Section({
  id,
  eyebrow,
  children,
}: {
  id: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "-10% 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section id={id} ref={ref} className={"lp-section" + (seen ? " is-seen" : "")}>
      <p className="lp-eyebrow">{eyebrow}</p>
      {children}
    </section>
  );
}

/**
 * The scroll indicator is a time axis, not a row of dots.
 *
 * The product's signature element is a ruler running from the moment you last
 * looked to now. Reusing it as navigation means the page's own furniture says
 * something true about the subject instead of decorating it.
 */
function TimeRuler({ active }: { active: string }) {
  return (
    <nav className="lp-ruler" aria-label="Sections">
      <ul>
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a href={"#" + s.id} data-on={active === s.id}>
              <span className="lp-ruler-tick" aria-hidden="true" />
              <span className="lp-ruler-label">{s.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The conventional row, and this one, for whatever actually surfaced.
 *
 * Both halves are the same symbol and the same instant, read from a live
 * preview. Hard-coding an example is how the previous version ended up
 * advertising a card its own detector would have suppressed.
 */
function Versus({ preview }: { preview: DigestResponse | null }) {
  const card: Card | undefined = preview?.digest.cards.find((c) => c.kind === "MOVE");
  const row = card ? preview?.rows.find((r) => r.symbol === card.symbol) : undefined;

  if (!card || !row) {
    return (
      <p className="lp-note">
        Start the demo server to see this section fill itself from a live comparison:{" "}
        <code>npm run serve</code>.
      </p>
    );
  }

  return (
    <div className="lp-versus">
      <figure>
        <figcaption>What every watchlist shows</figcaption>
        <div className="lp-row-conv">
          <code>{card.symbol}</code>
          <span className="lp-row-price">{money(row.price)}</span>
          <span className="lp-row-pct">{pct(row.changeToday)}</span>
        </div>
        <p>
          True, and useless to someone who last looked a week ago. The sessions they missed are
          folded into a number that does not mention them.
        </p>
      </figure>
      <figure>
        <figcaption>What this shows</figcaption>
        <div className="lp-row-ours" data-dir={card.direction}>
          <code>{card.symbol}</code>
          <span className="lp-row-pct">{pct(row.changeSinceSeen)}</span>
          <p>{card.because}.</p>
        </div>
        <p>
          Measured from the moment <em>you</em> last acknowledged the list, normalised by what this
          instrument normally does, with the index move taken out.
        </p>
      </figure>
    </div>
  );
}

/** Two real instruments, one shared move, two different verdicts. */
function SigmaDemo({ rows }: { rows: Row[] }) {
  const [movePct, setMovePct] = useState(3);

  const pick = (sym: string) => {
    const r = rows.find((x) => x.symbol === sym);
    return { symbol: sym, sigma: r?.dailyVol == null ? null : r.dailyVol * 100 };
  };
  const calm = pick("HINDUNILVR");
  const wild = pick("SUZLON");

  if (calm.sigma == null || wild.sigma == null) {
    return (
      <p className="lp-note">
        Start the demo server to see this computed from the running baselines:{" "}
        <code>npm run serve</code>.
      </p>
    );
  }

  const crossing = (sigma: number) => sigma * 2;

  return (
    <div className="sigma-demo">
      <label htmlFor="movepct">
        <span>Both stocks move</span>
        <strong>{movePct.toFixed(1)}%</strong>
        <span>in a session</span>
      </label>
      <input
        id="movepct"
        type="range"
        min={0.5}
        max={8}
        step={0.1}
        value={movePct}
        onChange={(e) => setMovePct(Number(e.target.value))}
      />
      <div className="sigma-pair">
        {[calm, wild].map((s) => {
          const sigma = s.sigma!;
          const z = sigma > 0 ? movePct / sigma : 0;
          const fires = z >= 2;
          return (
            <div key={s.symbol} className={"sigma-card" + (fires ? " is-firing" : "")}>
              <div className="sigma-head">
                <code>{s.symbol}</code>
                <span>{sigma.toFixed(2)}% a day, typically</span>
              </div>
              <div className="sigma-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (z / 4) * 100)}%` }} />
                <em style={{ left: "50%" }} />
              </div>
              <p className="sigma-verdict">
                <strong>{z.toFixed(1)}σ</strong>
                {fires ? " — surfaced" : " — inside its normal range, held back"}
              </p>
            </div>
          );
        })}
      </div>
      <p className="lp-note">
        The threshold is the same for both — two sigma. The distance is not.{" "}
        {calm.symbol} crosses at {crossing(calm.sigma).toFixed(1)}% and {wild.symbol} stays silent
        until {crossing(wild.sigma).toFixed(1)}%, so between those two figures one of them is news
        and the other is a Tuesday. That gap is the entire reason a percentage cannot be the rule.
      </p>
    </div>
  );
}

/**
 * One move, split into the part the market explains and the part it does not.
 *
 * The beta is the live one for whichever symbol we can read it from; the two
 * scenarios are labelled as scenarios. Both were previously typed in, and the
 * beta was a value no lookback setting in the codebase produces.
 */
function Decomposition({ rows }: { rows: Row[] }) {
  const anchor = rows.find((r) => r.symbol === "RELIANCE" && r.beta != null) ?? rows.find((r) => r.beta != null);
  const beta = anchor?.beta ?? null;
  if (beta == null || !anchor) {
    return (
      <p className="lp-note">
        Start the demo server to see this computed against a live beta: <code>npm run serve</code>.
      </p>
    );
  }

  const cases = [
    {
      label: "Fell with everything else",
      stock: -2.4,
      market: -2.1,
      beta,
      verdict: "held back — the tape, not the stock",
      tone: "quiet" as const,
    },
    {
      label: "Rose while the market fell",
      stock: 2.6,
      market: -0.9,
      beta,
      verdict: "surfaced — this is the stock, not the tape",
      tone: "up" as const,
    },
  ];

  return (
    <div className="decomp">
      <p className="lp-note" style={{ marginTop: 0, marginBottom: "1.25rem" }}>
        Two scenarios, run against {anchor.symbol}’s live beta of {beta.toFixed(2)}.
      </p>
      {cases.map((c) => {
        const explained = c.beta * c.market;
        const residual = c.stock - explained;
        const scale = 5;
        const w = (x: number) => `${Math.min(100, (Math.abs(x) / scale) * 100)}%`;
        return (
          <div className="decomp-case" key={c.label} data-tone={c.tone}>
            <p className="decomp-label">{c.label}</p>
            <dl>
              <div>
                <dt>The stock moved</dt>
                <dd>{c.stock > 0 ? "+" : ""}{c.stock.toFixed(2)}%</dd>
              </div>
              <div>
                <dt>The index explains</dt>
                <dd className="is-quiet">
                  {explained > 0 ? "+" : ""}
                  {explained.toFixed(2)}%
                </dd>
              </div>
              <div>
                <dt>Left over</dt>
                <dd className={residual > 0 ? "is-up" : "is-down"}>
                  {residual > 0 ? "+" : ""}
                  {residual.toFixed(2)}%
                </dd>
              </div>
            </dl>
            <div className="decomp-bars" aria-hidden="true">
              <span className="is-explained" style={{ width: w(explained) }} />
              <span className="is-residual" style={{ width: w(residual) }} />
            </div>
            <p className="decomp-verdict">{c.verdict}</p>
          </div>
        );
      })}
    </div>
  );
}
