# Operations Guide

This guide covers local and single-node operation for AI Developer Onboarding Copilot. It focuses on the runtime surfaces that now carry user identity, long-term memory, LangGraph audit data, and safety telemetry.

## Runtime Profile

- Node.js 24 or newer is required because confirmed long-term memory uses the built-in `node:sqlite` module.
- The app is a single Node.js HTTP server started with `npm run dev` or `npm start`.
- Default runtime files live under `data/`.
- `data/store.json` stores projects, answers, feedback, memory suggestions, auth audit events, local auth users, local auth token hashes, and harness run summaries.
- `data/memory.sqlite` stores confirmed long-term memory, embedding metadata, schema migration audit rows, and LangGraph checkpoint summaries.

## Required Setup

```bash
npm ci
npm test
npm start
```

Use `.nvmrc` when a local Node version manager is available. CI uses the same Node major version.

## Environment Variables

| Variable | Operational use |
| --- | --- |
| `PORT` / `HOST` | Bind address for the HTTP server. |
| `DATA_DIR` | Directory for runtime JSON and SQLite files. Prefer a persistent volume outside the repo for deployed instances. |
| `STORE_PATH` | Exact JSON store path. Use this when multiple instances need isolated stores on one host. |
| `MEMORY_DB_PATH` | Exact SQLite path for confirmed long-term memory and checkpoint summaries. |
| `AI_PM_AUTH_REQUIRED` | Set to `true` for non-local environments. |
| `AI_PM_USER_TOKENS` | Bootstrap token configuration. Prefer one admin bootstrap token, then create local store-backed users through the auth API. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | Optional OpenAI-compatible chat model configuration. Without these, the app uses deterministic fallback. `OPENAI_MODEL`/`OPENAI_TEMPERATURE` are the shared default used by `/api/chat` and by any agent role without its own override. |
| `OPENAI_MODEL_SUPERVISOR`, `OPENAI_MODEL_IMPACT_ANALYST`, `OPENAI_MODEL_QA_CRITIC` | Optional per-role chat completion model override for the Supervisor, ImpactAnalyst, and QACritic agents. Unset falls back to `OPENAI_MODEL`. |
| `OPENAI_TEMPERATURE`, `OPENAI_TEMPERATURE_SUPERVISOR`, `OPENAI_TEMPERATURE_IMPACT_ANALYST`, `OPENAI_TEMPERATURE_QA_CRITIC` | Shared default and optional per-role sampling temperature override for the same three agent roles. Unset falls back to `OPENAI_TEMPERATURE`, then the built-in default. |
| `LLM_REQUEST_TIMEOUT_MS` | Per-model-call timeout. Invalid values fall back to a finite default. |
| `LLM_CONTEXT_TOKEN_BUDGET` | Estimated prompt context budget before model calls are skipped and deterministic fallback is used. |
| `AGENT_MAX_REVISION_ROUNDS` | Maximum number of bounded QACritic revise rounds (`qa_plan` verdict `"revise"` loops back to `retrieve`). Default `1`; `0` disables the revise cycle. Also scales LangGraph's internal `recursionLimit`. |
| `MEMORY_EMBEDDING_PROVIDER` | Set to `openai` to use an OpenAI-compatible embedding endpoint. |
| `MEMORY_VECTOR_INDEX_PROVIDER` | Optional external vector index: `http`, `qdrant`, or `pinecone`. SQLite remains the source of record. |

## Authentication Operations

For non-local use, enable token auth:

```bash
AI_PM_AUTH_REQUIRED=true
AI_PM_USER_TOKENS='{"bootstrap-token":{"userId":"admin","role":"admin","scopes":["*"]}}'
```

Operational rules:

- `/api/health` stays public and reports whether auth is required without exposing token values.
- `AI_PM_USER_TOKENS` is best used for a small bootstrap/admin boundary.
- `POST /api/auth/users` creates or updates local store-backed users and can issue a one-time visible token.
- Store-backed tokens are saved as SHA-256 hashes with a short prefix for audit display; plaintext tokens are not persisted.
- `POST /api/auth/users/disable` disables a local user and all store-backed tokens for that user.
- `/api/auth/events` should be checked after auth changes or suspicious requests.
- This is not password login, session management, OAuth, SSO, or RBAC administration UI.

## Memory Operations

Confirmed long-term memory is stored in SQLite, not just `store.json`.

Useful endpoints:

- `GET /api/memory/status`: counts, migration status, FTS status, embedding coverage, and database size without returning memory content.
- `GET /api/memory`: inspect confirmed preferences, memory suggestions, audit events, and long-term memory for the resolved user.
- `POST /api/memory/backup`: create a same-directory SQLite backup and return a SHA-256 checksum.
- `GET /api/memory/backups`: list available backup basenames.
- `POST /api/memory/restore-plan`: validate a backup and return a manual rollback plan without mutation.
- `POST /api/memory/restore`: restore only with matching SHA-256 and `confirm: "RESTORE_MEMORY_DATABASE"`.

Backup guidance:

- Run `POST /api/memory/backup` before upgrades and before risky maintenance.
- Store the returned checksum with the backup filename.
- Do not copy only `memory.sqlite` while the server is writing unless the backup endpoint or an equivalent SQLite-safe checkpoint is used.
- Back up `store.json` together with `memory.sqlite`; user ids, suggestions, auth metadata, answers, and harness snapshots span both stores.

