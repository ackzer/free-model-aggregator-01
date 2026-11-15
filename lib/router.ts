export interface ProviderCandidate<T> {
  providerId: string;
  model: string;
  value: T;
}

export interface ProviderHealth {
  successes: number;
  failures: number;
  latencyEwmaMs: number | null;
  cooldownUntil: number;
}

export interface ProviderRouter<T> {
  select(model: string, candidates: readonly ProviderCandidate<T>[], now?: number): ProviderCandidate<T> | null;
  ordered(model: string, candidates: readonly ProviderCandidate<T>[], now?: number): ProviderCandidate<T>[];
  record(providerId: string, succeeded: boolean, latencyMs: number, now?: number): void;
  health(providerId: string): ProviderHealth;
}

export interface RouterOptions {
  ewmaAlpha?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
}

export function createProviderRouter<T>(options: RouterOptions = {}): ProviderRouter<T> {
  const alpha = options.ewmaAlpha ?? 0.25;
  const baseCooldownMs = options.baseCooldownMs ?? 500;
  const maxCooldownMs = options.maxCooldownMs ?? 30_000;
  const states = new Map<string, ProviderHealth>();
  const stateFor = (providerId: string): ProviderHealth => {
    let state = states.get(providerId);
    if (!state) {
      state = { successes: 0, failures: 0, latencyEwmaMs: null, cooldownUntil: 0 };
      states.set(providerId, state);
    }
    return state;
  };

  const ordered = (model: string, candidates: readonly ProviderCandidate<T>[], now = Date.now()) =>
    candidates.filter((candidate) => candidate.model === model)
      .sort((a, b) => {
        const ah = stateFor(a.providerId);
        const bh = stateFor(b.providerId);
        const aReady = ah.cooldownUntil <= now;
        const bReady = bh.cooldownUntil <= now;
        if (aReady !== bReady) return aReady ? -1 : 1;
        const aLatency = ah.latencyEwmaMs ?? 0;
        const bLatency = bh.latencyEwmaMs ?? 0;
        if (aLatency !== bLatency) return aLatency - bLatency;
        const aRate = ah.successes / Math.max(1, ah.successes + ah.failures);
        const bRate = bh.successes / Math.max(1, bh.successes + bh.failures);
        return bRate - aRate || a.providerId.localeCompare(b.providerId);
      });

  return {
    ordered,
    select(model, candidates, now = Date.now()) {
      return ordered(model, candidates, now).find((candidate) => stateFor(candidate.providerId).cooldownUntil <= now) ?? null;
    },
    record(providerId, succeeded, latencyMs, now = Date.now()) {
      const state = stateFor(providerId);
      const sample = Math.max(0, latencyMs);
      state.latencyEwmaMs = state.latencyEwmaMs === null ? sample : alpha * sample + (1 - alpha) * state.latencyEwmaMs;
      if (succeeded) {
        state.successes += 1;
        state.failures = 0;
        state.cooldownUntil = 0;
      } else {
        state.failures += 1;
        state.cooldownUntil = now + Math.min(maxCooldownMs, baseCooldownMs * 2 ** Math.min(state.failures - 1, 10));
      }
    },
    health(providerId) {
      return { ...stateFor(providerId) };
    },
  };
}
