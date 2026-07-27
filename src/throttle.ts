export interface ThrottleOptions {
  minIntervalMs: number;
  jitterMs: number;
  maxRetries: number;
  backoffBaseMs: number;
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class Throttler {
  private tail: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(private readonly options: ThrottleOptions) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastAt + this.options.minIntervalMs + this.jitter() - Date.now();
      if (wait > 0) await delay(wait);
      try {
        return await operation();
      } finally {
        this.lastAt = Date.now();
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  backoff(attempt: number): number {
    return this.options.backoffBaseMs * 2 ** Math.max(0, attempt - 1) + this.jitter();
  }

  get maxRetries(): number {
    return this.options.maxRetries;
  }

  private jitter(): number {
    return Math.floor(Math.random() * (this.options.jitterMs + 1));
  }
}
