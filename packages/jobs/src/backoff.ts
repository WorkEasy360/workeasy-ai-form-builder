export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Returns a number in [0, 1); injectable for tests. */
  random?: () => number;
}

/**
 * Exponential backoff with jitter: the ceiling doubles per attempt from
 * `baseMs` up to `maxMs`, and the delay is drawn from the upper half of it,
 * so retries spread out without collapsing to zero.
 */
export function backoffDelayMs(attempt: number, { baseMs = 5_000, maxMs = 3_600_000, random = Math.random }: BackoffOptions = {}): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