## Vector Memory Operations

SQLite is the durable source of record. External vector indexes are acceleration/recall layers.

- `MEMORY_EMBEDDING_PROVIDER=openai` enables external embedding generation.
- `MEMORY_VECTOR_INDEX_PROVIDER=http` uses generic `/upsert` and `/query`.
- `MEMORY_VECTOR_INDEX_PROVIDER=qdrant` uses Qdrant collection point upsert/search APIs.
- `MEMORY_VECTOR_INDEX_PROVIDER=pinecone` uses Pinecone index host upsert/query APIs.
- External embedding or vector-index failures fall back to local SQLite memory ranking.
- Treat vector index data as derived data; rebuild from SQLite if needed rather than treating it as the only memory store.

## LangGraph And Harness Operations

- `/api/agent-impact` creates a LangGraph harness run with trace, safety, memory, fallback, and checkpointing metadata.
- `/api/agent-impact/stream` runs the exact same workflow but streams per-node progress as Server-Sent Events (`workflow_started`/`node_completed`/`revise_round_entered`/`hitl_paused`/`final`) instead of returning one response; a client disconnect aborts the in-flight LangGraph run via the same `AbortController` the request timeout uses, and skips writing a partial record.
- A bounded QACritic revise round (`qa_plan` verdict `"revise"` looping back to `retrieve`, capped by `AGENT_MAX_REVISION_ROUNDS`) can re-run up to 4 nodes before reaching `guardrails`; this scales LangGraph's own `recursionLimit` as well as the harness step budget so a healthy run that used its revise budget is not flagged as over budget.
- `langgraph_checkpoints` stores compact checkpoint summaries for audit and replay.
- `langgraph_checkpoint_payloads` stores sanitized MemorySaver payloads used for executable checkpoint continuation.
- `GET /api/harness-run` returns the saved harness run plus recent checkpoint summaries.
- `GET /api/langgraph-checkpoint` returns one read-only checkpoint summary and whether executable resume payloads are available.
- `GET /api/langgraph-replay` reconstructs the checkpoint timeline without invoking the graph, tools, or model.
- `POST /api/langgraph-resume` reports one of three modes as `harness.resume.mode`: `native_interrupt_resume` (a decision was supplied and a checkpoint payload exists — resumes the same paused execution via `Command({ resume: decision })`), `checkpoint_continuation` (no decision supplied — replays the paused checkpoint), or `input_snapshot_reexecution` (no checkpoint payload survives — legacy fallback).

Current resume boundary:

- Runtime `store` is kept out of graph state before executable checkpoint payloads are persisted.
- When a HITL `decision` is supplied and a checkpoint payload exists, resume clones the source MemorySaver payload into a new harness run thread and invokes LangGraph with `Command({ resume: decision })` against the thread's latest checkpoint (`native_interrupt_resume`) — only `human_review` and `synthesize` re-run.
- Without a `decision`, resume instead clones the payload and invokes LangGraph pinned to the selected `checkpoint_id` (`checkpoint_continuation`), which stays paused.
- Older runs that do not have `langgraph_checkpoint_payloads` fall back to input-snapshot re-execution and report `harness.resume.mode=input_snapshot_reexecution`.
- Checkpoint audit and replay endpoints remain read-only; only `POST /api/langgraph-resume` executes continuation.

## Safety Operations

- `/api/health` exposes the active safety policy summary.
- Safety checks cover prompt injection, secret requests, write-tool intent, retrieved-context prompt injection, sensitive repository content, missing citations, uncited impact areas, sensitive output, and overconfidence.
- Repository content is treated as untrusted evidence and is not promoted into system instructions.
- The runtime tool policy is read-only: no shell execution, repository writes, automatic commits, pushes, or external network tools through the agent workflow.
- Review `recent_safety_events`, `safety_risk_counts`, and `guardrail hits` in `/api/evaluation` after imports and red-team runs.

## Upgrade Checklist

1. Pull the new code and run `npm ci`.
2. Run `npm test`.
3. Back up `store.json`.
4. Call `POST /api/memory/backup` and keep the returned checksum.
5. Start the server with the intended `DATA_DIR`, `STORE_PATH`, and `MEMORY_DB_PATH`.
6. Check `GET /api/health` for Node runtime, auth requirement, LLM config, memory database status, and schema migration audit.
7. Import or open a project, run `/api/agent-impact`, then verify `/api/evaluation` includes recent harness, memory, safety, and checkpoint metrics.

## Incident Checklist

- Auth failure spike: check `/api/auth/events`, verify token scope, disable affected local users if needed.
- Memory corruption or bad migration: stop writes, call `GET /api/memory/backups`, validate with `POST /api/memory/restore-plan`, then restore only with checksum confirmation.
- LLM instability: unset `OPENAI_API_KEY` or lower context budget pressure; deterministic fallback keeps core workflows usable.
- Vector index outage: leave SQLite online; external vector failures should fall back locally.
- Safety regression: run `npm run test:safety` and inspect `/api/evaluation` safety metrics for the affected project.

## Verification Commands

```bash
node --check server.js
npm run test:static
npm run test:auth
npm run test:memory
npm run test:safety
npm test
```

For GitHub-hosted work, CI must pass `npm ci` and `npm test` on `main` or pull requests before treating the build as verified.
