/** Display helpers. Money arrives as integer paise and is only ever divided
 *  here, at the last possible moment before it becomes text. */

const INR = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(paise: number | null | undefined): string {
  if (paise == null) return "—";
  return INR.format(paise / 100);
}

export function pct(r: number | null | undefined, digits = 2): string {
  if (r == null || !Number.isFinite(r)) return "—";
  return `${r > 0 ? "+" : ""}${(r * 100).toFixed(digits)}%`;
}

export function age(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const DAY = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
});

export const clock = (ts: number) => TIME.format(new Date(ts));
export const day = (ts: number) => DAY.format(new Date(ts));

/** "4 Sep 15:30" — the market always speaks IST, whatever the reader's zone. */
export const stamp = (ts: number) => `${DAY.format(new Date(ts))} ${TIME.format(new Date(ts))}`;

/** Turn an evidence key into something a person can read. */
export function humanKey(k: string): string {
  return k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bZ\b/, "z-score");
}

export function evidenceValue(v: number | string | boolean | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) > 999) return v.toLocaleString("en-IN");
    return String(Number(v.toFixed(5)));
  }
  return v;
}
