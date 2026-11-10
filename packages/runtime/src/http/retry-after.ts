// Reads how long a rate-limited target asks us to wait, from the headers the
// profile names. Tiered limiters send several headers; the longest wait wins.

export interface RetryAfterConfig {
  /** Header names; a trailing `*` matches a prefix, e.g. `retry-after-*`. */
  readonly headers: readonly string[];
  readonly unit: 'seconds' | 'milliseconds';
}

function matches(pattern: string, name: string): boolean {
  const lower = pattern.toLowerCase();
  return lower.endsWith('*') ? name.startsWith(lower.slice(0, -1)) : name === lower;
}

/** The wait in milliseconds, or undefined when no named header holds a usable value. */
export function retryAfterMs(
  headers: Readonly<Record<string, string>>,
  config: RetryAfterConfig,
  nowEpochMs: number,
): number | undefined {
  let wait: number | undefined;
  for (const [name, raw] of Object.entries(headers)) {
    if (!config.headers.some((pattern) => matches(pattern, name.toLowerCase()))) continue;
    const value = raw.trim();
    let ms: number | undefined;
    if (/^\d+(?:\.\d+)?$/u.test(value)) {
      ms = Number(value) * (config.unit === 'seconds' ? 1_000 : 1);
    } else {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) ms = Math.max(0, date - nowEpochMs);
    }
    if (ms !== undefined) wait = Math.max(wait ?? 0, ms);
  }
  return wait;
}
