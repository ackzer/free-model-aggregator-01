// free-model-aggregator-01's starter kit: one server, two client wires, a directory of free providers.
//
// This is a working entry to start from, not a competitive answer. It is the house baseline for the
// bounty, deliberately weak, and worth roughly a quarter of the score: use it to see the shape of a
// trial, then replace its routing and its wires with your own. The gaps are marked TODO below.
//
// WHAT A TRIAL GIVES YOU
//   A trial gives this server a brief and an env, and runs it as `node /bot/main.ts` from your
//   repository's root, with Node 22's standard library alone (nothing is installed; TypeScript runs
//   directly, and a relative import needs its .ts extension). The brief is at the path in
//   $MAKEFUN_PROMPT_FILE. It carries three JSON documents:
//     - the provider directory: ten simulated free-tier providers, each with its id, wire (openai,
//       anthropic or gemini), auth scheme, key environment variable, the key the service takes, and the
//       base path you join to $MAKEFUN_ENV_URL;
//     - the quality table: every model's public rating and what it can do (tools, vision, JSON mode,
//       context length), and whether it is free;
//     - the workload manifest: the twenty requests the client will send, in order, with each one's api,
//       whether it streams, its weight and the requirements a model must meet to serve it.
//   The env is at $MAKEFUN_ENV_URL and serves the providers under their base paths. This server reads
//   the brief, probes each provider's catalog route in the provider's own wire, builds one catalog, then:
//     1. listens on 0.0.0.0 at a free port (never 8080: the env itself is there on one layout);
//     2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port": <port>, "catalog": <catalog>};
//     3. serves the client's requests: GET /v1/models (answering in the shape of the auth header it got:
//        x-api-key means Anthropic, Authorization means OpenAI), POST /v1/chat/completions and POST
//        /v1/messages, each with a JSON body or with server-sent events;
//     4. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the env says {"done": true}. A
//        process still running when the wall ends scores zero, so never wait for anything else.
//   `node main.ts --list` prints the same catalog JSON and exits 0 before any server starts; the register
//   body's catalog must be that same document. Build it once, as this file does, and use the one object.
//
// THE BASELINE'S WEAKNESSES (each is a scoring component you can win)
//   - quality (60%): it ignores the quality table's ratings. It takes the first provider, in the brief's
//     order, that lists a free model meeting the request's requirements, and that provider's first model
//     by id. A paid model is never a legal pick and is never chosen (its free flag is false). TODO: rank
//     the free candidates by rating_milli at the request's requirements and prefer the best.
//   - failover (10%): a provider call that answers 402, 429 or a 5xx is forwarded as it is. TODO: retry
//     the request on the next free model that meets it, and count the call it cost.
//   - served (15%): with no failover and one provider per requirement, a provider that is out of budget
//     takes every request routed to it down with it. TODO: spread calls over providers under their
//     per-trial budgets.
//   - the wires: only openai-wire providers can serve a chat call; an anthropic-wire or gemini-wire
//     provider answers 501 here. The catalog probe already speaks all three wires. TODO: build the other
//     two upstream requests and their event shapes.
//   - the catalog (5%): the probe reports what each listing said, with the quality table's free flag and
//     capabilities where it has a row; a listing that hides its prices leaves the row short.
//   The trial's rules are in the kit's RULES.txt; read them for the score's columns and the tie-break.
//
// FILES
//   main.ts            this server: the brief, the catalog, the routes, the register and the poll.
//   lib/providers.ts   the brief's types and parser, the auth headers, the catalog probe.
//   lib/wire.ts        Anthropic <-> Chat Completions translation and the SSE writers.
//   LICENSE            MIT: keep it or replace it with another OSI-approved license.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  authHeaders,
  buildCatalog,
  capabilitiesOf,
  isRecord,
  joinBase,
  meetsRequirements,
  modelFree,
  probeProvider,
  ratingOfModel,
  readBrief,
  type CatalogReport,
  type Json,
  type Probe,
  type ProbedModel,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIModelList,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';
