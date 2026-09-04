/**
 * The lab, promoted from a drawer to a room.
 *
 * It was a floating panel over the digest, which was the wrong shape for what
 * it does: this is where every resilience claim in the project gets checked by
 * a stranger, and a claim you have to squint at in a 28rem drawer is not much
 * better than a claim in a README.
 *
 * Staleness is a function of elapsed time, so several of these faults change
 * nothing on screen until the clock moves — arming one advances the clock far
 * enough for the consequence to appear, and says so. A reviewer who clicks
 * "kill the feed", sees nothing, and concludes the injector is decorative has
 * learned the exact opposite of the truth.
 */
import { useEffect, useState } from "react";
import { stamp } from "../format.js";
import { AccountPicker, useWorkspace } from "./data.js";
import { Shell, Stat } from "./Shell.js";
import type { LabState } from "../types.js";

async function post(path: string, body: unknown, user = "demo"): Promise<any> {
  const res = await fetch(`/api${path}?user=${encodeURIComponent(user)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

const REWINDS: [string, number][] = [
  ["10 minutes", 10 * 60_000],
  ["a session", 24 * 3600_000],
  ["three days", 3 * 24 * 3600_000],
  ["a week", 7 * 24 * 3600_000],
  ["a month", 30 * 24 * 3600_000],
];

const FAULTS: { kind: string; label: string; expect: string }[] = [
  { kind: "FEED_DOWN", label: "Kill the feed", expect: "Every symbol goes stale with a visible age. Never a spinner, never a wrong number." },
  { kind: "FROZEN", label: "Freeze one symbol", expect: "That symbol reads illiquid while the rest stay live. This symbol stopped printing; the feed is fine." },
  { kind: "SYMBOL_GONE", label: "Delist a symbol", expect: "Unavailable, carried through from the provider's refusal rather than inferred from silence." },
  { kind: "GARBAGE_PRICE", label: "Send garbage", expect: "Rejected as a units error. Not displayable at all." },
  { kind: "CORRUPT_TICK", label: "Move it 47%", expect: "Too large to have been trading, nothing on file to explain it. Quarantined, with the reason." },
  { kind: "PHANTOM_SPLIT", label: "Undocumented 10:1", expect: "Exactly how Vedanta's real demerger behaved. Caught statistically, not reported as a crash." },
  { kind: "OUT_OF_ORDER", label: "Replay an old print", expect: "The write is refused. A price does not walk backwards in time." },
  { kind: "RATE_LIMITED", label: "Rate limit us", expect: "Fetches fail; last-known-good is served and ages honestly." },
];

export function LabPage() {
  const { user, data, refresh } = useWorkspace();
  const [state, setState] = useState<LabState | null>(null);
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const rows = data?.rows ?? [];
  const symbols = rows.map((r) => r.symbol).join(",");
  useEffect(() => {
    // Reconcile, not just initialise. Switching account left the select showing
    // whatever the browser fell back to while React still held the old symbol,
    // so a fault was armed on a stock this account does not watch and nothing
    // on screen moved -- which is precisely the "concludes the injector is
    // decorative" failure this file's header warns about.
    const list = symbols ? symbols.split(",") : [];
    if (list.length === 0) return;
    if (!target || !list.includes(target)) setTarget(list[0]!);
  }, [symbols, target]);

  const load = async () => {
    try {
      setState(await fetch("/api/lab").then((r) => r.json()));
    } catch {
      setState(null);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const fault = state?.fault;
  const activeKind = fault && fault.kind !== "NONE" ? fault.kind : null;
  const counts = rows.reduce<Record<string, number>>((a, r) => {
    a[r.quality] = (a[r.quality] ?? 0) + 1;
    return a;
  }, {});

  return (
    <Shell
      title="Lab"
      lede="Move time, or break the feed. Resilience claims are worthless unless a stranger can check them in ninety seconds."
      session={data?.session}
      actions={
        <>
          <AccountPicker />
          <button className="btn" disabled={busy} onClick={() => act(async () => { await post("/lab/reset", {}); setNote(null); })}>
            Reset everything
          </button>
        </>
      }
      wide
    >
      <div className="dg-foot">
        {Object.entries(counts).map(([q, n]) => (
          <Stat
            key={q}
            label={q.toLowerCase()}
            value={n}
            tone={q === "LIVE" || q === "CLOSED" ? undefined : "attn"}
            note={q === "LIVE" ? "fresh, market open" : q === "ILLIQUID" ? "not printing; feed healthy" : undefined}
          />
        ))}
      </div>

      {activeKind && state?.faultKinds?.[activeKind] && (
        <p className="notice is-attn">
          <strong>{activeKind.replace(/_/g, " ").toLowerCase()}</strong>
          {fault?.symbol ? ` on ${fault.symbol}` : " on the whole feed"} — {state.faultKinds[activeKind]}
          {note && <> {note}</>}
        </p>
      )}

      <div className="lab-cols">
        <section>
          <h3 className="sec-label">Come back later</h3>
          <p className="lab-note">
            Moves this account’s watermark back, so the digest computes against a longer absence.
            Past three sessions it stops replaying and starts summarising.
          </p>
          <div className="btnrow">
            {REWINDS.map(([label, ms]) => (
              <button
                key={label}
                className="btn"
                disabled={busy}
                onClick={() => act(async () => { await post("/lab/rewind", { ms }, user); setNote(null); })}
              >
                {label}
              </button>
            ))}
          </div>

          <h3 className="sec-label">Move the market</h3>
          <p className="lab-note">
            Advances the clock through the recorded session. Prices, staleness and session state all
            follow it.
          </p>
          <div className="btnrow">
            <button className="btn" disabled={busy} onClick={() => act(async () => { await post("/lab/clock", { advanceMs: 5 * 60_000 }); })}>
              +5 min
            </button>
            <button className="btn" disabled={busy} onClick={() => act(async () => { await post("/lab/clock", { advanceMs: 20 * 60_000 }); })}>
              +20 min
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => act(async () => { await post("/lab/clock", { seek: (state?.replay?.to ?? Date.now()) + 20 * 3600_000 }); })}
            >
              Past the close
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => act(async () => { await post("/lab/clock", { seek: (state?.replay?.to ?? Date.now()) + 40 * 3600_000 }); })}
            >
              Into the weekend
            </button>
          </div>
          {state?.clock && (
            <p className="lab-clock">
              clock at {stamp(state.clock.now)} IST
              {state.replay && (
                <>
                  {" "}
                  · recording spans {stamp(state.replay.from)} → {stamp(state.replay.to)}
                </>
              )}
            </p>
          )}
        </section>

        <section>
          <h3 className="sec-label">Break the feed</h3>
          <p className="lab-note">
            Each fault has a distinct correct response, and the counts above move when one
            lands. For the per-row badges the counts are drawn from, open{" "}
            <em>All symbols</em> after arming a fault.
          </p>
          <label className="lab-target">
            <span>Target</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={rows.length === 0}>
              {rows.map((r) => (
                <option key={r.symbol} value={r.symbol}>
                  {r.symbol}
                </option>
              ))}
            </select>
          </label>

          <ul className="fault-list">
            {FAULTS.map((f) => (
              <li key={f.kind} data-on={activeKind === f.kind}>
                <button
                  className="btn"
                  disabled={busy || rows.length === 0}
                  aria-pressed={activeKind === f.kind}
                  onClick={() =>
                    act(async () => {
                      const r = await post("/lab/fault", {
                        kind: f.kind,
                        symbol: f.kind === "FEED_DOWN" || f.kind === "RATE_LIMITED" ? null : target,
                      });
                      setNote(
                        r?.advancedMs
                          ? `Clock advanced ${Math.round(r.advancedMs / 60000)} minutes so the effect is visible.`
                          : null,
                      );
                    })
                  }
                >
                  {f.label}
                </button>
                <p>{f.expect}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Shell>
  );
}
