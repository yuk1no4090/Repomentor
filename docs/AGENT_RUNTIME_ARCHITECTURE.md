# Agent Runtime Architecture

This document records the first production-shaped implementation boundary for the LangGraph, memory, harness, and AI safety upgrade.

## Scope

- The agent workflow is implemented as a LangGraph `StateGraph`.
- The LangGraph workflow runs with `MemorySaver` checkpointing and persists checkpoint summaries to SQLite.
- The first memory module is user preference memory only.
- The harness is the runtime boundary around model calls, graph execution, tool policy, budgets, trace, schema validation, fallback, and errors.
- AI safety is application-level guardrails. It is not a compliance certification.

## Graph Nodes

The `/api/agent-impact` workflow executes these nodes in order:

```text
input_safety
  -> memory
  -> classify
  -> retrieve
  -> expand_context
  -> impact_analysis
  -> qa_plan
  -> guardrails
  -> synthesize
```

Each node appends trace metadata so the UI can show the agent path instead of hiding the workflow.

`/api/chat` is not a LangGraph workflow. It uses a lighter `Direct Chat Harness` that reuses the same model adapter, schema validation, trace shape, deterministic fallback, confirmed `memory_used` reporting, pending `memory_suggestions`, read-only tool policy, input/retrieval/output safety reports, and guardrail detail format. This keeps the existing chat API compatible while making ordinary Q&A and standard impact analysis observable through the same harness fields.

`/api/onboarding` uses an `Onboarding Harness` around deterministic role-based plan generation. It exposes trace steps, confirmed-memory status, pending memory suggestions, citation/output safety, guardrails, budget metadata, and the same read-only tool registry so onboarding plans are visible in evaluation metrics.

## Memory Boundary

Confirmed preference memory is stored in `data/store.json` under `userPreferencesByUser`, with legacy `userPreferences` retained for the default `local-user` profile. API clients can pass `userId` in JSON bodies or `X-User-Id` / `X-AI-PM-User-Id` headers; missing values resolve to `local-user` for local/backward-compatible use. Confirmed long-term memory items are also stored in SQLite at `MEMORY_DB_PATH` under the `memory_items` table, with `memory_items.user_id` for user isolation, an FTS5 index when available, and local `embedding_json` vectors for deterministic similarity ranking. The local embedding model is reported as `embedding_model=local-hash-v1`; it is an offline lexical vector for recall ranking, not an external semantic embedding service. Each long-term memory item keeps its source `projectId` for filtering and audit. Memory suggestions carry `userId` and `projectId` so the UI and API can verify which user and project produced the suggestion before confirmation or ignore actions.

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

Confirmed scalar preferences (`role`, `language`, and `detailLevel`) compact older conflicting long-term memory items by marking the previous active value as `superseded`. The runtime also maintains a `preference_summary` memory item with source `memory_compaction`, so later retrieval can use one compressed profile record instead of only raw suggestion records. Preference and summary memories are embedded when written, and older rows missing embeddings are backfilled on SQLite startup.

Confirmed preferences are applied to both impact analysis and ordinary Q&A. Retrieved long-term memory is also reported to both flows. Product Manager, QA, focus-area, language, and detail-level preferences can change answer emphasis, suggested next questions, and concise/detailed shaping after schema validation and before safety checks.

Suggestion records are normalized on store load/save so missing ids, timestamps, confidence values, and invalid statuses cannot destabilize the UI or metrics. Only pending suggestions can be confirmed or ignored. Confirm and forget requests are user-scoped; if the resolved user does not match the suggestion owner, the request is rejected with `MEMORY_USER_MISMATCH`. Confirm and forget requests may include `projectId`; when supplied, the suggestion must belong to that project or the request is rejected. Unknown preference keys are rejected instead of falling back to full memory deletion. Unknown preference values are rejected instead of writing arbitrary values into long-lived preferences. Ignored suggestions suppress the same key/value suggestion from being repeated for that user. Selective forget clears one preference key while preserving the rest of the confirmed preference memory. Unsafe input does not create new memory suggestions; existing confirmed preferences may still be applied.

Memory API errors return `{ error, code }` so the UI and tests can distinguish user-visible copy from machine-readable state. The memory boundary currently uses `MEMORY_SUGGESTION_NOT_FOUND`, `MEMORY_SUGGESTION_NOT_PENDING`, `MEMORY_PROJECT_MISMATCH`, `MEMORY_USER_MISMATCH`, `UNKNOWN_MEMORY_PREFERENCE_KEY`, and `UNKNOWN_MEMORY_PREFERENCE_VALUE`.

## Auth Boundary

Authentication is optional and disabled by default for local demos. When `AI_PM_AUTH_REQUIRED=true`, every API route except `GET /api/health` requires a token from `Authorization: Bearer ...`, `X-API-Key`, or `X-AI-PM-Token`. Tokens are mapped to user ids through `AI_PM_USER_TOKENS`, either as JSON (`{"token-a":"user-a"}`) or comma-separated `token:userId` pairs.

The authenticated token becomes the token-bound user identity for memory, chat, onboarding, and LangGraph Agent Workflow calls. If a request also provides `userId`, `user_id`, `X-User-Id`, or `X-AI-PM-User-Id`, it must match the authenticated user or the request is rejected with `AUTH_USER_MISMATCH`. Missing and invalid tokens return `AUTH_REQUIRED` and `AUTH_INVALID`. `/api/health` reports whether auth is required and how many tokens are configured without exposing token values.

## modelAdapter

`runModelAdapter()` is the only agent model boundary.