import { createProviderRouter } from './lib/router.ts';
import { retryWithBackoff } from './lib/retry.ts';
import { createResponseCache } from './lib/cache.ts';
import { buildCacheKey } from './lib/normalize.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** How long one provider's catalog probe may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 5000;
/** The most bytes of one client request body this baseline reads. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: CatalogReport = { providers: [] };
/** How many client API requests have arrived: the manifest is in arrival order, one request at a time. */
let manifestIndex = 0;
let currentRequestId: string | undefined;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** Probe every provider and build the one catalog (the `--list` document and the register body). */
async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(brief.directory.providers.map((provider) => probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS)));
  for (const probe of probes) if (!probe.ok && probe.error !== null) log(probe.error);
  catalog = buildCatalog(ENV_URL, probes, brief.ratings);
  planRoutes();
}

const byId = (a: ProbedModel, b: ProbedModel): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The free models across the providers that answered, in the brief's provider order: what GET /v1/models lists. */
function servedModels(): ServedModel[] {
  const out: ServedModel[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort(byId)) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}

interface Route {
  probe: Probe;
  model: ProbedModel;
}

/**
 * The provider and model that serve one request. TODO(quality): rank every free candidate that meets the
 * requirements by the quality table's rating_milli (quality is 60% of the score) and plan each provider's
 * per-trial budget. This baseline takes the first provider, in the brief's order, whose listing answered
 * with a free model meeting the requirements, and that provider's first model by id.
 */
interface Candidate extends Route { rating: number }
const providerRouter = createProviderRouter<Candidate>({ cooldownRequests: 2, providerOrder: brief.directory.providers.map((provider) => provider.id) });
const responseCache = createResponseCache<{ status: number; statusText: string; headers: [string, string][]; body: Uint8Array }>({ maxHits: 32, maxSize: 128 });
let routePlan = new Map<string, Candidate>();
function candidatesFor(requires: Requirement): Candidate[] {
  const out: Candidate[] = [];
  for (const probe of probes) for (const model of probe.ok ? probe.models : []) {
    const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
    if (modelFree(model, row) && meetsRequirements(requires, capabilitiesOf(model, row))) out.push({ probe, model, rating: row?.rating_milli ?? 0 });
  }
  return out.sort((a, b) => b.rating - a.rating || a.probe.provider.id.localeCompare(b.probe.provider.id) || byId(a.model, b.model));
}
function openAICompatibleFor(probe: Probe, model: ProbedModel): boolean {
  const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
  const caps = capabilitiesOf(model, row);
  if (currentRequestRequiresJson && probe.provider.wire === 'gemini') return caps.json === true;
  return true;
}
let currentRequestRequiresJson = false;
function planRoutes(): void {
  const plan = new Map<string, Candidate>();
  const load = new Map<string, number>();
  for (const entry of brief.workload?.manifest ?? []) {
    currentRequestRequiresJson = entry.requires.json === true;
    const ranked = candidatesFor(entry.requires).filter((c) => openAICompatibleFor(c.probe, c.model)).sort((a, b) => ((load.get(a.probe.provider.id) ?? 0) - (load.get(b.probe.provider.id) ?? 0)) || b.rating - a.rating || a.probe.provider.id.localeCompare(b.probe.provider.id));
    const chosen = ranked[0];
    if (chosen) { plan.set(entry.id, chosen); load.set(chosen.probe.provider.id, (load.get(chosen.probe.provider.id) ?? 0) + 1); }
  }
  routePlan = plan;
}
function routeFor(requires: Requirement, requestId?: string, excluded = new Set<string>()): Route | null {
  currentRequestRequiresJson = requires.json === true;
  const planned = requestId ? routePlan.get(requestId) : undefined;
  if (planned && !excluded.has(planned.probe.provider.id)) {
    const plannedHealth = providerRouter.healthForModel(planned.model.id, planned.probe.provider.id);
    if (plannedHealth.cooldownRequests === 0 && providerRouter.health(planned.probe.provider.id).cooldownRequests === 0) return planned;
  }
  const candidates = candidatesFor(requires).filter((candidate) => !excluded.has(candidate.probe.provider.id) && openAICompatibleFor(candidate.probe, candidate.model));
  return providerRouter.select('*', candidates.map((candidate) => ({ providerId: candidate.probe.provider.id, model: candidate.model.id, value: candidate })))?.value ?? null;
}

