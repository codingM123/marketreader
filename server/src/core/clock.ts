/**
 * Time as a dependency.
 *
 * Nothing in this system calls `Date.now()` directly. Every module that needs
 * the time is handed a Clock, for two reasons.
 *
 * The first is testing: a watchlist whose entire premise is "what changed since
 * you last looked" is untestable if the only available now is the real one. The
 * calendar tests above depend on being able to stand at 09:05 on a Tuesday.
 *
 * The second is the demo. This build was written over a weekend, when NSE is
 * shut, and will be reviewed at some other arbitrary hour. A product that only
 * works between 09:15 and 15:30 on weekdays looks broken the rest of the time
 * through no fault of its own. Making the clock injectable means the recorded
 * session can be replayed at any wall-clock moment, and it means a reviewer can
 * jump three days forward and watch the digest change shape.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * A clock that can be positioned and run at a chosen rate.
 *
 * Position is stored as an offset from real time rather than as an absolute
 * instant, so a paused-then-resumed clock does not jump, and so that the
 * ordinary case (offset zero, speed one) is exactly the system clock.
 */
export class VirtualClock implements Clock {
  private anchorReal: number;
  private anchorVirtual: number;
  private speed: number;
  private paused = false;

  constructor(startAt: number = Date.now(), speed = 1) {
    this.anchorReal = Date.now();
    this.anchorVirtual = startAt;
    this.speed = speed;
  }

  now(): number {
    if (this.paused) return this.anchorVirtual;
    return this.anchorVirtual + (Date.now() - this.anchorReal) * this.speed;
  }

  /** Jump to an absolute instant. */
  seek(ts: number): void {
    this.anchorVirtual = ts;
    this.anchorReal = Date.now();
  }

  /** Move by a signed offset from wherever we are. */
  advance(ms: number): void {
    this.anchorVirtual = this.now() + ms;
    this.anchorReal = Date.now();
  }

  setSpeed(speed: number): void {
    this.anchorVirtual = this.now();
    this.anchorReal = Date.now();
    this.speed = speed;
  }

  pause(): void {
    if (this.paused) return;
    this.anchorVirtual = this.now();
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.anchorReal = Date.now();
    this.paused = false;
  }

  state(): { now: number; speed: number; paused: boolean; offsetMs: number } {
    return {
      now: this.now(),
      speed: this.speed,
      paused: this.paused,
      offsetMs: this.now() - Date.now(),
    };
  }
}
