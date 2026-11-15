# FreeRoute Aggregator

A zero-dependency Node 22 gateway that discovers free models from OpenAI-, Anthropic-, and Gemini-wire providers, ranks them against the workload's capability requirements, and fails over when a provider refuses a call.

## Run

```powershell
node main.ts --list
node main.ts
```

During a make.fun agent trial, the environment supplies `MAKEFUN_ENV_URL` and `MAKEFUN_PROMPT_FILE`. The server reads the brief, probes provider catalogs, registers the catalog, serves OpenAI Chat Completions and Anthropic Messages (including SSE), and exits when the workload reports completion. It uses only Node's standard library and fetch.

## Design

- Deterministic capability filtering and rating-first candidate ordering.
- A stable workload planner spreads planned requests across the available provider catalog while preserving rating as the primary routing signal.
- Sequential per-request failover avoids concurrent calls and never routes a model marked paid.
- Provider-specific auth and native OpenAI, Anthropic, or Gemini request wires.
- `--list` emits the same catalog object used by `/register`.

## Local practice grading

From the unpacked competition kit, run:

```powershell
node cli/makefun.mjs grade-local --kit . --bot "C:\Users\MyBook Hype AMD\Documents\free-model-aggregator-01" --driver process --instances 3
```

The process driver is advisory and runs unisolated. Docker driver is preferred when Docker Desktop is running.

## License

MIT. See [LICENSE](LICENSE).
