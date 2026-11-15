export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  inFlight: number;
}

export interface ResponseCacheOptions {
  ttlMs?: number;
  maxSize?: number;
  now?: () => number;
}

export interface ResponseCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  getOrLoad(key: string, loader: () => Promise<T>, shouldStore?: (value: T) => boolean): Promise<T>;
  stats(): CacheStats;
  clear(): void;
}

export function createResponseCache<T>(options: ResponseCacheOptions = {}): ResponseCache<T> {
  const ttlMs = Math.max(0, options.ttlMs ?? 30_000);
  const maxSize = Math.max(1, Math.floor(options.maxSize ?? 256));
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const inFlight = new Map<string, Promise<T>>();
  let hits = 0;
  let misses = 0;

  const get = (key: string): T | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };

  const set = (key: string, value: T): void => {
    if (ttlMs === 0) return;
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxSize) entries.delete(entries.keys().next().value as string);
  };

  return {
    get,
    set,
    async getOrLoad(key, loader, shouldStore = () => true) {
      const cached = get(key);
      if (cached !== undefined) {
        hits += 1;
        return cached;
      }
      misses += 1;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const request = loader().then((value) => {
        if (shouldStore(value)) set(key, value);
        return value;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, request);
      return request;
    },
    stats: () => ({ hits, misses, size: entries.size, inFlight: inFlight.size }),
    clear() {
      entries.clear();
      inFlight.clear();
      hits = 0;
      misses = 0;
    },
  };
}
