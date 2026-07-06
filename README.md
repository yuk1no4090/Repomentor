# AI Developer Onboarding Copilot

An MVP web app for helping new engineers, technical PMs, and QA understand a repository with AI-style repository summaries, codebase Q&A, impact analysis, an agentic impact workflow, onboarding plans, citations, feedback, and evaluation metrics.

## Run

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Test

```bash
npm run test:static
npm run test:ui
npm run test:safety
npm run test:memory
npm run test:user-memory
npm run test:auth
npm test
```

`npm run test:static` runs `scripts/static-checks.js`, which performs syntax checks, locale-copy consistency checks, frontend agent UI checks, text-quality checks, runtime dependency checks, API documentation sync checks, store-schema checks, smoke reliability checks, UI acceptance wiring checks, safety guardrail contract checks, safety red-team wiring checks, memory compaction checks, user memory isolation checks, auth boundary checks, and agent response contract checks without starting a server. `npm test` runs the static checks, smoke test, UI acceptance test, safety red-team test, memory compaction test, user memory isolation test, and auth boundary test.

Static check scripts use the `scripts/check-*.js` naming convention. `scripts/static-checks.js` syntax-checks all `scripts/*.js` files and discovers/runs `check-*.js` automatically.

The smoke test starts the server on temporary ports with isolated temporary data stores, then verifies custom `STORE_PATH` creation, corrupt store backup, invalid timeout/context-budget config fallback, sample import, LangGraph agent execution, memory confirmation/forget, Chinese memory suggestions, safety guardrails, Chinese prompt-injection and secret-request guardrails, tool-permission guardrails, retrieved-context prompt-injection handling, retrieved sensitive content handling, Q&A, evaluation metrics, API-key mode fallback when a fake OpenAI-compatible model returns schema-invalid JSON, context token budget fallback before external model calls, missing-citation guardrails when the fake model cites a nonexistent file, and sensitive-output guardrails when the fake model emits secret-like text. Smoke requests use explicit timeouts and wait for spawned servers to exit during cleanup. Use `npm run test:smoke` to run only the server-backed smoke test.

The UI acceptance test starts the server with an isolated data directory, fetches the served frontend assets, imports the sample workspace, runs the Agent Workflow, confirms a memory suggestion when available, then verifies that Memory, Harness, Safety, long-term memory, dashboard metrics, and the harness audit panel all have renderable API data. Use `npm run test:ui` to run only this served frontend assets and UI data-contract check.

The safety red-team test starts the server with an isolated data directory, verifies the health endpoint exposes the active `safety_policy`, runs prompt-injection, secret-request, tool-escalation, retrieved-instruction, and retrieved-secret cases, and confirms unsafe inputs do not create memory suggestions. Use `npm run test:safety` to run only these red-team cases.

The memory compaction test starts the server with an isolated data directory, confirms conflicting role preferences, verifies the old scalar preference becomes `superseded`, and checks that an active `preference_summary` record with source `memory_compaction` is maintained. Use `npm run test:memory` to run only this long-term memory compaction check.

The user memory isolation test starts the server with an isolated data directory, runs two users through separate memory suggestions using `X-User-Id`, verifies cross-user confirmation returns `MEMORY_USER_MISMATCH`, and checks that preferences plus SQLite long-term memory stay isolated. Use `npm run test:user-memory` to run only this boundary check.

The auth boundary test starts the server with `AI_PM_AUTH_REQUIRED=true`, verifies `/api/health` remains public, rejects missing or invalid tokens, blocks token/user mismatch with `AUTH_USER_MISMATCH`, and confirms memory suggestions are bound to the authenticated user. Use `npm run test:auth` to run only this boundary check.

GitHub Actions runs `npm ci` and `npm test` on pushes to `main` and pull requests.

The project targets Node.js 24 because the long-term memory store uses the built-in `node:sqlite` module. Local Node version managers can read `.nvmrc`; CI uses the same file.

