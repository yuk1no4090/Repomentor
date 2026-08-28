import { readFile } from "node:fs/promises";
import { readServerSource, readFrontendSource } from "./shared/source-reader.js";

// SLIM-A consolidation note: this file used to pin ~50 more server-source
// snippets -- every long-term-memory/schema-migration/vector-index/backup
// function name, the memory_items/memory_items_fts/schema_migrations table
// DDL, every MEMORY_*/OPENAI_EMBEDDING_* env var name, the qdrant/pinecone
// provider literals, every /api/memory/* route string, and the
// MEMORY_BACKUP_CHECKSUM_MISMATCH/MEMORY_RESTORE_CONFIRMATION_REQUIRED error
// codes. All of that is now proven -- more strongly, through the real call
// path -- by this file's own behavioral companions:
//   - scripts/embedding-provider-test.js (test:embedding): spawns the real
//     server with MEMORY_EMBEDDING_PROVIDER/OPENAI_EMBEDDING_BASE_URL/
//     OPENAI_EMBEDDING_MODEL/MEMORY_VECTOR_INDEX_PROVIDER/
//     MEMORY_VECTOR_INDEX_URL actually set (looping over both "qdrant" and
//     "pinecone"), and asserts the real health.memory_embedding/
//     health.memory_vector_index fields, the real confirmed long-term
//     memory's embedding.model/embedding.dims, and the real
//     long_term_memory_query.{embedding_provider,embedding_model,
//     vector_index_provider} fields against a fake embedding + vector-index
//     server (upsert/query counts, models seen).
//   - scripts/memory-compaction-test.js (test:memory): asserts the real
//     default (local) embedding_model === "local-hash-v1" and per-item
//     embedding availability, plus compactLongTermPreferenceMemories()'s and
//     refreshLongTermMemorySummary()'s real effect (status=superseded,
//     preference_summary memories).
//   - scripts/smoke-test.js: real /api/memory/status, /api/memory/backup,
//     /api/memory/backups, /api/memory/restore-plan, /api/memory/restore
//     calls asserting the real sha256 checksum, the real
//     MEMORY_BACKUP_CHECKSUM_MISMATCH / MEMORY_RESTORE_CONFIRMATION_REQUIRED
//     payload.code values, and the real schema_migration_count /
//     recent_schema_migrations fields.
//   - scripts/user-memory-isolation-test.js: real per-user long-term memory
//     isolation (implies searchLongTermMemory/listLongTermMemories/
//     upsertLongTermMemoryFromSuggestion all work end-to-end).
//
// What remains here is what none of those behavioral suites exercise with an
// override: MEMORY_DB_PATH, MEMORY_EMBEDDING_MODEL, and MEMORY_EMBEDDING_DIMS
// are read as env vars that let an operator override the DB location/default
// embedding identity, but every behavioral suite above only ever observes
// their DEFAULT values (no test sets these three to a non-default value and
// checks the override took effect) -- so a regression that silently dropped
// override support for these three specifically would not be caught by any
// currently-running test. The frontend app.js snippets are kept unconditionally
// (see check-frontend-agent-ui.js's own note on why: test:ui does not render
// app.js in a browser-like environment, so a source-text pin is the only
// guard against a regression in these specific UI code paths).

const [serverSource, appSource, readme, architectureDoc] = await Promise.all([
  readServerSource(),
  readFrontendSource(),
  readFile("README.md", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8")
]);

const requiredServerSnippets = [
  "MEMORY_DB_PATH",
  "MEMORY_EMBEDDING_MODEL",
  "MEMORY_EMBEDDING_DIMS"
];

const requiredAppSnippets = [
  "state.memory?.long_term_memories",
  "Long-term memory",
  "No long-term memories yet.",
  "payload.long_term_memories || state.memory?.long_term_memories || []"
];

const requiredDocSnippets = [
  "MEMORY_DB_PATH",
  "SQLite",
  "memory_items",
  "long-term memory",
  "long_term_memory_query",
  "superseded",
  "preference_summary",
  "embedding_model",
  "MEMORY_VECTOR_INDEX_PROVIDER",
  "HTTP-compatible vector index",
  "Qdrant",
  "Pinecone",
  "schema_migrations",
  "/api/memory/status",
  "/api/memory/backups",
  "/api/memory/backup",
  "/api/memory/restore-plan",
  "/api/memory/restore",
  "SHA-256 checksum"
];

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (packageJson.scripts["test:embedding"] !== "node scripts/embedding-provider-test.js") {
  throw new Error("package.json is missing test:embedding script");
}

const missingServerSnippets = requiredServerSnippets.filter((snippet) => !serverSource.includes(snippet));
const missingAppSnippets = requiredAppSnippets.filter((snippet) => !appSource.includes(snippet));
const combinedDocs = `${readme}\n${architectureDoc}`;
const missingDocSnippets = requiredDocSnippets.filter((snippet) => !combinedDocs.includes(snippet));

if (missingServerSnippets.length || missingAppSnippets.length || missingDocSnippets.length) {
  console.error(JSON.stringify({
    missingServerSnippets,
    missingAppSnippets,
    missingDocSnippets
  }, null, 2));
  throw new Error("Long-term memory contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  serverSnippets: requiredServerSnippets.length,
  appSnippets: requiredAppSnippets.length,
  docSnippets: requiredDocSnippets.length
}, null, 2));
