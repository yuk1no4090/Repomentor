# Agent Runtime Architecture

This document records the first production-shaped implementation boundary for the LangGraph, memory, harness, and AI safety upgrade.

## Scope

- The impact workflow is implemented as a LangGraph `StateGraph` with three model-backed agents: Supervisor, ImpactAnalyst, and QACritic.
- The LangGraph workflow runs with `MemorySaver` checkpointing and persists checkpoint summaries plus sanitized executable checkpoint payloads to SQLite.
- The first memory module is user preference memory only.
- The harness is the runtime boundary around model calls, graph execution, tool policy, budgets, trace, schema validation, fallback, and errors.
- AI safety is application-level guardrails. It is not a compliance certification.

## Code Organization

`server.js` is now a thin HTTP layer only: `handleApi`/`handleApiUnlocked` route dispatch, `serveStatic`, a small number of helpers that stay coupled to routing (`sendJson`, `readBody`, `findHarnessRunAudit`), and process bootstrap (wiring `setStoreRecordNormalizers()` / `setCheckpointCollaborators()`, `http.createServer`, graceful shutdown). It shrank from 6,029 lines to roughly 1,550 lines across three decomposition passes — a storage-layer pass, then two domain-layer passes — that moved logic into `lib/` with no behavior changes.

All application logic lives in 13 single-purpose modules under `lib/`:

- `lib/config.js` — env loading, all configuration constants, and the shared `apiError`/`normalizeUserId` helpers.
- `lib/store.js` — `ensureStore`/`saveStore`/`normalizeStore`/`backupCorruptStore`/`withWriteLock`, plus a resident in-memory store cache keyed on an `fs.stat` mtime+size signature.
- `lib/memory-db.js` — the SQLite long-term memory store: singleton connection, schema migrations, FTS5, embeddings, vector index adapters, CRUD, and backup/restore.
- `lib/checkpoints.js` — LangGraph checkpoint serialization, persistence, replay, and resume.
- `lib/auth.js` — token/identity resolution, auth user and event CRUD, and scope checks.
- `lib/importer.js` — repository import: ZIP parsing, GitHub fetch, `createProject`, tech-stack/tree inference, and import-time safety scanning.
- `lib/retrieval.js` — tokenization, query expansion, file chunking, and chunk retrieval.
- `lib/safety.js` — input, retrieval, and output safety scanning and redaction.
- `lib/llm.js` — model provider resolution, the direct-chat `runModelAdapter()`, and role-aware `runAgentModelAdapter()` calls.
- `lib/agent-contracts.js` — independent Supervisor/ImpactAnalyst/QACritic prompts, output validators, evidence constraints, and deterministic per-agent fallbacks.
- `lib/answers.js` — the QA/impact/onboarding deterministic answer generators, preference apply/CRUD, and memory suggestion generation.
- `lib/agent-graph.js` — `decideNextRoute`/`ROUTE_RULES`, trace and tool-registry helpers, the harness report builders (`buildAgentHarnessReport`, `buildChatHarnessReport`, `buildOnboardingHarnessReport`), the `StateGraph` node definitions, and `runAgenticImpactWorkflow`.
- `lib/metrics.js` — `computeMetrics()` and `FEEDBACK_TYPES`.

Dependencies between `lib/` modules are unidirectional and acyclic: `lib/agent-graph.js` depends on `lib/agent-contracts.js`, `lib/llm.js`, `lib/answers.js`, `lib/retrieval.js`, `lib/safety.js`, `lib/memory-db.js`, and `lib/checkpoints.js`; `lib/answers.js` depends on `lib/memory-db.js` (only `normalizeMemorySuggestion`); `lib/metrics.js` depends on `lib/agent-graph.js` (reusing `createHarnessRunSnapshot`) plus `lib/memory-db.js`, `lib/checkpoints.js`, and `lib/safety.js`; `lib/importer.js` depends on `lib/retrieval.js` and `lib/safety.js`; `lib/llm.js` depends only on `lib/config.js` and `lib/safety.js`; `lib/agent-contracts.js` is dependency-free. No `lib/` module imports back up toward `server.js`.

Two injection points keep `lib/store.js` and `lib/checkpoints.js` decoupled from the domain modules that own the record shapes they normalize or the handlers they call, avoiding circular imports: `server.js` imports the actual normalizer functions from `lib/auth.js`, `lib/answers.js`, `lib/agent-graph.js`, and `lib/memory-db.js`, then calls `setStoreRecordNormalizers()` once at bootstrap; `setCheckpointCollaborators()` similarly injects `findProject`, `findHarnessRunAudit`, and `runAgenticImpactWorkflow` (from `lib/agent-graph.js`) into `lib/checkpoints.js` before the HTTP server starts.

A `test/` directory holds 184 pure-function/unit cases across 11 files on Node's built-in `node:test` runner, including routing (including the bounded QACritic revise loop), safety, retrieval, Agent contracts, per-role model/temperature configuration, checkpoint retention, preference purity, briefing, frontend import helpers, server/lib source-comment stripping, and workflow timeout behavior. Tests import and exercise the real exported functions instead of re-implementing logic mirrors. `scripts/check-unit-tests.js` runs `node --test test/**/*.js` and is picked up automatically by `static-checks.js`'s `scripts/check-*.js` auto-discovery, so it participates in `npm test` with no separate wiring.

## Graph Nodes

### Default mode: Supervisor routing (`AGENT_GRAPH_MODE=supervisor`)

```text
START → supervisor
  supervisor → (conditional) → input_safety
  supervisor → (conditional) → memory
  supervisor → (conditional) → classify
  supervisor → (conditional) → retrieve  ─┐  (re-entered for a bounded QACritic revise round)
  supervisor → (conditional) → expand_context  │
  supervisor → (conditional) → impact_analysis │
  supervisor → (conditional) → qa_plan  ───────┘  (checkpoint-compatible node name; runs QACritic)
    qa_plan verdict="revise" (and revisionRound < AGENT_MAX_REVISION_ROUNDS) → loops back to retrieve
  supervisor → (conditional) → guardrails
  supervisor → (conditional) → human_review  (after QACritic + guardrails when HITL enabled + riskLevel=high OR supervisorPlan.require_human_review=true)
  supervisor → (conditional) → synthesize
  supervisor → (conditional) → END
```

After `input_safety` passes, the `supervisor` node invokes the Supervisor model agent once to produce `supervisorPlan` (risk hypothesis, required agents, retrieval queries, HITL recommendation). The plan changes the Retriever query. Later supervisor visits use deterministic `decideNextRoute(state)` based on graph phase and state signals so routing stays bounded and testable. The ImpactAnalyst then makes its own model call against repository evidence, and the `qa_plan` node retains its checkpoint-compatible name while acting as the independently prompted QACritic model agent. Each role has a separate schema and deterministic fallback.

#### The bounded QACritic revise cycle (the graph's one genuine loop)

Every other transition in this graph is a straight, acyclic walk through `ROUTE_RULES.phaseMap`'s 9 phases — the kind of thing a plain `for` loop could drive without a graph framework. The `retrieve ⇄ qa_plan` cycle is the exception, and the reason this workflow is a graph at all: `qa_plan` (QACritic) can send execution back to `retrieve` for one more evidence-gathering pass instead of always advancing to `guardrails`.