## Runtime Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port. |
| `HOST` | `127.0.0.1` | HTTP server host. |
| `DATA_DIR` | `data` | Directory for runtime JSON storage. |
| `STORE_PATH` | `DATA_DIR/store.json` | Exact runtime store file path. |
| `MEMORY_DB_PATH` | `DATA_DIR/memory.sqlite` | SQLite database path for confirmed long-term memory items. |
| `AI_PM_AUTH_REQUIRED` | unset | Set to `true` to require token authentication for API routes except `/api/health`. |
| `AI_PM_USER_TOKENS` | unset | Token-to-user mapping, either JSON such as `{"token-a":"user-a"}` or comma-separated `token:userId` pairs. |
| `OPENAI_API_KEY` | unset | Enables AI-enhanced model calls when set. |
| `OPENAI_BASE_URL` | `https://api.openai.com` | OpenAI-compatible API base URL. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat completion model name. |
| `LLM_CONTEXT_TOKEN_BUDGET` | `8000` | Estimated prompt context token budget before using deterministic fallback. |

## LLM Setup (Optional but recommended)

Set the following environment variables to enable AI-powered answers:

```bash
# Using DeepSeek (recommended: cheap, OpenAI-compatible, strong Chinese support)
export OPENAI_API_KEY=sk-your-deepseek-key
export OPENAI_BASE_URL=https://api.deepseek.com
export OPENAI_MODEL=deepseek-chat

# Or any other OpenAI-compatible provider:
# export OPENAI_API_KEY=sk-your-openai-key
# export OPENAI_BASE_URL=https://api.openai.com
# export OPENAI_MODEL=gpt-4o-mini
```

Verify the connection:

```bash
curl http://localhost:3000/api/health
```

The response shows whether the LLM is configured, which provider/model is active, the effective LLM request timeout, and the effective context token budget.

Without an API key, the app falls back to a deterministic retrieval-based answer generator. The demo still works, but answers will be template-based rather than AI-generated. The UI shows "AI-enhanced mode" or "Offline retrieval mode" so it is always clear which mode is active.

## Notes

- The runtime uses Node.js plus LangGraph packages for the agent workflow and `@langchain/langgraph-checkpoint` for checkpoint-compatible graph execution.
- GitHub imports use public repository ZIP downloads.
- ZIP uploads are parsed locally by the server.
- Runtime data is stored in `data/store.json` by default. Override with `DATA_DIR` or `STORE_PATH` for isolated runs and tests. Confirmed long-term memory is additionally stored in SQLite at `MEMORY_DB_PATH` using a `memory_items` table plus FTS search when available and local `embedding_json` vectors for deterministic similarity ranking. SQLite schema and data backfills are audited in `schema_migrations`. Non-GET API requests run through a write queue. Store saves write a same-directory temporary file and rename it into place to reduce partial-write corruption. If an existing store contains invalid JSON, it is moved aside with a `.corrupt-` suffix before a fresh normalized store is created.

## Current MVP Features

- Repository import from public GitHub URL, ZIP upload, or built-in sample repository.
- Project overview with inferred stack, directory tree, core modules, README summary, and recommended first reads.
- Import-time safety review with prompt-risk and sensitive-content file counts in the project overview.
- Repository Q&A with related files, uncertainty, suggested next questions, feedback buttons, lightweight harness metadata, safety status, guardrail details, and pending memory suggestions.
- Impact analysis with impacted modules, risk level, testing suggestions, and open questions.
- Agent Workflow tab backed by a LangGraph StateGraph with classifier, retriever, context expansion, impact analysis, QA planning, memory, safety guardrails, structured synthesis, and MemorySaver checkpointing.
- Onboarding plans run through a lightweight deterministic harness with trace, safety, guardrails, citations, and pending memory suggestions.
- User preference memory suggestions that require explicit confirmation before being saved. Confirmed preferences are scoped by `userId`, defaulting to `local-user` for local/backward-compatible use. API clients can pass `userId` in JSON bodies or the `X-User-Id` header. Confirmed preferences can shape both impact analysis and ordinary Q&A emphasis; confirmed memory is also written to SQLite long-term memory for searchable reuse across later Agent Workflow and Direct Chat runs. Memory suggestions carry user and project ownership so confirmation/ignore actions can verify the active boundary. Ignored suggestions suppress the same key/value suggestion from being repeated for that user. The Copilot inspector includes a lightweight preference and long-term memory manager for viewing, removing one preference value, or clearing all preferences.
- Application-level AI safety checks for prompt injection, system/developer prompt leakage requests, secret requests, read-only tool boundaries, retrieved sensitive content, citation validation, uncited impact areas, sensitive output, and overconfidence.
- A centralized safety policy is exposed as `safety_policy` on `/api/health` and covered by red-team tests.
- Evaluation dashboard with total questions, agent runs, helpful rate, citation coverage, citation status distribution, uncertainty rate, negative feedback, high-risk questions, guardrail hits, memory confirmations, memory status distribution, recent memory events, fallback runs, harness snapshot count, average response time, safety risk and status distribution, import safety risk/status, recent safety events, harness runtime, model mode, tool policy, budget status, schema status, LLM usage, and trace tool distribution, fallback reason distribution, recent harness runs, and recent feedback correlated with harness run ids.

