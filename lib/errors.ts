export const UpstreamErrorKind = {
  Network: 'network',
  Timeout: 'timeout',
  RateLimited: 'rate_limited',
  Auth: 'auth',
  NotFound: 'not_found',
  Server: 'server',
  Client: 'client',
  Malformed: 'malformed',
} as const;
export type UpstreamErrorKind = typeof UpstreamErrorKind[keyof typeof UpstreamErrorKind];

export interface ErrorClassification {
  kind: UpstreamErrorKind;
  status: number | null;
  message: string;
  retryable: boolean;
}

export interface ClientErrorMapping {
  status: number;
  type: string;
  message: string;
}

const retryability: Readonly<Record<UpstreamErrorKind, boolean>> = {
  [UpstreamErrorKind.Network]: true,
  [UpstreamErrorKind.Timeout]: true,
  [UpstreamErrorKind.RateLimited]: true,
  [UpstreamErrorKind.Auth]: false,
  [UpstreamErrorKind.NotFound]: false,
  [UpstreamErrorKind.Server]: true,
  [UpstreamErrorKind.Client]: false,
  [UpstreamErrorKind.Malformed]: false,
};

function recordOf(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageFrom(body: unknown): string | null {
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return null;
    try {
      return messageFrom(JSON.parse(text));
    } catch {
      return text.slice(0, 500);
    }
  }
  if (!recordOf(body)) return null;
  const error = recordOf(body.error) ? body.error : body;
  for (const key of ['message', 'detail', 'error_description', 'type', 'code']) {
    if (typeof error[key] === 'string' && error[key].trim() !== '') return error[key].trim().slice(0, 500);
  }
  return null;
}

export function classifyUpstreamError(status: number | null, body?: unknown): ErrorClassification {
  const message = messageFrom(body) ?? (status === null ? 'upstream network failure' : `upstream answered HTTP ${status}`);
  let kind: UpstreamErrorKind;
  if (status === null) kind = UpstreamErrorKind.Network;
  else if (status === 408 || status === 504) kind = UpstreamErrorKind.Timeout;
  else if (status === 429) kind = UpstreamErrorKind.RateLimited;
  else if (status === 401 || status === 403) kind = UpstreamErrorKind.Auth;
  else if (status === 404 || status === 410) kind = UpstreamErrorKind.NotFound;
  else if (status >= 500) kind = UpstreamErrorKind.Server;
  else if (status >= 400) kind = UpstreamErrorKind.Client;
  else if (body !== undefined && typeof body === 'string' && body.trim() !== '' && messageFrom(body) === body.trim().slice(0, 500)) kind = UpstreamErrorKind.Malformed;
  else kind = UpstreamErrorKind.Malformed;
  return { kind, status, message, retryable: retryability[kind] };
}

export function isRetryableKind(kind: UpstreamErrorKind): boolean {
  return retryability[kind];
}

export function retryabilityTable(): Readonly<Record<UpstreamErrorKind, boolean>> {
  return retryability;
}

export function mapErrorToClient(kind: UpstreamErrorKind, message: string, api: 'openai' | 'anthropic' = 'openai'): ClientErrorMapping {
  const common: Record<UpstreamErrorKind, Omit<ClientErrorMapping, 'message'>> = {
    [UpstreamErrorKind.Network]: { status: 502, type: 'upstream_error' },
    [UpstreamErrorKind.Timeout]: { status: 504, type: 'upstream_timeout' },
    [UpstreamErrorKind.RateLimited]: { status: 429, type: 'rate_limit_error' },
    [UpstreamErrorKind.Auth]: { status: 502, type: 'upstream_auth_error' },
    [UpstreamErrorKind.NotFound]: { status: 502, type: 'upstream_not_found' },
    [UpstreamErrorKind.Server]: { status: 502, type: 'upstream_server_error' },
    [UpstreamErrorKind.Client]: { status: 502, type: 'upstream_client_error' },
    [UpstreamErrorKind.Malformed]: { status: 502, type: 'upstream_malformed_response' },
  };
  const mapped = common[kind];
  return {
    ...mapped,
    type: api === 'anthropic' ? mapped.type.replace('upstream_', 'upstream_') : mapped.type,
    message: message || `upstream ${kind.replace('_', ' ')} error`,
  };
}

const recorded = new Map<string, ErrorClassification[]>();

export function recordUpstreamError(providerId: string, model: string, classification: ErrorClassification): void {
  const key = `${providerId}\u0000${model}`;
  const history = recorded.get(key) ?? [];
  history.push(classification);
  recorded.set(key, history);
}

export function upstreamErrorHistory(providerId: string, model: string): readonly ErrorClassification[] {
  return [...(recorded.get(`${providerId}\u0000${model}`) ?? [])];
}