/** The requirements of the request now arriving: the manifest's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const manifest = brief.workload?.manifest ?? [];
  const entry = manifest[manifestIndex];
  manifestIndex += 1;
  currentRequestId = entry?.id;
  if (entry !== undefined) return entry.requires;
  // TODO(workload): the manifest is the declared source of each request's requirements; this fallback is a
  // guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the manifest has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST one request to the routed provider's Chat Completions route. */
async function callProvider(route: Route, body: Json, api: 'openai' | 'anthropic'): Promise<Response> {
  const base = joinBase(ENV_URL, route.probe.provider.base);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...authHeaders(route.probe.provider.auth, route.probe.provider.key),
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  if (route.probe.provider.wire === 'openai') {
    const request = api === 'anthropic' ? anthropicToOpenAI(body, route.model.id) : { ...body, model: route.model.id };
    return fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(request) });
  }
  if (route.probe.provider.wire === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    const anthropicBody = api === 'anthropic' ? { ...body, model: route.model.id } : openAIToAnthropic(body, route.model.id);
    return fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(anthropicBody) });
  }

  const canonicalBody = api === 'anthropic' ? anthropicToOpenAI(body, route.model.id) : body;
  const messages = Array.isArray(canonicalBody.messages) ? canonicalBody.messages : [];
  const contents: Json[] = [];
  let systemText = '';
  let imageUrl: string | null = null;
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system' || raw.role === 'developer') {
      if (typeof raw.content === 'string') systemText += `${raw.content}\n`;
      continue;
    }
    const parts: Json[] = [];
    const addContent = (content: unknown) => {
      if (typeof content === 'string') parts.push({ text: content });
      else if (Array.isArray(content)) for (const block of content) {
        if (!isRecord(block)) continue;
        if (typeof block.text === 'string') parts.push({ text: block.text });
        if (block.type === 'image_url' && isRecord(block.image_url) && typeof block.image_url.url === 'string') {
          const url = block.image_url.url;
          const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          else { imageUrl = url; parts.push({ fileData: { mimeType: 'image/*', fileUri: url } }); }
        }
      }
    };
    addContent(raw.content);
    if (Array.isArray(raw.tool_calls)) for (const call of raw.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      let args: unknown = {};
      try { args = JSON.parse(String(call.function.arguments ?? '{}')); } catch { args = {}; }
      parts.push({ functionCall: { name: call.function.name, args } });
    }
    if (raw.role === 'tool') parts.push({ functionResponse: { name: raw.name ?? 'tool', response: { content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? '') } } });
    contents.push({ role: raw.role === 'assistant' ? 'model' : 'user', parts });
  }
  const declarations: Json[] = [];
  if (Array.isArray(canonicalBody.tools)) for (const raw of canonicalBody.tools) {
    if (isRecord(raw) && isRecord(raw.function)) declarations.push({ name: raw.function.name, description: raw.function.description, parameters: raw.function.parameters });
  }
  const config: Json = {};
  if (typeof canonicalBody.max_tokens === 'number') config.maxOutputTokens = canonicalBody.max_tokens;
  if (typeof canonicalBody.temperature === 'number') config.temperature = canonicalBody.temperature;
  if (typeof canonicalBody.top_p === 'number') config.topP = canonicalBody.top_p;
  if (Array.isArray(canonicalBody.stop)) config.stopSequences = canonicalBody.stop;
  if (isRecord(canonicalBody.response_format)) config.responseMimeType = 'application/json';
  const request: Json = { contents, generationConfig: config };
  if (systemText.trim()) request.systemInstruction = { parts: [{ text: systemText.trim() }] };
  if (declarations.length) request.tools = [{ functionDeclarations: declarations }];
  const method = body.stream === true ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `${base}/v1beta/models/${encodeURIComponent(route.model.id)}:${method}`;
  if (imageUrl && !imageUrl.startsWith('data:')) headers['x-goog-api-key'] = route.probe.provider.key;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = 'cause' in error ? error.cause : undefined;
  return (error.name === 'TypeError' && /fetch failed|network error/i.test(error.message))
    || (cause instanceof Error && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].some((code) => cause.message.includes(code)));
}

