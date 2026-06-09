// Exponential backoff with jitter, retrying only when a predicate says the failure is retryable
// (used for Lab 429s on MCP tool calls). Pure and unit-testable — the sleep is injectable.

export interface BackoffOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  isRetryable: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions): Promise<T> {
  const retries = opts.retries ?? 4;
  const baseMs = opts.baseMs ?? 200;
  const maxMs = opts.maxMs ?? 5_000;
  const sleep = opts.sleep ?? defaultSleep;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !opts.isRetryable(err)) throw err;
      const expo = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * (expo / 2));
      await sleep(expo / 2 + jitter);
    }
  }
}
