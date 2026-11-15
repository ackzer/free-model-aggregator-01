export interface RetryOptions {
  attempts?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export async function retryWithBackoff<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.min(2, Math.max(1, Math.floor(options.attempts ?? 2)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || options.shouldRetry?.(error, attempt) === false) throw error;
    }
  }
  throw lastError;
}