- **Trigger**: `qa_plan` returns `qaReview.verdict === "revise"` (the deterministic critic sets this when `impact.impact_areas` comes back empty, or when any impact area lacks cited files).
- **Bound**: `AGENT_MAX_REVISION_ROUNDS` (env-configurable via `parseNonNegativeIntegerEnv`, default `1`; `0` disables the loop entirely). `decideNextRoute` only takes the `retrieve` branch while `state.revisionRound < AGENT_MAX_REVISION_ROUNDS`; once the budget is spent, a persisting `"revise"` verdict is reported to the user instead of looping again — the run always completes.
- **Loop target and payload**: the loop always re-enters at `retrieve`, not `impact_analysis`, specifically so `qaReview.additional_queries` (previously dead data — nothing routed on `verdict` or read `additional_queries` before this) can be folded into the next retrieval pass. `retrieve` itself detects a revise-round re-entry (`state.qaReview?.verdict === "revise"`) and bumps `state.revisionRound` as part of the same state update that appends its own trace step and sets its own successor `phaseCursor` (below).
- **Explicit phase cursor, not trace bookkeeping** (Task N1): `decideNextRoute` reads its phase primarily off an explicit `phaseCursor` state channel (`cursorValue = Number.isInteger(state.phaseCursor) ? state.phaseCursor : 0`, defaulting to phase 0 for a state that never set it — the same default the channel itself uses). Each of the 9 `phaseMap` nodes sets `phaseCursor` to its own successor index as part of its own state update, via a shared helper (`nextPhaseCursor(nodeName)`) that looks the value up from `ROUTE_RULES.phaseMap` itself (`phaseMap`'s own index of that node, plus one) — so `phaseMap` stays the single authority on ordering, and no node hand-types its own successor integer. `phase` used to be *derived*: `state.trace.length - (state.revisionRound || 0) * REVISION_ROUND_NODE_COUNT`, which only stayed aligned with `phaseMap` because of an invariant nothing mechanically enforced (every revise-loop node had to append exactly one trace step, atomically with the `revisionRound` bump). Nodes now *assert* their own phase directly, so routing depends on nothing but that one explicit channel — a future node that added an early return or an extra trace step could no longer desynchronize routing by accident. On a revise round, `retrieve` and `qa_plan` call `nextPhaseCursor()` with the SAME node name whether this is the initial pass or a re-entry, so the cursor "rewinds" to each node's fixed successor with no arithmetic at all. `human_review` and `END` are deliberately outside `phaseMap` and never call `nextPhaseCursor()`: `phaseCursor` simply holds whatever `guardrails` last set it to (8) while `human_review` runs, paused or resumed, and the post-review HITL guard routes to `synthesize` unconditionally before `phase` is even consulted.
- **Legacy checkpoint migration** (found in post-N1 review, fixed before merge): a checkpoint persisted BEFORE the `phaseCursor` channel existed has no `phaseCursor` key in its serialized `channel_values` at all. LangGraph's `LastValue` channel does not restore a missing key as `undefined` — it seeds the channel from the Annotation's own default via `fromCheckpoint(undefined)` (see `node_modules/@langchain/langgraph/dist/channels/last_value.js`), which for `phaseCursor` is the LEGITIMATE integer `0`, indistinguishable from a genuinely fresh state by `cursorValue` alone. `decideNextRoute` additionally computes `traceLength = Array.isArray(state.trace) ? state.trace.length : 0` and derives phase with the pre-N1 trace-length formula whenever `cursorValue === 0 && traceLength > 0` — the ONE combination current code can never produce mid-run (every `phaseMap` node sets `phaseCursor >= 1` as part of the same update that appends its own trace step, so `cursorValue === 0` in a state current code produced implies an empty trace), so it can only mean a pre-`phaseCursor` checkpoint. This keeps `checkpoint_continuation` time-travel resume of an old, mid-graph checkpoint correct instead of silently re-executing already-completed phases; it ages out on its own once every such checkpoint has aged out of the `CHECKPOINT_MAX_RUNS` retention window. Reproduced end-to-end and proven fixed by `scripts/check-hitl-resume-behavior.js`'s phase-cursor migration step (strips `phaseCursor` from a real persisted checkpoint's every entry via direct SQLite edit, then compares a stripped-payload resume's trace against an intact-payload control).
- **Precedence**: the revise check sits strictly after the `finalPayload → END` and post-`human_review → synthesize` guards (so it can never preempt either) and strictly before the generic `phaseMap` lookup (so it only overrides the one `qa_plan → guardrails` transition).
- **Observability**: `harness.revision_rounds`, `harness.revision_max_rounds`, `harness.revision_reason`, `harness.revision_budget_exhausted`, and `harness.revision_metrics` (`pre_revision_impact_area_count`, `pre_revision_uncited_area_count`, `final_impact_area_count`, `final_uncited_area_count`) make the loop's mechanics (did it run, how many rounds, was the budget exhausted, did the cited-evidence count change) inspectable on every answer, whether or not the round actually resolved anything.
- **What `scripts/check-revise-loop.js` does and does not prove**: it is a mechanism proof, not a general answer-quality claim. Offline (no API key), the deterministic critic (`createDeterministicQaCriticReview`) can only return `verdict="revise"` when `impact.impact_areas` comes back completely empty — the deterministic impact generator never emits a non-empty area without files, so an "uncited-but-present" area is not reachable this way, and `uncited_area_count` is `0` before and after in every offline scenario. The script proves the graph genuinely cycles, that the critic's `additional_queries` genuinely reach the next retrieval pass (not dead data), and that the loop terminates on budget even when the critic never approves — plus, in one deliberately constructed fixture (a project with exactly one file discoverable only via the critic's own fixed query, not via the Supervisor's queries or the original question), that the revise round can find evidence the first pass structurally could not. That one fixture's `pre_revision_impact_area_count(0) < final_impact_area_count(1)` result is a property of how the fixture was built, not a measurement of how often real-world revise rounds improve coverage.
- **LangGraph's own `recursionLimit`**: because supervisor mode routes every real node back through the `supervisor` hub, one 9-phase walk already costs ~19 supersteps, and each revise round adds ~8 more. `AGENT_MAX_STEPS` has no relationship to this — it only bounds the harness's own reported trace-length budget — so `recursionLimit` must scale with `AGENT_MAX_REVISION_ROUNDS` instead (the thing that actually grows LangGraph's superstep count). `computeGraphRecursionLimit(AGENT_MAX_REVISION_ROUNDS)` derives it from an explicit superstep cost model (19 baseline + 8 per configured revise round + 2 for `human_review` + a 6-step margin); `runAgenticImpactWorkflow` passes `recursionLimit: computeGraphRecursionLimit(AGENT_MAX_REVISION_ROUNDS)` to `graph.invoke()`. `decideNextRoute`'s own `AGENT_MAX_REVISION_ROUNDS` bound remains the actual termination guarantee — this just keeps LangGraph's separate, lower-level ceiling from ever being the thing that cuts a legitimately bounded run short. `AGENT_BUDGETS.max_steps`'s own `step_budget_exceeded` flag is computed against an `effective_max_steps` (`AGENT_BUDGETS.max_steps + REVISION_ROUND_NODE_COUNT * AGENT_MAX_REVISION_ROUNDS`) for the same reason — a healthy run that used its configured revise-round budget must not be mislabeled as having exceeded it. `scripts/check-recursion-limit-scaling.js` proves both scale correctly at `AGENT_MAX_REVISION_ROUNDS` = 0, 1, 2, and 3.

#### Per-query retrieval (retrieve node)

`retrieve` calls `retrieveChunks()` once **per planned query** (the original question, the Supervisor's `retrieval_queries`, and — on a revise round — the QACritic's `additional_queries`) instead of joining every query into one bag-of-words string. The planned-query list is de-duplicated (`[...new Set(...)]`) before retrieval: `createDeterministicSupervisorPlan()` already puts the original question text as `retrieval_queries[0]`, so without de-duplication the question would be retrieved twice with byte-identical queries — wasted work, and a direct contradiction of "every query gets an equal turn" (a query present twice gets two turns). The per-query result lists are merged with a deterministic round-robin interleave (`interleaveChunks()`, deduped by `chunk.id`, capped at 8 — the same size the old single joined-query call produced). Joining N queries into one string dilutes each query's own discriminative terms in `lib/retrieval.js`'s TF-like scorer (term counts, phrase bonus, and path bonus are all computed against the merged term set), so a term that would rank a file #1 for its own query can get buried under terms from unrelated queries; retrieving each query independently preserves that query's intent, and round-robin interleaving (rather than concatenation or a raw cross-query score merge) guarantees no single query dominates the merged result just by scoring more chunks highly. This is a synchronous, in-memory, zero-I/O merge, so it deliberately does not use LangGraph's `Send`/fan-out API — there is nothing to parallelize.

### Linear fallback (`AGENT_GRAPH_MODE=linear`)

```text
input_safety → memory → classify → retrieve → expand_context → impact_analysis → qa_plan → guardrails → synthesize → END
```

The linear mode skips supervisor/human_review nodes entirely and is wire-compatible with pre-P2 checkpoint data.

Each node appends trace metadata so the UI can show the agent path instead of hiding the workflow.

`/api/chat` is not a LangGraph workflow. It uses a lighter `Direct Chat Harness` that reuses the same model adapter, schema validation, trace shape, deterministic fallback, confirmed `memory_used` reporting, pending `memory_suggestions`, read-only tool policy, input/retrieval/output safety reports, and guardrail detail format. This keeps the existing chat API compatible while making ordinary Q&A and standard impact analysis observable through the same harness fields.

`/api/onboarding` uses an `Onboarding Harness` around deterministic role-based plan generation. It exposes trace steps, confirmed-memory status, pending memory suggestions, citation/output safety, guardrails, budget metadata, and the same read-only tool registry so onboarding plans are visible in evaluation metrics.

## Memory Boundary

Confirmed preference memory is stored in `data/store.json` under `userPreferencesByUser`, with legacy `userPreferences` retained for the default `local-user` profile. API clients can pass `userId` in JSON bodies or `X-User-Id` / `X-AI-PM-User-Id` headers; missing values resolve to `local-user` for local/backward-compatible use. Confirmed long-term memory items are also stored in SQLite at `MEMORY_DB_PATH` under the `memory_items` table, with `memory_items.user_id` for user isolation, an FTS5 index when available, and `embedding_json` vectors for similarity ranking. By default the embedding model is `local-hash-v1`, an offline lexical vector for deterministic recall ranking. When `MEMORY_EMBEDDING_PROVIDER=openai` and an embedding API key are configured, memory write and query paths call an OpenAI-compatible `/v1/embeddings` endpoint using `OPENAI_EMBEDDING_MODEL`, with local fallback if the provider fails. When `MEMORY_VECTOR_INDEX_PROVIDER=http` and `MEMORY_VECTOR_INDEX_URL` are configured, confirmed long-term memory vectors are mirrored to an HTTP-compatible vector index via `/upsert`, and query recall calls `/query` before local SQLite vector ranking. When `MEMORY_VECTOR_INDEX_PROVIDER=qdrant`, the runtime mirrors vectors to Qdrant `/collections/{collection}/points` upsert/search endpoints and uses `MEMORY_VECTOR_INDEX_NAMESPACE` as the collection name. When `MEMORY_VECTOR_INDEX_PROVIDER=pinecone`, it mirrors vectors to Pinecone `/vectors/upsert` and `/query` endpoints on the configured index host, with the namespace passed as Pinecone namespace. Remote vector results are treated as candidate ids only; SQLite still enforces user, project, and status filtering. Each long-term memory item keeps its source `projectId` for filtering and audit. Memory suggestions carry `userId` and `projectId` so the UI and API can verify which user and project produced the suggestion before confirmation or ignore actions.

SQLite schema and data backfills are recorded in `schema_migrations`. Current audited migrations cover base memory/checkpoint tables, user-scoped memory columns, local embedding columns, legacy user backfill, user/status indexing, embedding backfill, and FTS rebuilds. `/api/health` returns the recent migration audit without exposing application data.

Non-GET API requests run through an in-process write queue before reading and saving the store. Store saves use a same-directory temporary file followed by rename, so preference, feedback, and trace metadata writes are less likely to lose concurrent updates or leave a partial JSON file if the process is interrupted.

If the store file exists but contains invalid JSON, startup moves it aside with a `.corrupt-` suffix before creating a fresh normalized store. This preserves the damaged file for inspection instead of silently overwriting it.

Supported preference fields:

- `role`
- `language`
- `detailLevel`
- `focusAreas`
- `taskTypes`

Memory suggestions are stored separately under `memorySuggestions`. The system may suggest memory from recent Agent Workflow or Direct Chat usage, but only `POST /api/memory/confirm` writes the value into the resolved user's long-lived preferences and the SQLite long-term memory store. `POST /api/memory/forget` can ignore one pending suggestion, clear one known preference key, or clear all preferences for the resolved user, and active matching long-term memory items for that user are marked forgotten.

Memory mutations are also recorded under `memoryEvents`. Confirming, ignoring, selectively forgetting, or clearing preferences creates a lightweight audit event with user id, project id, suggestion id when available, action, preference key/value, status, and timestamp. `GET /api/memory` returns recent events alongside preferences and suggestions for the resolved user.

The Copilot inspector uses `GET /api/memory` plus `POST /api/memory/forget` as a lightweight memory manager. It shows confirmed preferences, recent long-term memory items, and audit events, and lets the user remove one key/value pair or clear all preferences without creating a separate page. `GET /api/memory` also supports `userId`, `q`/`query`, `status=active|forgotten|superseded|all`, and `limit`; the response includes `long_term_memory_query` so UI and tests can verify the exact memory inspection filter, `embedding_model`, and whether `vector_search` was active.

`GET /api/memory/status` exposes operational health for the long-term memory SQLite database: item counts by status/type, embedding coverage, checkpoint count, schema migration count, FTS availability, database basename, and byte size. It intentionally does not return memory content. `POST /api/memory/backup` runs a WAL checkpoint, copies the SQLite database to a same-directory `.sqlite.bak` file, and returns the backup basename, byte size, creation time, and SHA-256 checksum for integrity checks. `GET /api/memory/backups` lists available backup basenames. `POST /api/memory/restore-plan` validates a selected backup basename and optional checksum, then returns a manual rollback plan with `executable: false`; it does not replace or mutate the active SQLite database. `POST /api/memory/restore` executes a guarded restore only when the caller supplies the selected backup basename, matching SHA-256, and `confirm: "RESTORE_MEMORY_DATABASE"`. It creates a fresh pre-restore backup, closes the SQLite handle, replaces the active database file, removes WAL/SHM sidecars, and reopens the database before returning status.

Confirmed scalar preferences (`role`, `language`, and `detailLevel`) compact older conflicting long-term memory items by marking the previous active value as `superseded`. The runtime also maintains a `preference_summary` memory item with source `memory_compaction`, so later retrieval can use one compressed profile record instead of only raw suggestion records. Preference and summary memories are embedded when written, and older rows missing embeddings are backfilled on SQLite startup with the local embedding model.

Confirmed preferences are applied to both impact analysis and ordinary Q&A. Retrieved long-term memory is also reported to both flows. Product Manager, QA, focus-area, language, and detail-level preferences can change answer emphasis, suggested next questions, and concise/detailed shaping after schema validation and before safety checks.

Suggestion records are normalized on store load/save so missing ids, timestamps, confidence values, and invalid statuses cannot destabilize the UI or metrics. Only pending suggestions can be confirmed or ignored. Confirm and forget requests are user-scoped; if the resolved user does not match the suggestion owner, the request is rejected with `MEMORY_USER_MISMATCH`. Confirm and forget requests may include `projectId`; when supplied, the suggestion must belong to that project or the request is rejected. Unknown preference keys are rejected instead of falling back to full memory deletion. Unknown preference values are rejected instead of writing arbitrary values into long-lived preferences. Ignored suggestions suppress the same key/value suggestion from being repeated for that user. Selective forget clears one preference key while preserving the rest of the confirmed preference memory. Unsafe input does not create new memory suggestions; existing confirmed preferences may still be applied.

Memory API errors return `{ error, code }` so the UI and tests can distinguish user-visible copy from machine-readable state. The memory boundary currently uses `MEMORY_SUGGESTION_NOT_FOUND`, `MEMORY_SUGGESTION_NOT_PENDING`, `MEMORY_PROJECT_MISMATCH`, `MEMORY_USER_MISMATCH`, `UNKNOWN_MEMORY_PREFERENCE_KEY`, and `UNKNOWN_MEMORY_PREFERENCE_VALUE`.

## Auth Boundary

Authentication is optional and disabled by default for local demos. When `AI_PM_AUTH_REQUIRED=true`, every API route except `GET /api/health` requires a token from `Authorization: Bearer ...`, `X-API-Key`, or `X-AI-PM-Token`. Tokens are mapped to user ids through `AI_PM_USER_TOKENS`, either as JSON (`{"token-a":"user-a"}`), object JSON (`{"token-a":{"userId":"user-a","role":"viewer","scopes":["project:read"]}}`), or comma-separated `token:userId` pairs. String and comma-separated tokens are backward-compatible admin identities with `scopes=["*"]`.

The authenticated token becomes the token-bound user identity for memory, chat, onboarding, and LangGraph Agent Workflow calls. If a request also provides `userId`, `user_id`, `X-User-Id`, or `X-AI-PM-User-Id`, it must match the authenticated user or the request is rejected with `AUTH_USER_MISMATCH`. When scopes are configured, route authorization checks `project:read`, `project:write`, `memory:write`, `answer:write`, or `feedback:write`; insufficient scope returns `AUTH_SCOPE_FORBIDDEN` with the required scope. Missing and invalid tokens return `AUTH_REQUIRED` and `AUTH_INVALID`. `/api/health` reports whether auth is required and how many tokens are configured without exposing token values.

The normalized JSON store includes `authUsers`, derived from configured token identities and local store-backed users. Local tokens are stored under `authTokens` as SHA-256 hashes with token prefixes only; the plaintext token is returned once from `POST /api/auth/users` and is never persisted. `POST /api/auth/users/disable` disables a local user and its tokens. The store also keeps bounded `authEvents` for recent allow/deny decisions, including user id when known, role, scopes, route, required scope, status, reason, and timestamp. `GET /api/auth/me` returns the resolved token-bound user identity for the current request. `GET /api/auth/users` returns the configured and local users, roles, scopes, org ids, status, source, and token summaries for audit without returning token strings. `GET /api/auth/events` returns recent auth decisions without exposing token values. This is an account-audit and local token boundary, not a full account product: it does not implement password login, session cookies, OAuth, or an admin UI.

## modelAdapter

`runModelAdapter()` remains the direct-chat model boundary. `runAgentModelAdapter()` is the role-aware boundary for Supervisor, ImpactAnalyst, and QACritic; it adds the role contract, specialist input, role-specific schema validation, and `agent_role` audit metadata while reusing the same OpenAI-compatible transport and safety rules.

It supports OpenAI-compatible chat completions through:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL` / `OPENAI_TEMPERATURE` (shared default; also used by the non-agent `runModelAdapter()` path)
- `OPENAI_MODEL_SUPERVISOR` / `OPENAI_MODEL_IMPACT_ANALYST` / `OPENAI_MODEL_QA_CRITIC` (per-role model override, `runAgentModelAdapter()` only)
- `OPENAI_TEMPERATURE_SUPERVISOR` / `OPENAI_TEMPERATURE_IMPACT_ANALYST` / `OPENAI_TEMPERATURE_QA_CRITIC` (per-role temperature override, `runAgentModelAdapter()` only)
- `LLM_REQUEST_TIMEOUT_MS`
- `LLM_CONTEXT_TOKEN_BUDGET`

`resolveLlmModelForRole(role)`/`resolveLlmTemperatureForRole(role)` resolve in this order: role-specific env var -> the shared `OPENAI_MODEL`/`OPENAI_TEMPERATURE` -> the hardcoded default (`gpt-4o-mini` / `0.2`). The role -> env var mapping is an explicit lookup table keyed by the three known agent-contract roles (not derived by string-mangling `agent.role`), so an unrecognized or renamed role falls straight through to the shared resolution instead of silently reading the wrong variable. Empty-string and whitespace-only env values are treated as unset. This repository does not measure the cost or latency of any model/role combination (every check and test here runs offline); per-role selection makes the model/temperature choice per role configurable and observable, nothing more.

If no API key is configured, the model adapter reports deterministic offline retrieval. If estimated prompt tokens exceed `LLM_CONTEXT_TOKEN_BUDGET`, the adapter does not call the external model and uses deterministic fallback with `LLM_CONTEXT_BUDGET_EXCEEDED`. If a model response times out, fails transport, returns a non-2xx HTTP response, returns invalid JSON, or fails schema validation, the workflow uses deterministic fallback and records the failure under `harness.model_adapter.error_code`, `error`, `http_status`, `duration_ms`, `prompt_tokens_estimated`, `max_context_tokens`, `context_budget_exceeded`, and `schema_errors` when applicable. Repository chunks are scanned in raw form for safety, but sensitive-looking values such as API keys, tokens, passwords, credentials, and secrets are redacted before the retrieved context is sent to an external model.

## agentHarness

`buildAgentHarnessReport()` creates the public harness payload for `/api/agent-impact`. Its backward-compatible `model_adapter` field summarizes ImpactAnalyst, while `model_calls` records every Supervisor, ImpactAnalyst, and QACritic attempt independently, including role, provider, model, temperature, schema/fallback result, duration, and estimated prompt tokens. `model_config` additionally reports, per role, the currently effective model/temperature and whether each came from a role-specific override or from inheriting the shared `OPENAI_MODEL`/`OPENAI_TEMPERATURE` default — independent of whether that role happened to be called on this particular run.

Agent workflow execution uses `MemorySaver` from `@langchain/langgraph-checkpoint` with `thread_id` set to the harness `run_id`. Runtime `store` and full project objects are not graph-state channels; nodes access them through the runtime closure so executable checkpoint payloads do not serialize auth users, token hashes, or the whole JSON store. After execution, checkpoint tuple summaries are persisted into SQLite under `langgraph_checkpoints`, while the serialized MemorySaver storage/writes snapshot is persisted under `langgraph_checkpoint_payloads`. Persisted summary rows store metadata, compact state summaries, and a bounded resume input snapshot (`projectId`, question, user id, source run id). Audits can inspect checkpoint lineage, source, node, trace-step count, memory usage, and safety status without duplicating the full answer payload.

`GET /api/langgraph-checkpoint` returns one persisted checkpoint summary by `projectId`, `runId`, and `checkpointId`. This is a read-only time-travel inspection boundary: it exposes the saved checkpoint metadata, compact state summary, and executable-resume availability, but does not resume or mutate graph state.

`GET /api/langgraph-replay` returns the ordered checkpoint summary replay for one LangGraph run by `projectId` and `runId`. The replay is deterministic and audit-only: it reconstructs the persisted checkpoint timeline from SQLite summaries and explicitly does not invoke the graph, tools, or model.

`POST /api/langgraph-resume` looks for the persisted MemorySaver payload for the source run and picks one of three resume modes, reported as `harness.resume.mode`:

| mode | when | mechanism |
| --- | --- | --- |
| `native_interrupt_resume` | a persisted checkpoint payload exists AND a `decision` (`approve`/`reject`) was supplied | The payload is cloned into a new harness run thread and LangGraph is invoked with `new Command({ resume: decision })` against the thread's latest checkpoint. Inside `human_review`, the pending `interrupt()` call returns `decision` directly instead of throwing again, so only `human_review` and `synthesize` re-run — `input_safety` through `guardrails` are not re-executed, because their state already lives in the persisted checkpoint. |
| `checkpoint_continuation` | a persisted checkpoint payload exists AND no `decision` was supplied | The payload is cloned and LangGraph is invoked with `graph.invoke(null, ...)` pinned to the selected `checkpoint_id`. `human_review`'s `interrupt()` call finds no resume value available and throws again immediately, so the run stays paused (byte-for-byte the same paused shape). This is executable continuation from a historical checkpoint boundary, not a read-only replay. |
| `input_snapshot_reexecution` | no persisted checkpoint payload survives (e.g. pruned by `CHECKPOINT_MAX_RUNS`) | Legacy fallback: the persisted input snapshot (`projectId`, question, user id) is re-executed from phase 0 with the decision injected directly into the initial state (`baseInput.hitlRequest`). Checkpoints created before resume snapshots existed return `LANGGRAPH_RESUME_UNAVAILABLE` instead. |

**Node re-run caveat**: LangGraph resumes a paused thread by re-running the *interrupted node from its top*, not by replaying only the code after the `interrupt()` call. `human_review` is written so nothing side-effectful precedes its `interrupt()` call, for exactly this reason.

`buildChatHarnessReport()` creates the equivalent lightweight payload for `/api/chat`.

`buildOnboardingHarnessReport()` creates the deterministic harness payload for `/api/onboarding`.

The harness reports:

- run id
- runtime
- model mode and provider
- model adapter metadata
- model adapter error code, HTTP status, and call duration
- executed steps
- duration
- fallback status
- fallback reason
- schema status
- budgets (including `max_revision_rounds`)
- budget status (including `effective_max_steps`, a revision-aware step ceiling — see "LangGraph `recursionLimit` and step budget scale with `AGENT_MAX_REVISION_ROUNDS`" below)
- estimated context token usage
- bounded QACritic revise-loop metrics (`revision_rounds`, `revision_max_rounds`, `revision_reason`, `revision_budget_exhausted`, `revision_metrics`)
- read-only tool registry
- errors

Feedback records preserve `harness_run_id` when the referenced answer payload includes a harness run id, so quality signals can be correlated with the agent or direct chat execution that produced the answer.

`/api/evaluation` derives `recent_harness_runs` from saved `harnessRuns` snapshots, with answer payloads as a backward-compatible fallback for older stores. Each item includes the run id, answer id, answer kind, runtime, model mode, model provider, schema status, budget status, model adapter summary, duration, fallback status, safety status, risk types, trace tools, and creation time. The payload also reports `harness_run_snapshots` so operators can verify that runs are being indexed independently from answer payloads.

`GET /api/harness-run` returns one persisted harness run audit by `projectId` and `runId`. It is read-only and returns the run snapshot plus the answer's trace, harness, safety, guardrail metadata, and recent `langgraph_checkpoints` rows when the answer is still available. `GET /api/langgraph-checkpoint` narrows that audit to a single checkpoint and returns a `time_travel` note that explicitly marks the operation as inspection-only. `GET /api/langgraph-replay` broadens the audit to the complete checkpoint summary replay for the run.

`recent_feedback` enriches each feedback record with answer kind, harness run id, and safety status so dashboard feedback can be traced back to the runtime that produced the answer.

The same evaluation payload derives `recent_safety_events` from saved answers with `needs_review` safety status or recorded risk types. Each item includes the answer id, optional run id, answer kind, safety status, risk types, matching guardrails, and creation time.

Safety payloads include `risk_details`, a normalized explanation list derived from `risk_types`, so the UI and harness audit can show why a risk was flagged without hard-coding descriptions in the frontend. Output safety scans the raw generated payload before finalization, then recursively redacts credential-like strings before answers and harness snapshots are stored or returned. `safety.output_redaction` records whether redaction was applied, the number of credential-like matches replaced, and the redaction marker, without storing the raw values.

`/api/evaluation` also reports `output_redaction_runs`, `output_redaction_matches`, and `recent_redaction_events` so redaction activity is visible at dashboard level without exposing raw secrets.

It also derives `memory_event_counts` and `recent_memory_events` from project-owned memory audit events, with memory suggestions as a backward-compatible fallback for older stores. Each event item includes action, suggestion id when available, preference key/value, display label, status, and creation time.

The evaluation payload also exposes `safety_status_counts`, `import_safety_status`, `import_safety_risk_counts`, and `memory_status_counts`, so the dashboard can distinguish passed versus review-needed safety outcomes, import-time safety findings, and pending versus confirmed or ignored memory suggestions.

For harness observability, the evaluation payload exposes `harness_runtime_counts`, `model_mode_counts`, `tool_policy_counts`, `recent_tool_policy_events`, `budget_status_counts`, `schema_status_counts`, `llm_usage_counts`, `trace_tool_counts`, `langgraph_checkpoint_count`, `recent_langgraph_checkpoints`, `schema_migration_count`, and `recent_schema_migrations`, derived from saved harness metadata, trace steps, SQLite checkpoint summaries, and SQLite migration audit rows.

Citation observability uses the same validation boundary as the output guardrail. `citation_status_counts` distinguishes valid citations, missing files, uncited impact areas, and answers with no repository citation, using related files, impact-area files, onboarding plan files, and trace citations.

`withWorkflowTimeout()` enforces the graph timeout. Timeout failures use the same deterministic fallback path as other workflow failures.

`LLM_REQUEST_TIMEOUT_MS` controls individual model call timeouts for both the LangGraph workflow and the direct chat harness. `LLM_CONTEXT_TOKEN_BUDGET` controls estimated prompt context size before an external model call is attempted. Invalid or non-positive timeout and context budget values fall back to finite defaults so harness budget metadata stays finite.

## Node-Level Progress Streaming (SSE)

`POST /api/agent-impact` is unchanged: single request/response, same contract, same code path (`graph.invoke()`). `POST /api/agent-impact/stream` is a NEW, additional route — same auth, same validation, same `runAgenticImpactWorkflow()` call — that streams per-node progress as Server-Sent Events instead of returning one payload after up to 30s of silence. `mcp-server.js` and every existing check continue to exercise only the unchanged JSON route.

**Hand-rolled SSE, zero dependencies.** No `EventSource` on the client (it cannot carry the `Authorization` header this app already relies on, and a token in the URL would leak into logs/history) and no query-string token on the server. The client uses `fetch()` + `response.body.getReader()` and parses `event: <type>\ndata: <json>\n\n` frames itself; the server writes those same frames by hand on `node:http`'s `res.write()` — no streaming library, consistent with this codebase's zero-framework stance.

**One shared implementation, not two.** `runAgenticImpactWorkflow(store, project, question, userId, resumeMetadata, options)` grew one new, optional 6th parameter: `options.onEvent`. Every pre-existing caller (the JSON route, `lib/checkpoints.js`'s resume path) omits it and is byte-for-byte unchanged — this module still only calls `graph.invoke()` for them. Only the new stream route supplies `onEvent`, and when it does, the SAME `graphInput`/`graphConfig` that would have gone to `graph.invoke()` instead goes to `graph.stream(graphInput, { ...graphConfig, streamMode: ["updates", "values"] })`. Every line of code AFTER the graph runs — checkpoint persistence, `isInterrupted()` handling, the catch-block deterministic fallback, `buildAgentHarnessReport()`, redaction, the returned payload — is identical and shared between both call shapes. This sharing (rather than two independently maintained code paths) is what guarantees the two routes' payloads stay equivalent instead of silently drifting apart.

**Stream modes chosen, and why not `custom`.** `"updates"` yields each node's own raw returned partial-state object, keyed by node name — exactly the object every node already builds, including its own `trace` entry (`tool`/`purpose`/`agent_role`/`input`/`output`). Every SSE event this feature needs is already present in that data: per-node progress (node name, agent role, human-readable label) comes straight from the trace entry; a bounded QACritic revise round shows up as the `retrieve` node's own delta carrying `revisionRound > 0` plus `additional_queries_used` in that same trace entry's `input`; and a HITL pause shows up as a `{ __interrupt__: [...] }` chunk (LangGraph's own interrupt signal, mirroring what `isInterrupted()` checks on `graph.invoke()`'s return value — verified empirically). `"values"` yields the full accumulated state after each superstep; this workflow needs that ONLY to reconstruct the equivalent of `graph.invoke()`'s return value once the stream ends (see below) — it is never turned into its own SSE event. `"custom"` is deliberately not used: no node calls `config.writer(...)`, and every signal this feature's events need already flows through each node's own state update, visible via `"updates"` — adding `writer()` calls would only re-emit data already present, for no observability gain.

**Reconstructing `graph.invoke()`'s return value from a stream.** `graph.invoke()`'s return value is the full final state merged with `__interrupt__` when the run paused. Streaming `"values"` mode does NOT reproduce that merge — an interrupted run's last `"values"` chunk is ONLY `{ __interrupt__: [...] }`, without the rest of the committed state (confirmed empirically). The implementation tracks the last `"values"` chunk that is NOT an interrupt marker (the last fully-committed state) separately from any interrupt payload seen, and on interrupt reconstructs `{ ...lastFullValues, __interrupt__: interrupts }` — byte-for-byte what `graph.invoke()` itself returns for the identical paused run (also verified empirically, including for this repo's supervisor-hub topology, where the terminal step is the `supervisor` node's own conditional-edge-to-`END` visit rather than a plain node-to-`END` edge). For a normal completion, the last `"values"` chunk alone already equals `graph.invoke()`'s return value exactly.

**Events emitted**, in order: `workflow_started` (run id, thread id, graph mode, the 9 planned `phaseMap` nodes), one `node_completed` per real node (`input_safety` .. `synthesize`, or through `guardrails` if a HITL pause intervenes) with node name, agent role, human-readable label, and elapsed ms since start, `revise_round_entered` once per bounded revise round (round number, the QACritic's `additional_queries` fed into that round's retrieval), `hitl_paused` if `human_review`'s native `interrupt()` fires, and finally `final` carrying the complete `{ answerId, kind, payload }` — the exact same shape `POST /api/agent-impact`'s response body has.

**Payload equivalence, and how it is proven.** The same question through both routes must produce the same payload modulo `run_id`/`thread_id`/timestamps/`duration_ms`. `scripts/check-agent-impact-stream.js` proves this offline by running the identical question through two independent server processes/data directories (one per route — otherwise a second call's memory-suggestion generation would legitimately dedupe against the first call's already-pending suggestions, a real but irrelevant confound for an equivalence proof), normalizing the volatile fields, and asserting a deep equality. The same script also proves event ordering (`workflow_started` first, `final` last, every phaseMap node exactly once in order), the bounded revise-round case (13 `node_completed` events — 9 base + 4 for the one round — plus exactly 1 `revise_round_entered`), and the HITL pause case (8 `node_completed` events, exactly 1 `hitl_paused`, and the final event's payload carrying `hitl.paused === true` with the `"[HITL PAUSED"` summary prefix).

**Abort on client disconnect.** `runAgenticImpactWorkflow` already threads an `AbortController` into `config.signal` for the timeout race; the stream route wires the HTTP response's `"close"` event into a matching external signal (`options.signal`), which the workflow links into that same internal controller. LangGraph's pregel loop honors that signal and stops scheduling further supersteps once it is observed. A closed connection also gates the store-commit phase: the route checks whether the disconnect fired before committing, and if so skips writing the question/answer/harness-run records entirely, so an aborted run never leaves a partial record behind. `scripts/check-agent-impact-stream.js`'s abort scenario proves this against a real server using a slow fake OpenAI-compatible endpoint (genuine local network I/O between nodes) rather than a fully offline run — verified empirically that a fully offline/deterministic run is synchronous end-to-end (`node:sqlite` is a synchronous API; retrieval and impact generation are pure CPU work) and never yields to the Node.js event loop between nodes at all, so an externally-triggered abort (like a real socket `"close"` event) would never be observed mid-run regardless of how it is wired, because V8 fully drains its microtask queue before servicing any macrotask. A real deployment always has a genuine async yield point between nodes (a real LLM call is real network I/O), so the fake endpoint exercises the same mechanism a production abort relies on.

**Per-node timing** (elapsed ms since start) is carried on every streamed event but is NOT persisted into the non-streaming payload's trace steps — adding it there would require either faking timing data for the non-streaming `graph.invoke()` path (which does not observe per-node boundaries the way the stream does) or diverging the two paths' trace shapes, either of which would break the payload-equivalence guarantee above and `scripts/check-agent-contract.js`'s trace/harness field assertions. Timing stays stream-only.

**Frontend.** `runAgentImpact()` in `public/app.js` calls a new `streamAgentImpact()` helper that consumes the SSE frames and replaces the static "Running agent workflow..." placeholder with a live, node-by-node trace list (reusing the same `.trace-list`/`.trace-step`/`.agent-role-badge` classes the final answer's own trace already uses) that fills in as events arrive. Any failure — the stream endpoint erroring, a non-SSE content type, the browser lacking `fetch`/`ReadableStream` support, a parse error, an explicit `error` frame, or the stream ending without a `final` event — falls back to the existing `POST /api/agent-impact` JSON call, so a user never ends up with a half-rendered dead state. The eventual final answer renders through the exact same `renderAgentImpactMessage()` path as before, so the typewriter effect and the HITL pause card are unaffected either way.

## Tool Policy

The first version uses read-only agent tools only. The tool registry forbids:

- repository writes
- shell execution
- external network tools

The public harness exposes the same policy shape as runtime metadata: `mode: "read-only"`, `allow_external_network: false`, `allow_repository_writes: false`, and `allow_shell_execution: false`.

The trace is checked against the registry before the final response is returned. Unknown or disallowed tools mark safety as `needs_review`.

## AI Safety Boundary

Safety checks run at four levels:

- Import: request bodies, GitHub fetch duration, ZIP byte size, ZIP entry counts, safe relative repository paths, imported file counts, per-file text size, total imported text size, and ZIP structure are bounded before repository content enters analysis. The project summary also records import-time `safetyReview` counts for files containing instruction-like prompt injection text or sensitive-looking values without exposing the matched secret values.
- Input: prompt injection, system/developer prompt leakage requests, secret requests, and write/tool escalation intent.
- Retrieval: instruction-like text and sensitive-looking values inside repository files are treated as untrusted evidence and flagged for review.
- Output: citations must exist in the imported repository, every impact area must cite at least one file, sensitive-looking values are flagged, and no-impact-citation overconfidence is flagged.
- Agent: all trace tools must match the read-only registry.

Repository content is never promoted into system instructions.

The active safety policy is centralized in `SAFETY_POLICY` and summarized on `/api/health` as `safety_policy`. The summary includes the policy version, input rule counts, repository rule counts, and output enforcement switches without exposing full regex internals as a public contract.

`npm run test:safety` runs a red-team suite against a temporary server. It covers direct prompt injection, system/developer prompt leakage requests, secret requests, tool escalation, retrieved-context prompt injection, retrieved sensitive content, and the invariant that unsafe input does not create memory suggestions.

`npm run test:memory` runs a dedicated long-term memory compaction suite. It confirms conflicting role preferences, verifies the previous scalar value is marked `superseded`, and checks that the active `preference_summary` record from `memory_compaction` reflects the latest preference state.

`npm run test:user-memory` runs a dedicated user isolation suite. It confirms two different users can keep different role memories, verifies cross-user memory confirmation is rejected, and checks that `GET /api/memory` plus SQLite long-term memory retrieval are scoped by user.

## Non-Goals

The current version intentionally does not include:

- external database persistence beyond local JSON and SQLite files
- managed vector database integration
- full account management, password login, sessions, roles, and org authorization
- external database migration framework
- LangSmith tracing
- autonomous write tools
- automatic external browsing tools
- compliance certification claims

## What's New (2026-08-07 – 2026-08-25, updated in place per card)

This section was introduced on 2026-08-07 and its bullets have since been edited in place as the underlying capability evolved, rather than left as a dated snapshot; see `docs/CHANGELOG.md` for exactly which commit changed which bullet.

- **Supervisor routing** (2026-08-07): `AGENT_GRAPH_MODE=supervisor` (default) uses a deterministic `decideNextRoute()` function with `addConditionalEdges` for dynamic agent orchestration. Set `AGENT_GRAPH_MODE=linear` to fall back to the original 9-node linear pipeline.
- **Human-in-the-loop (HITL)** (soft-pause 2026-08-07, upgraded to native interrupt 2026-08-25, second trigger 2026-08-27): Enable with `AGENT_HITL_ENABLED=true`. `hitlReviewRequired(state)` (`lib/agent-graph.js`) gates the pause on TWO independent, OR'd signals: the ImpactAnalyst's evidence-grounded `riskLevel === "high"` (the original, still-primary trigger) OR the Supervisor's own `supervisorPlan.require_human_review === true` (schema-validated boolean on `supervisorPlan`, produced by the model agent or `createDeterministicSupervisorPlan()` — present since the Supervisor contract's inception but, before this change, never consumed by routing). `risk_hypothesis` (the Supervisor's own risk guess, also on `supervisorPlan`) is deliberately NOT a routing input — it stays advisory/observability-only; `require_human_review` is the one field the schema already casts as an explicit "should a human look at this" verdict. Either trigger calls LangGraph's native `interrupt()` inside the `human_review` node, which genuinely pauses graph execution mid-run (the pregel loop persists the checkpoint and `graph.invoke()` returns with `__interrupt__` set instead of a `finalPayload`) — not a soft "paused" flag that a still-running graph continues past. The paused payload's `hitl.reason` names which signal(s) fired ("high risk change requires human review" / "supervisor requested human review" / both, joined), and the additive `hitl.triggers` array (`["high_risk"]`, `["supervisor_flag"]`, or both) carries the same information machine-readably. Resume via `POST /api/langgraph-resume` with `{ decision: "approve"|"reject" }`; see the `harness.resume.mode` table above for the three resume paths (`native_interrupt_resume` is the common case — it resumes the same paused execution via `Command({ resume: decision })` instead of re-running the graph from phase 0).
- **Agent boundaries** (single role-labeled agent 2026-08-07, upgraded to three independent model agents 2026-08-23): Supervisor, ImpactAnalyst, and QACritic have independent prompts, schemas, model calls, and fallbacks. SafetyGuard, MemoryCurator, Classifier, Retriever, OnboardingPlanner, Synthesizer, and Harness remain deterministic roles or infrastructure. Trace steps, model calls, handoffs, and an agent roster are returned in API payloads.

## What's New (2026-08-25)

- **Bounded QACritic revise cycle**: the graph now has a real cycle. `qa_plan` (QACritic) returning `verdict="revise"` routes back to `retrieve` for one more retrieve→expand_context→impact_analysis→qa_plan round, bounded by `AGENT_MAX_REVISION_ROUNDS` (default `1`, `0` disables it). See "The bounded QACritic revise cycle" above for the trigger, bound, loop target, phase-cursor fix, and precedence rules; see "What `scripts/check-revise-loop.js` does and does not prove" above for exactly what its offline, no-API-key proof does (and does not) demonstrate. `scripts/check-revise-hitl-cross.js` additionally proves the loop composes correctly with the L1 HITL pause/resume path (a revise round resolving before a high-risk pause, then a correct resume).
- **Per-query retrieval**: `retrieve` now calls `retrieveChunks()` once per planned query (question, Supervisor `retrieval_queries`, and — on a revise round — the QACritic's `additional_queries`) and merges the per-query result lists with a deterministic round-robin interleave, instead of joining every query into one string. See "Per-query retrieval (retrieve node)" above.
- **LangGraph `recursionLimit` and step budget scale with `AGENT_MAX_REVISION_ROUNDS`**: the supervisor-hub topology plus each revise round pushes total supersteps past LangGraph's default `recursionLimit` of 25. `computeGraphRecursionLimit(AGENT_MAX_REVISION_ROUNDS)` derives the limit from an explicit superstep cost model instead of a value derived from the unrelated `AGENT_MAX_STEPS`; `budget_status.step_budget_exceeded` similarly compares against a revision-aware `effective_max_steps` instead of the raw single-pass `AGENT_BUDGETS.max_steps`, so a healthy run that used its configured revise-round budget is not mislabeled as over budget. `scripts/check-recursion-limit-scaling.js` proves both at `AGENT_MAX_REVISION_ROUNDS` = 0, 1, 2, 3.
- **Node-level SSE progress streaming**: `POST /api/agent-impact/stream` streams `workflow_started`/`node_completed`/`revise_round_entered`/`hitl_paused`/`final` events over hand-rolled Server-Sent Events, sharing `runAgenticImpactWorkflow()`'s implementation with the unchanged `POST /api/agent-impact` JSON route via one new optional `options.onEvent` parameter. A client disconnect aborts the in-flight LangGraph run through the same `AbortController` the existing timeout race already uses, and never leaves a partial record in the store. See "Node-Level Progress Streaming (SSE)" above for the stream-mode choice, the invoke()-equivalence reconstruction, and how equivalence and abort are proven.

## What's New (2026-08-27)

- **Supervisor `require_human_review` becomes a second HITL trigger**: the Supervisor agent's contract (`lib/agent-contracts.js`) has always required a schema-validated `require_human_review` boolean, but until now it was produced, validated, and consumed by nothing. `hitlReviewTriggers(state)`/`hitlReviewRequired(state)` in `lib/agent-graph.js` are the single source of truth for the OR of the two independent signals (`riskLevel === "high"` and `supervisorPlan?.require_human_review === true`, the latter checked with strict `=== true`, not truthiness, since `supervisorPlan` could in principle hold a non-conformant plan object); `decideNextRoute`'s phase-lookup HITL reroute now calls `hitlReviewRequired(state)` instead of reading `riskLevel` directly. `risk_hypothesis` (the Supervisor's own risk guess, also on `supervisorPlan`) stays deliberately unwired — advisory/observability-only, not a routing input. The post-`human_review` short-circuit (`hitlRequest.node === "human_review" && riskLevel === "high"`) is intentionally left unextended: it exists only to correctly resume a legacy PRE-N1 checkpoint (every such checkpoint could only ever have paused via `riskLevel==="high"`, since `require_human_review` did not exist as a trigger when it was written), and the ordinary post-N1 phase-lookup path already routes a resumed supervisor-triggered pause to `synthesize` correctly on its own (proven by a dedicated `test/routing.test.js` case, not assumed). The paused payload now names which signal(s) fired: `hitl.reason` ("high risk change requires human review" / "supervisor requested human review" / both, joined) and the additive `hitl.triggers` array, mirrored into the `interrupt()` reviewRequest payload and the `hitl_paused` SSE event. `scripts/check-hitl-supervisor-trigger.js` proves the new trigger behaviorally with a fake-LLM fixture (`require_human_review=true` + `riskLevel="medium"` pauses and resumes correctly; the identical fixture with `require_human_review=false` does not pause at all), isolated from `scripts/check-revise-hitl-cross.js`'s own revise-loop × HITL cross-feature scenario. The offline/deterministic path's existing high-risk pause behavior is unchanged: `createDeterministicSupervisorPlan()` sets `require_human_review` to the exact same boolean it uses for `risk_hypothesis === "high"`, so for the canonical high-risk fixture both signals already agreed before this change (confirmed by an offline before/after payload comparison — the pause point, decision, and trace shape are identical; only `hitl.reason`/`hitl.triggers` gained the additional observability).

## Verification Gates

`npm test` runs static checks, smoke tests, UI acceptance tests, safety red-team tests, memory compaction tests, user memory isolation tests, auth boundary tests, embedding provider tests, and the agent benchmark.

Static checks cover:

- LangGraph dependency and import contract
- API documentation sync
- store schema normalization
- agent response contract
- frontend agent UI contract
- locale key sync
- text quality
- agent benchmark contract
- unit tests under `test/` (`node --test test/**/*.js`, 184 cases across 11 test files)
- bounded QACritic revise-loop mechanism (`scripts/check-revise-loop.js`): offline, no-API-key proof that a revise verdict loops back to `retrieve`, folds `additional_queries` into the next retrieval pass, resolves in a constructed fixture (or exhausts its round budget and still terminates in another) — see "What it does and does not prove" above
- revise loop × HITL cross-feature regression (`scripts/check-revise-hitl-cross.js`): a fake-LLM-backed fixture (the deterministic critic cannot produce "revise" and a cited high-risk area at the same time) proving a revise round can resolve, then a high-risk pause via native `interrupt()`, then a decision resume, still compose correctly through the SAME `decideNextRoute` and persisted graph state
- Supervisor `require_human_review` as a second HITL trigger (`scripts/check-hitl-supervisor-trigger.js`): a fake-LLM-backed fixture with `require_human_review=true` and a `riskLevel` that never reaches `"high"`, proving the pause is genuinely explained by the supervisor flag alone (`hitl.triggers` is exactly `["supervisor_flag"]`) and that a decision resume still completes correctly; the identical fixture with `require_human_review=false` is the load-bearing negative control (no pause at all)
- `AGENT_MAX_REVISION_ROUNDS` scaling for LangGraph's `recursionLimit` and the effective step budget (`scripts/check-recursion-limit-scaling.js`): runs the same offline, perpetually-revising fixture at `AGENT_MAX_REVISION_ROUNDS` = 0, 1, 2, 3, asserting no recursion-limit error and no false `step_budget_exceeded` at any setting
- node-level SSE progress streaming (`scripts/check-agent-impact-stream.js`): a real, offline server proving event ordering and per-node coverage for a single-pass run, the bounded revise-round case (13 `node_completed` + 1 `revise_round_entered`), the HITL pause case (8 `node_completed` + 1 `hitl_paused`, final `hitl.paused === true`), the `POST /api/agent-impact` vs `POST /api/agent-impact/stream` payload-equivalence property, and client-disconnect abort (via a slow fake OpenAI-compatible endpoint, so the abort has a genuine async yield point to be observed at — see "Node-Level Progress Streaming (SSE)" above for why a fully offline/synchronous run cannot demonstrate this)

Smoke tests cover:

- no-key offline mode
- LangGraph agent execution
- memory confirm, ignore, selective forget, full forget, post-forget behavior, and unsafe-input learning suppression
- input prompt injection and secret request guardrails
- safety policy health metadata and red-team cases
- memory compaction, superseded preferences, and summary records
- user-scoped memory isolation and cross-user confirmation rejection
- retrieved-context prompt injection guardrails
- retrieved sensitive content guardrails
- API-key mode with fake OpenAI-compatible schema failure
- valid schema with nonexistent citation
- valid schema with uncited impact area
- Q&A and evaluation regressions, including average response time, safety risk type counts, and fallback reason counts

The agent benchmark uses `npm run test:benchmark` to run a fixed offline matrix for safe impact analysis, prompt injection, safe Q&A, tool escalation, and multi-turn memory recall. It reports pass rate and checks safety, trace, harness, citation, pending memory suggestions, confirmed long-term memory, and later memory reuse, then verifies evaluation metrics such as guardrail hits, memory confirmations, persisted harness runs, schema-valid runs, and trace tool counts.
