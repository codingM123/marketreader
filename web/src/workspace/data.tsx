/**
 * Shared workspace state: which account is being read, and its digest.
 *
 * One fetch and one live stream for the whole workspace, rather than one per
 * page. The digest is the same object every surface is a view of — the held-back
 * ledger and the full table are literally slices of it — so refetching per route
 * would show a reader two different truths depending on which tab they were on.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DigestResponse } from "../types.js";

export interface Account {
  id: string;
  name: string;
  policy: string;
  symbols: number;
}

interface WorkspaceValue {
  user: string;
  setUser: (u: string) => void;
  accounts: Account[];
  data: DigestResponse | null;
  error: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside WorkspaceProvider");
  return v;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  /**
   * Which account you are looking at survives a reload.
   *
   * It did not, and the gap was embarrassing in a product whose entire subject
   * is remembering where you left off: the picker was `useState("demo")`, so
   * switching to Asha and refreshing brought you back as Demo, in a new tab as
   * Demo, and on another device as Demo. The watermarks were being persisted
   * correctly the whole time -- it was the identity in front of them that was
   * not. Real authentication would set this from a session; until there is any,
   * the browser is the only place to keep it.
   */
  const [user, setUser] = useState(() => {
    try {
      return window.localStorage.getItem("marketreader.user") ?? "demo";
    } catch {
      return "demo"; // private mode, or storage disabled
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem("marketreader.user", user);
    } catch {
      /* not worth failing a render over */
    }
  }, [user]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [data, setData] = useState<DigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api<DigestResponse>(`/digest?user=${encodeURIComponent(user)}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [user]);

  useEffect(() => {
    void api<{ users: Account[] }>("/users")
      .then((r) => setAccounts(r.users))
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    setData(null);
    void refresh();
    // Conflated server-side to one frame every few seconds. The UI is read at
    // human speed; a frame per tick would spend bandwidth on pictures nobody
    // can perceive.
    const es = new EventSource(`/api/stream?user=${encodeURIComponent(user)}`);
    es.addEventListener("digest", (ev) => {
      try {
        setData(JSON.parse((ev as MessageEvent).data));
        setError(null);
      } catch {
        /* one malformed frame is not worth tearing the page down for */
      }
    });
    es.onerror = () => setError("live connection interrupted — showing the last good state");
    return () => es.close();
  }, [user, refresh]);

  const value = useMemo(
    () => ({ user, setUser, accounts, data, error, refresh }),
    [user, accounts, data, error, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The account switcher, shared by every workspace header. */
export function AccountPicker() {
  const { user, setUser, accounts } = useWorkspace();
  if (accounts.length < 2) return null;
  return (
    <label className="acct">
      <span className="visually-hidden">Read the market as a different account</span>
      <select value={user} onChange={(e) => setUser(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.symbols} symbols
          </option>
        ))}
      </select>
    </label>
  );
}
