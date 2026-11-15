export interface ProviderCandidate<T> {
  providerId: string;
  model: string;
  value: T;
}

export interface ProviderHealth {
  successes: number;
  failures: number;
  cooldownRequests: number;
}

export interface ProviderRouter<T> {
  advanceRequest(): void;
  select(model: string, candidates: readonly ProviderCandidate<T>[]): ProviderCandidate<T> | null;
  ordered(model: string, candidates: readonly ProviderCandidate<T>[]): ProviderCandidate<T>[];
  record(providerId: string, succeeded: boolean, model?: string): void;
  health(providerId: string): ProviderHealth;
  healthForModel(model: string, providerId: string): ProviderHealth;
}

export interface RouterOptions {
  cooldownRequests?: number;
  providerOrder?: readonly string[];
}

export function createProviderRouter<T>(options: RouterOptions = {}): ProviderRouter<T> {
  const cooldownLength = Math.max(1, Math.floor(options.cooldownRequests ?? 2));
  const order = new Map((options.providerOrder ?? []).map((providerId, index) => [providerId, index]));
  const states = new Map<string, ProviderHealth>();
  const modelStates = new Map<string, ProviderHealth>();
  const modelKey = (model: string, providerId: string) => `${model}\u0000${providerId}`;
  const stateFor = (providerId: string): ProviderHealth => {
    let state = states.get(providerId);
    if (!state) {
      state = { successes: 0, failures: 0, cooldownRequests: 0 };
      states.set(providerId, state);
    }
    return state;
  };

  const stateForModel = (model: string, providerId: string): ProviderHealth => {
    const key = modelKey(model, providerId);
    let state = modelStates.get(key);
    if (!state) {
      state = { successes: 0, failures: 0, cooldownRequests: 0 };
      modelStates.set(key, state);
    }
    return state;
  };

  const ordered = (model: string, candidates: readonly ProviderCandidate<T>[]) => candidates
    .filter((candidate) => model === '*' || candidate.model === model)
    .sort((a, b) => {
      const am = stateForModel(model === '*' ? a.model : model, a.providerId);
      const bm = stateForModel(model === '*' ? b.model : model, b.providerId);
      const aScore = am.successes - am.failures;
      const bScore = bm.successes - bm.failures;
      if (aScore !== bScore) return bScore - aScore;
      const ag = stateFor(a.providerId);
      const bg = stateFor(b.providerId);
      const agScore = ag.successes - ag.failures;
      const bgScore = bg.successes - bg.failures;
      if (agScore !== bgScore) return bgScore - agScore;
      const aCooling = stateFor(a.providerId).cooldownRequests > 0;
      const bCooling = stateFor(b.providerId).cooldownRequests > 0;
      if (aCooling !== bCooling) return aCooling ? 1 : -1;
      return (order.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.providerId) ?? Number.MAX_SAFE_INTEGER);
    });

  return {
    advanceRequest() {
      for (const state of states.values()) if (state.cooldownRequests > 0) state.cooldownRequests -= 1;
      for (const state of modelStates.values()) if (state.cooldownRequests > 0) state.cooldownRequests -= 1;
    },
    ordered,
    select(model, candidates) {
      return ordered(model, candidates).find((candidate) => stateFor(candidate.providerId).cooldownRequests === 0 && stateForModel(model, candidate.providerId).cooldownRequests === 0) ?? null;
    },
    record(providerId, succeeded, model = '*') {
      const state = stateFor(providerId);
      if (succeeded) {
        state.successes += 1;
        state.failures = 0;
        state.cooldownRequests = 0;
      } else {
        state.failures += 1;
        state.cooldownRequests = cooldownLength + 1;
      }
      const modelState = stateForModel(model, providerId);
      if (succeeded) { modelState.successes += 1; modelState.failures = 0; modelState.cooldownRequests = 0; }
      else { modelState.failures += 1; modelState.cooldownRequests = cooldownLength + 1; }
    },
    health(providerId) {
      return { ...stateFor(providerId) };
    },
    healthForModel(model, providerId) {
      return { ...stateForModel(model, providerId) };
    },
  };
}