It supports OpenAI-compatible chat completions through:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `LLM_REQUEST_TIMEOUT_MS`
- `LLM_CONTEXT_TOKEN_BUDGET`

If no API key is configured, the model adapter reports deterministic offline retrieval. If estimated prompt tokens exceed `LLM_CONTEXT_TOKEN_BUDGET`, the adapter does not call the external model and uses deterministic fallback with `LLM_CONTEXT_BUDGET_EXCEEDED`. If a model response times out, fails transport, returns a non-2xx HTTP response, returns invalid JSON, or fails schema validation, the workflow uses deterministic fallback and records the failure under `harness.model_adapter.error_code`, `error`, `http_status`, `duration_ms`, `prompt_tokens_estimated`, `max_context_tokens`, `context_budget_exceeded`, and `schema_errors` when applicable. Repository chunks are scanned in raw form for safety, but sensitive-looking values such as API keys, tokens, passwords, credentials, and secrets are redacted before the retrieved context is sent to an external model.

## agentHarness

`buildAgentHarnessReport()` creates the public harness payload for `/api/agent-impact`.

Agent workflow execution uses `MemorySaver` from `@langchain/langgraph-checkpoint` with `thread_id` set to the harness `run_id`. After execution, checkpoint tuple summaries are persisted into SQLite under `langgraph_checkpoints`. The persisted rows intentionally store metadata and compact state summaries instead of full graph state, so audits can inspect checkpoint lineage, source, node, trace-step count, memory usage, and safety status without duplicating the full answer payload.

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
- budgets
- budget status
- estimated context token usage
- read-only tool registry
- errors

Feedback records preserve `harness_run_id` when the referenced answer payload includes a harness run id, so quality signals can be correlated with the agent or direct chat execution that produced the answer.

`/api/evaluation` derives `recent_harness_runs` from saved `harnessRuns` snapshots, with answer payloads as a backward-compatible fallback for older stores. Each item includes the run id, answer id, answer kind, runtime, model mode, model provider, schema status, budget status, model adapter summary, duration, fallback status, safety status, risk types, trace tools, and creation time. The payload also reports `harness_run_snapshots` so operators can verify that runs are being indexed independently from answer payloads.

`GET /api/harness-run` returns one persisted harness run audit by `projectId` and `runId`. It is read-only and returns the run snapshot plus the answer's trace, harness, safety, guardrail metadata, and recent `langgraph_checkpoints` rows when the answer is still available.

`recent_feedback` enriches each feedback record with answer kind, harness run id, and safety status so dashboard feedback can be traced back to the runtime that produced the answer.

The same evaluation payload derives `recent_safety_events` from saved answers with `needs_review` safety status or recorded risk types. Each item includes the answer id, optional run id, answer kind, safety status, risk types, matching guardrails, and creation time.

Safety payloads include `risk_details`, a normalized explanation list derived from `risk_types`, so the UI and harness audit can show why a risk was flagged without hard-coding descriptions in the frontend. Output safety scans the raw generated payload before finalization, then recursively redacts credential-like strings before answers and harness snapshots are stored or returned. `safety.output_redaction` records whether redaction was applied, the number of credential-like matches replaced, and the redaction marker, without storing the raw values.

`/api/evaluation` also reports `output_redaction_runs`, `output_redaction_matches`, and `recent_redaction_events` so redaction activity is visible at dashboard level without exposing raw secrets.

It also derives `memory_event_counts` and `recent_memory_events` from project-owned memory audit events, with memory suggestions as a backward-compatible fallback for older stores. Each event item includes action, suggestion id when available, preference key/value, display label, status, and creation time.

The evaluation payload also exposes `safety_status_counts`, `import_safety_status`, `import_safety_risk_counts`, and `memory_status_counts`, so the dashboard can distinguish passed versus review-needed safety outcomes, import-time safety findings, and pending versus confirmed or ignored memory suggestions.

For harness observability, the evaluation payload exposes `harness_runtime_counts`, `model_mode_counts`, `tool_policy_counts`, `recent_tool_policy_events`, `budget_status_counts`, `schema_status_counts`, `llm_usage_counts`, `trace_tool_counts`, `langgraph_checkpoint_count`, and `recent_langgraph_checkpoints`, derived from saved harness metadata, trace steps, and SQLite checkpoint summaries.

Citation observability uses the same validation boundary as the output guardrail. `citation_status_counts` distinguishes valid citations, missing files, uncited impact areas, and answers with no repository citation, using related files, impact-area files, onboarding plan files, and trace citations.

`withWorkflowTimeout()` enforces the graph timeout. Timeout failures use the same deterministic fallback path as other workflow failures.

`LLM_REQUEST_TIMEOUT_MS` controls individual model call timeouts for both the LangGraph workflow and the direct chat harness. `LLM_CONTEXT_TOKEN_BUDGET` controls estimated prompt context size before an external model call is attempted. Invalid or non-positive timeout and context budget values fall back to finite defaults so harness budget metadata stays finite.

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

The first version intentionally does not include:

- external database persistence beyond local JSON and SQLite files
- external semantic embedding provider integration
- full account management, password login, sessions, roles, and org authorization
- LangSmith tracing
- dynamic supervisor routing
- autonomous write tools
- automatic external browsing tools
- compliance certification claims

## Verification Gates

`npm test` runs static checks, smoke tests, UI acceptance tests, safety red-team tests, memory compaction tests, and user memory isolation tests.

Static checks cover:

- LangGraph dependency and import contract
- API documentation sync
- store schema normalization
- agent response contract
- frontend agent UI contract
- locale key sync
- text quality

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
