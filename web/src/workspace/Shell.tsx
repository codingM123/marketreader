/**
 * The workspace frame.
 *
 * Six surfaces, and each one exists because the server already does that work
 * and had nowhere to show it. The event log and the ingestion status in
 * particular carry two of the load-bearing arguments in this project — an
 * immutable log with read state held separately, and a fan-in design whose cost
 * is bounded by the exchange rather than the user count — and both were
 * invisible, which makes an argument into a claim.
 *
 * Nothing here is a page invented to fill a sidebar. If a route were removed,
 * a real capability would stop being reachable.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, isActive, useRouter } from "../router.js";

interface NavItem {
  to: string;
  label: string;
  hint: string;
  exact?: boolean;
}

/** Which sidebar group a route belongs to. The breadcrumb reads from this. */
function groupOf(path: string): string {
  for (const g of GROUPS) {
    if (g.items.some((i) => isActive(path, i.to, i.exact))) return g.title;
  }
  return "Watchlist";
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Watchlist",
    items: [
      { to: "/watch", label: "Digest", hint: "What changed since you last looked", exact: true },
      { to: "/watch/all", label: "All symbols", hint: "The full list, and adding to it" },
      { to: "/watch/held-back", label: "Held back", hint: "What was not shown, and why" },
      { to: "/watch/history", label: "History", hint: "Every event, and whether you saw it" },
    ],
  },
  {
    title: "The system",
    items: [
      { to: "/lab", label: "Lab", hint: "Move time, break the feed" },
      { to: "/system", label: "Health", hint: "Ingestion, provider, data checks" },
    ],
  },
];

/**
 * Whether the lab exists on this server.
 *
 * Its routes are not registered in live mode, so offering the page there gives
 * a reviewer a screen whose every button fails against a 404 in silence. The
 * status endpoint already publishes the flag; not reading it was the same
 * mistake as exporting a constant nothing consults.
 */
function useLabAvailable(): boolean {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    void fetch("/api/status")
      .then((r) => r.json())
      .then((s: { lab?: boolean }) => setOk(s.lab !== false))
      .catch(() => setOk(true));
  }, []);
  return ok;
}

export function Shell({
  children,
  title,
  lede,
  actions,
  session,
  wide,
}: {
  children: ReactNode;
  title: string;
  lede: string;
  actions?: ReactNode;
  session?: { session: string; isLive: boolean } | undefined;
  wide?: boolean;
}) {
  const { path } = useRouter();
  const labAvailable = useLabAvailable();
  const groups = labAvailable
    ? GROUPS
    : GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.to !== "/lab") }));

  return (
    <div className="ws">
      <nav className="ws-side" aria-label="Sections">
        <Link to="/" className="ws-brand">
          <span className="wordmark">MarketReader</span>
          <span className="ws-brand-back">← overview</span>
        </Link>

        {groups.map((g) => (
          <div className="ws-group" key={g.title}>
            <h2>{g.title}</h2>
            <ul>
              {g.items.map((i) => (
                <li key={i.to}>
                  <Link
                    to={i.to}
                    className={"ws-nav" + (isActive(path, i.to, i.exact) ? " is-active" : "")}
                  >
                    <span className="ws-nav-label">{i.label}</span>
                    <span className="ws-nav-hint">{i.hint}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <p className="ws-foot">
          Replaying a recorded NSE session. Prices are real; the clock is ours.
        </p>
      </nav>

      <main className={"ws-main" + (wide ? " is-wide" : "")}>
        <header className="ws-head">
          <div>
            <p className="ws-crumb">
              {groupOf(path)} <span aria-hidden="true">/</span> {title}
            </p>
            <h1>{title}</h1>
            <p className="ws-lede">{lede}</p>
          </div>
          <div className="ws-head-actions">
            {session && (
              <span className={"ws-session" + (session.isLive ? " is-live" : "")}>
                {session.isLive ? "market open" : session.session.toLowerCase().replace("_", " ")}
              </span>
            )}
            {actions}
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

/** A labelled figure. Used wherever a number needs a name more than a chart. */
export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "up" | "down" | "attn";
}) {
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
