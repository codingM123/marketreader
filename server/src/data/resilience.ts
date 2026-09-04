/**
 * Talking to something that will fail.
 *
 * A market data provider is not a function call. It rate-limits, it times out,
 * it returns a 200 with an empty body, it goes down for four minutes at 09:20.
 * The three primitives here cover the failure modes that actually happen, and
 * they are separated so each can be reasoned about and tested on its own.
 *
 * Deliberately not used: an unbounded retry loop. Retrying into a provider that
 * is already failing is how a partial outage becomes a total one, and how you
 * get rate-limited out of a service that was about to recover.
 */

/**
 * Token bucket. Smooths a burst into a sustainable rate while still allowing a
 * short burst, which is what a per-cycle fan-out over a few hundred symbols
 * actually looks like.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Milliseconds to wait before a token is available. 0 when one is free. */
  take(now: number = Date.now()): number {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
  }

  available(now: number = Date.now()): number {
    return Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
  }
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not a refinement. Without it, every symbol that failed in the same
 * cycle retries at the same instant, so the recovering provider is hit by the
 * exact burst that knocked it over, and the outage oscillates instead of
 * ending. Full jitter (uniform over [0, cap]) is the variant that de-correlates
 * hardest.
 */
export function backoffDelay(attempt: number, baseMs = 400, capMs = 30_000, rand = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rand() * exp);
}

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Circuit breaker.
 *
 * Once a provider has failed enough times in a row, stop asking. The point is
 * not to protect the provider; it is that a request we are confident will fail
 * costs us latency on every user request queued behind it, and returning
 * last-known-good instantly is a strictly better answer than returning an error
 * slowly.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private halfOpenInFlight = false;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  state(now: number = Date.now()): BreakerState {
    if (this.failures < this.threshold) return "CLOSED";
    if (now - this.openedAt >= this.cooldownMs) return "HALF_OPEN";
    return "OPEN";
  }

  /** True when a call may proceed. A half-open circuit admits exactly one. */
  allow(now: number = Date.now()): boolean {
    const s = this.state(now);
    if (s === "CLOSED") return true;
    if (s === "OPEN") return false;
    if (this.halfOpenInFlight) return false;
    this.halfOpenInFlight = true;
    return true;
  }

  succeed(): void {
    this.failures = 0;
    this.halfOpenInFlight = false;
  }

  fail(now: number = Date.now()): void {
    this.failures++;
    this.halfOpenInFlight = false;
    if (this.failures >= this.threshold) this.openedAt = now;
  }

  snapshot(now: number = Date.now()) {
    return { state: this.state(now), failures: this.failures, openedAt: this.openedAt };
  }
}

/** Abort a promise that has stopped making progress. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