## Agent Runtime Architecture

The LangGraph workflow is deterministic-first so the product remains demoable without an API key. OpenAI-compatible model calls are used only as an enhancement inside the harness.

```text
input safety
  -> preference memory
  -> classifier
  -> retriever
  -> context expander
  -> impact analyst
  -> QA planner
  -> safety guardrails
  -> structured synthesizer
```

The `modelAdapter` boundary uses an OpenAI-compatible chat completions call when configured and otherwise reports deterministic offline retrieval. LLM transport failures, timeouts, context token budget overruns, HTTP errors, invalid JSON, and schema errors are reported through `harness.model_adapter` before the deterministic fallback is used. The `agentHarness` boundary records runtime metadata for each agent run: run id, model mode, provider, adapter, executed steps, duration, fallback status, fallback reason, schema status, budgets, budget status, read-only tool registry, checkpointing, and errors. The LangGraph workflow runs with `MemorySaver` and persists checkpoint summaries to SQLite `langgraph_checkpoints`; `/api/harness-run` returns checkpoints for the selected run, and `/api/langgraph-checkpoint` returns one checkpoint summary for read-only time-travel inspection. SQLite migration/backfill audit rows are kept in `schema_migrations` and surfaced through `/api/health` plus evaluation metrics. The tool policy is exposed as `mode: "read-only"`, `allow_external_network: false`, `allow_repository_writes: false`, and `allow_shell_execution: false`. `/api/chat` uses a lighter `Direct Chat Harness` with the same model adapter, schema validation, trace shape, deterministic fallback metadata, `memory_used`, pending `memory_suggestions`, input/retrieval/output safety reports, and guardrail details. `/api/onboarding` uses an `Onboarding Harness` for deterministic plan generation with the same trace, safety, guardrail, memory suggestion, and evaluation visibility conventions. Feedback records preserve `harness_run_id` when the answer came from an observable harness run. Repository files are treated as untrusted evidence; retrieved text is never promoted into system instructions. Sensitive-looking values, including API keys, tokens, passwords, credentials, and secrets, are redacted before repository context is sent to a model.

## API Surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Server, package version, git commit, Node runtime, environment, uptime, LLM configuration status, and effective request timeout. |
| `GET` | `/api/projects` | List imported projects without chunk bodies. |
| `POST` | `/api/import` | Import sample, public GitHub repository, or ZIP upload. |
| `POST` | `/api/chat` | Repository Q&A or standard impact analysis with lightweight harness and safety metadata. |
| `POST` | `/api/agent-impact` | LangGraph multi-agent impact workflow. |
| `POST` | `/api/onboarding` | Generate role-based onboarding plan. |
| `POST` | `/api/feedback` | Record answer feedback. |
| `GET` | `/api/evaluation` | Return quality, memory, safety, and fallback metrics. |
| `GET` | `/api/harness-run` | Return one persisted harness run audit by `projectId` and `runId`. |
| `GET` | `/api/langgraph-checkpoint` | Return one persisted LangGraph checkpoint summary by `projectId`, `runId`, and `checkpointId` for read-only time-travel inspection. |
| `GET` | `/api/memory` | Return confirmed preferences, recent memory suggestions, memory audit events, and long-term memories for the resolved user. Supports `X-User-Id` or `userId`, plus `projectId`, `q`/`query`, `status=active|forgotten|superseded|all`, and `limit` for memory inspection. |
| `POST` | `/api/memory/confirm` | Confirm a pending memory suggestion for the resolved user and update preferences. |
| `POST` | `/api/memory/forget` | Ignore a suggestion, clear one preference, or clear all preferences for the resolved user. |

