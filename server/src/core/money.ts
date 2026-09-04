/**
 * Money is integer paise. Never a float.
 *
 * Rationale: prices arrive from providers as IEEE-754 doubles, and every
 * downstream comparison ("did this cross 52w high?", "is this move bigger than
 * the circuit band?") is an equality-ish test. Accumulating float error into a
 * threshold check is how watchlists produce phantom alerts. We convert once, at
 * the edge, and stay in integers everywhere inside the domain.
 */
export type Paise = number; // integer

const PAISE_PER_RUPEE = 100;

/** Convert a provider-supplied rupee float to integer paise. Rejects garbage. */
export function toPaise(rupees: number | null | undefined): Paise | null {
  if (rupees == null || !Number.isFinite(rupees)) return null;
  if (rupees < 0) return null; // negative price is never valid data
  return Math.round(rupees * PAISE_PER_RUPEE);
}

export function toRupees(p: Paise): number {
  return p / PAISE_PER_RUPEE;
}

const INR = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "132800" -> "1,328.00"  (Indian lakh/crore grouping) */
export function formatPaise(p: Paise): string {
  return INR.format(toRupees(p));
}

/**
 * Simple return between two prices, as a fraction (0.042 = +4.2%).
 * Returns null rather than Infinity/NaN when the base is unusable — a caller
 * that gets null must decide what to show; a caller that gets Infinity will
 * silently render "∞%".
 */
export function ret(from: Paise | null, to: Paise | null): number | null {
  if (from == null || to == null || from <= 0) return null;
  return (to - from) / from;
}

/** Format a fractional return as a signed percentage string. */
export function formatPct(r: number, digits = 2): string {
  const sign = r > 0 ? "+" : "";
  return `${sign}${(r * 100).toFixed(digits)}%`;
}
