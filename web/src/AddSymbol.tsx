/**
 * Adding and removing symbols.
 *
 * The brief lists "create and manage a watchlist" as its first minimum, and for
 * a while this product could not do it: the endpoints existed, were validated,
 * and were wired to nothing. That is a worse failure than not having built them,
 * because it looks like a considered omission when it is just an unfinished one.
 *
 * The control is deliberately small. A watchlist is edited rarely and read
 * constantly, so the editing affordance should not compete with the digest for
 * the top of the page. It searches the instruments we actually hold history
 * for, because offering a symbol we cannot price would trade a clear "we do not
 * have that" for a row that stays permanently blank.
 *
 * That message has to actually exist, which for a while it did not: the results
 * list rendered only when there were results, so typing a name we do not carry
 * produced nothing at all and the comment above described a kindness the
 * interface was not performing.
 */
import { useEffect, useRef, useState } from "react";

interface Match {
  symbol: string;
  display_name: string;
  is_index: number;
}

export function AddSymbol({
  user,
  watched,
  onChanged,
}: {
  user: string;
  watched: Set<string>;
  onChanged: () => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    // Debounced: a keystroke is not a query.
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/symbols?q=${encodeURIComponent(q)}`);
        const body = (await res.json()) as { symbols: Match[] };
        if (cancelled) return;
        setMatches(body.symbols.filter((m) => !m.is_index).slice(0, 8));
        setActive(0);
      } catch {
        if (!cancelled) setMatches([]);
      }
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const add = async (symbol: string) => {
    setBusy(symbol);
    setError(null);
    try {
      const res = await fetch(`/api/watchlist?user=${encodeURIComponent(user)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Could not add ${symbol}.`);
        return;
      }
      setQuery("");
      setMatches([]);
      setOpen(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const searching = query.trim().length > 0;
  const noMatch = open && searching && matches.length === 0 && !busy;
  const visible = open && matches.length > 0;

  return (
    <div className="addsym" ref={boxRef}>
      <label className="addsym-field">
        <span className="visually-hidden">Add a symbol to your watchlist</span>
        <input
          type="text"
          value={query}
          placeholder="Add a symbol"
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (!visible) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const pick = matches[active];
              if (pick && !watched.has(pick.symbol)) void add(pick.symbol);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          aria-expanded={visible}
          aria-controls="addsym-results"
        />
      </label>

      {visible && (
        <ul className="addsym-results" id="addsym-results" role="listbox">
          {matches.map((m, i) => {
            const already = watched.has(m.symbol);
            return (
              <li key={m.symbol}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  disabled={already || busy === m.symbol}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => add(m.symbol)}
                >
                  <code>{m.symbol}</code>
                  <span>{m.display_name}</span>
                  {already && <em>on your list</em>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {noMatch && (
        <p className="addsym-error" role="status">
          No instrument named “{query.trim()}” in the recorded universe. This build ships fifty-one
          symbols; a name we cannot price would become a row that stays permanently blank.
        </p>
      )}

      {error && <p className="addsym-error">{error}</p>}
    </div>
  );
}

/**
 * Removing keeps the watermark.
 *
 * Deleting it would mean that taking a symbol off the list for a fortnight and
 * putting it back replays the fortnight as news, which is not what the person
 * asked for and not what they remember doing.
 */
export function RemoveSymbol({
  user,
  symbol,
  onChanged,
}: {
  user: string;
  symbol: string;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="rowaction"
      title={`Remove ${symbol} from your watchlist`}
      aria-label={`Remove ${symbol} from your watchlist`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch(`/api/watchlist/${encodeURIComponent(symbol)}?user=${encodeURIComponent(user)}`, {
            method: "DELETE",
          });
          await onChanged();
        } finally {
          setBusy(false);
        }
      }}
    >
      remove
    </button>
  );
}