Error responses keep a human-readable `error` string and add a machine-readable `code`. Memory endpoints currently use:

- `MEMORY_SUGGESTION_NOT_FOUND`
- `MEMORY_SUGGESTION_NOT_PENDING`
- `MEMORY_PROJECT_MISMATCH`
- `MEMORY_USER_MISMATCH`
- `UNKNOWN_MEMORY_PREFERENCE_KEY`
- `UNKNOWN_MEMORY_PREFERENCE_VALUE`
- `AUTH_REQUIRED`
- `AUTH_INVALID`
- `AUTH_USER_MISMATCH`

Common API errors include:

- `PROJECT_REQUIRED`
- `PROJECT_NOT_FOUND`
- `INVALID_GITHUB_REPO`
- `GITHUB_IMPORT_FAILED`
- `GITHUB_IMPORT_TIMEOUT`
- `IMPORT_SOURCE_REQUIRED`
- `IMPORT_INVALID_ZIP`
- `IMPORT_TOO_LARGE`
- `NO_SUPPORTED_FILES`
- `REQUEST_BODY_TOO_LARGE`
- `QUESTION_REQUIRED`
- `ANSWER_NOT_FOUND`
- `RUN_ID_REQUIRED`
- `HARNESS_RUN_NOT_FOUND`
- `CHECKPOINT_ID_REQUIRED`
- `LANGGRAPH_CHECKPOINT_NOT_FOUND`
- `INVALID_FEEDBACK_TYPE`
- `ROUTE_NOT_FOUND`

`/api/agent-impact` remains compatible with the existing frontend and adds these fields:

- `memory_used`: confirmed preference memory applied to the run.
- `memory_suggestions`: pending suggestions that require explicit user confirmation.
- `harness`: LangGraph runtime, run id, model mode, model adapter, executed steps, duration, fallback status, fallback reason, schema status, budgets, budget status, read-only tool registry, model error codes, and errors.
- `safety`: aggregate safety status, risk types, and guardrail checks.

`GET /api/memory` returns `long_term_memories` plus `long_term_memory_query` so the UI and tests can verify which query, status filter, limit, `embedding_model`, and `vector_search` setting produced the memory list.

Evaluation metrics are scoped to the requested `projectId`, so safety status, output redaction counts, recent redaction events, memory status, memory event action counts, recent memory events, harness runtime, model mode, tool policy, recent tool policy events, budget status, schema status, LLM usage, trace tool usage, fallback, response-time counts, recent safety events, recent harness runs, recent LangGraph checkpoints, recent schema migrations, and recent feedback run correlation reflect the currently selected imported repository. Metrics ignore unknown feedback types so old or manually edited store data cannot pollute quality rates and failure-reason counts.

Memory confirmations, ignored suggestions, selective forgets, and full preference clears are recorded under `memoryEvents` so preference changes remain auditable without writing unconfirmed suggestions into long-lived memory.

`GET /api/harness-run` returns a persisted harness run audit for one `projectId` and `runId`, including the stored run snapshot plus answer trace, harness, safety, guardrail metadata, and persisted LangGraph checkpoint summaries. `GET /api/langgraph-checkpoint` returns one checkpoint summary plus a read-only `time_travel` note; it does not replay or mutate graph state.

Safety payloads include `risk_details`, a normalized explanation list for each risk type so review screens can show why guardrails were triggered. Output guardrails scan the raw generated payload first, then redact credential-like strings before the payload is stored or returned. When redaction occurs, `safety.output_redaction` records whether redaction was applied and how many credential-like matches were replaced, without storing the raw values.

See [docs/AGENT_RUNTIME_ARCHITECTURE.md](docs/AGENT_RUNTIME_ARCHITECTURE.md) for the LangGraph, memory, harness, and safety implementation boundary.

See [docs/PRD.md](docs/PRD.md) for the product requirements and roadmap.
