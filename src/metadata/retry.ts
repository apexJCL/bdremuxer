// Shared retry + backoff policy for the HTTP-backed metadata clients
// (TMDB, OMDb). Implements the §10 spec rule:
//
//   - retry on network errors, HTTP 5xx, HTTP 429 (honour Retry-After)
//   - fail fast on other 4xx (auth, 404, bad request)
//   - 3 tries by default; 1s/2s/4s exponential backoff

export class RetryableError extends Error {
  constructor(message: string, readonly delayMs: number) {
    super(message);
  }
}

export function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxTries: number,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (e instanceof RetryableError && attempt < maxTries) {
        await sleep(e.delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export type FetchJsonOpts = {
  url: string;
  maxTries: number;
  /** Short name used in error messages (e.g. "TMDB", "OMDb"). */
  service: string;
};

export async function fetchJsonWithRetry<T>(opts: FetchJsonOpts): Promise<T> {
  return withRetry(async (attempt) => {
    let res: Response;
    try {
      res = await fetch(opts.url);
    } catch (e) {
      throw new RetryableError(
        `${opts.service} network error: ${(e as Error).message}`,
        backoffMs(attempt),
      );
    }
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoffMs(attempt);
      throw new RetryableError(`${opts.service} 429 rate-limited`, delay);
    }
    if (res.status >= 500) {
      throw new RetryableError(`${opts.service} ${res.status}`, backoffMs(attempt));
    }
    const body = await res.text().catch(() => "");
    throw new Error(`${opts.service} ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }, opts.maxTries);
}