/** Copy a provider's event stream to the client as it arrives. */
async function pipeStream(stream: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function normalizedAnswer(wire: string, value: Json): Json {
  if (wire === 'openai') return value;
  if (wire === 'anthropic') {
    const content = Array.isArray(value.content) ? value.content : [];
    const text = content.flatMap((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('');
    const calls = content.flatMap((block) => isRecord(block) && block.type === 'tool_use' ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }] : []);
    const usage = isRecord(value.usage) ? value.usage : {};
    const stop = value.stop_reason === 'tool_use' ? 'tool_calls' : value.stop_reason === 'max_tokens' ? 'length' : value.stop_reason === 'refusal' ? 'content_filter' : 'stop';
    return { id: value.id ?? 'chatcmpl-aggregate', object: 'chat.completion', model: value.model, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: stop }], usage: { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0) } };
  }
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.flatMap((part) => isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('');
  const calls = parts.flatMap((part, i) => isRecord(part) && isRecord(part.functionCall) ? [{ id: `call_${i}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }] : []);
  const usage = isRecord(value.usageMetadata) ? value.usageMetadata : {};
  const finish = candidate.finishReason === 'MAX_TOKENS' ? 'length' : candidate.finishReason === 'SAFETY' ? 'content_filter' : calls.length ? 'tool_calls' : 'stop';
  return { id: `chatcmpl-${String(value.modelVersion ?? 'aggregate')}`, object: 'chat.completion', model: value.modelVersion, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage: { prompt_tokens: usage.promptTokenCount ?? 0, completion_tokens: usage.candidatesTokenCount ?? 0, total_tokens: usage.totalTokenCount ?? 0 } };
}

function sseOpenAI(answer: Json, model: string): string {
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : '';
  const tokens = isRecord(answer.usage) ? answer.usage : {};
  const frame = (data: Json) => `data: ${JSON.stringify(data)}\n\n`;
  let out = frame({ id: answer.id ?? 'chatcmpl-aggregate', object: 'chat.completion.chunk', created: 1767225600, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (let at = 0; at < text.length; at += 48) out += frame({ id: answer.id ?? 'chatcmpl-aggregate', object: 'chat.completion.chunk', created: 1767225600, model, choices: [{ index: 0, delta: { content: text.slice(at, at + 48) }, finish_reason: null }] });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]; if (!isRecord(call) || !isRecord(call.function)) continue;
    out += frame({ id: answer.id ?? 'chatcmpl-aggregate', object: 'chat.completion.chunk', created: 1767225600, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }] }, finish_reason: null }] });
  }
  out += frame({ id: answer.id ?? 'chatcmpl-aggregate', object: 'chat.completion.chunk', created: 1767225600, model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] });
  if (Number(tokens.total_tokens) >= 0) out += frame({ id: answer.id ?? 'chatcmpl-aggregate', object: 'chat.completion.chunk', created: 1767225600, model, choices: [], usage: tokens });
  return out + 'data: [DONE]\n\n';
}

async function parseOpenAIStream(text: string): Promise<Json> {
  const content: string[] = [];
  let finish_reason: unknown = 'stop';
  let usage: Json = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const chunk: unknown = JSON.parse(payload);
      if (!isRecord(chunk)) continue;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : {};
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === 'string') content.push(delta.content);
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish_reason = choice.finish_reason;
      if (isRecord(chunk.usage)) usage = chunk.usage;
    } catch {
      // Ignore comments and malformed provider frames.
    }
  }
  return { id: 'chatcmpl-aggregate', choices: [{ index: 0, message: { role: 'assistant', content: content.join('') }, finish_reason }], usage };
}

async function callWithFailover(requires: Requirement, body: Json, api: 'openai' | 'anthropic', requestId?: string): Promise<{ route: Route; response: Response } | null> {
  const excluded = new Set<string>();
  const first = routeFor(requires, requestId);
  const ranked = [...(first ? [first] : []), ...candidatesFor(requires).filter((candidate) => candidate.probe.provider.id !== first?.probe.provider.id)];
  const ordered = providerRouter.ordered('*', ranked.map((candidate) => ({ providerId: candidate.probe.provider.id, model: candidate.model.id, value: candidate }))).filter((candidate) => providerRouter.health(candidate.providerId).cooldownRequests === 0 && providerRouter.healthForModel(candidate.model, candidate.providerId).cooldownRequests === 0).map((candidate) => candidate.value);
  for (const route of ordered) {
    if (excluded.has(route.probe.provider.id)) continue;
    excluded.add(route.probe.provider.id);
    try {
      const cacheKey = buildCacheKey(route.probe.provider.id, api, route.model.id, body);
      const loadSnapshot = async () => {
        const response = await retryWithBackoff(async () => {
          return callProvider(route, body, api);
        }, { attempts: 2, shouldRetry: isNetworkError });
        return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: new Uint8Array(await response.arrayBuffer()) };
      };
      if (body.stream === true) {
        const response = await retryWithBackoff(async () => {
          return callProvider(route, body, api);
        }, { attempts: 2, shouldRetry: isNetworkError });
        providerRouter.record(route.probe.provider.id, response.ok, route.model.id);
        if (response.ok) return { route, response };
        continue;
      }
      const cached = await responseCache.getOrLoad(cacheKey, loadSnapshot, (snapshot) => snapshot.status >= 200 && snapshot.status < 300);
      const response = new Response(cached.body.slice(), { status: cached.status, statusText: cached.statusText, headers: cached.headers });
      providerRouter.record(route.probe.provider.id, response.ok, route.model.id);
      if (response.ok) return { route, response };
    } catch {
      providerRouter.record(route.probe.provider.id, false, route.model.id);
      // A failed provider is exhausted for this request; continue in rating order.
    }
  }
  return null;
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by an openai-wire provider. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const requestId = currentRequestId;
  const result = await callWithFailover(requires, body, 'openai', requestId);
  providerRouter.advanceRequest();
  if (!result) return sendError(res, 'openai', 503, 'no_free_model', 'all free providers refused this request');
  const { route, response } = result;
  const upstream = response.headers.get('content-type')?.includes('text/event-stream')
    ? normalizedAnswer(route.probe.provider.wire, await parseOpenAIStream(await response.text()))
    : normalizedAnswer(route.probe.provider.wire, await response.json() as Json);
  const model = route.model.id;
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.end(sseOpenAI(upstream, model));
  } else sendJson(res, 200, { ...upstream, model });
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to an openai-wire provider and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const requestId = currentRequestId;
  const result = await callWithFailover(requires, body, 'anthropic', requestId);
  providerRouter.advanceRequest();
  if (!result) return sendError(res, 'anthropic', 503, 'overloaded_error', 'all free providers refused this request');
  const { route, response } = result;
  const answer = normalizedAnswer(route.probe.provider.wire, response.headers.get('content-type')?.includes('text/event-stream') ? await parseOpenAIStream(await response.text()) : await response.json() as Json);
  const requested = typeof body.model === 'string' && body.model !== '' ? body.model : route.model.id;
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const output: Json = {
    id: `msg_${String(answer.id ?? 'aggregate')}`, type: 'message', role: 'assistant', model: requested,
    content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }],
    stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null,
  };
  const usage = isRecord(answer.usage) ? answer.usage : {};
  output.usage = { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 };
  if (body.stream === true) {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      const encoder = new TextEncoder();
      const text = typeof message.content === 'string' ? message.content : '';
      controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({ type:'message_start', message:{ id:output.id, type:'message', role:'assistant', model:requested, content:[], stop_reason:null, stop_sequence:null, usage:{input_tokens:usage.prompt_tokens ?? 0,output_tokens:0} } })}\n\n`));
      controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({ type:'content_block_start',index:0,content_block:{type:'text',text:''} })}\n\n`));
      if (text) controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type:'content_block_delta',index:0,delta:{type:'text_delta',text} })}\n\n`));
      controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop',index:0 })}\n\n`));
      controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({ type:'message_delta',delta:{stop_reason:output.stop_reason,stop_sequence:null},usage:{output_tokens:usage.completion_tokens ?? 0} })}\n\n`));
      controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')); controller.close();
    } });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await pipeStream(stream, res); return;
  }
  sendJson(res, 200, output);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the workload's size. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} answered providers and ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
