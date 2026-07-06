import { readFile } from "node:fs/promises";

const [serverSource, appSource, readme, architectureDoc] = await Promise.all([
  readFile("server.js", "utf8"),
  readFile("public/app.js", "utf8"),
  readFile("README.md", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8")
]);

const requiredServerSnippets = [
  "import { DatabaseSync } from \"node:sqlite\"",
  "MEMORY_DB_PATH",
  "CREATE TABLE IF NOT EXISTS memory_items",
  "CREATE VIRTUAL TABLE memory_items_fts",
  "function upsertLongTermMemoryFromSuggestion",
  "function markLongTermMemoryForgotten",
  "function searchLongTermMemory",
  "function listLongTermMemories",
  "CREATE TABLE IF NOT EXISTS schema_migrations",
  "function recordSchemaMigration",
  "function listSchemaMigrations",
  "schema_migration_count",
  "recent_schema_migrations",
  "MEMORY_EMBEDDING_MODEL",
  "MEMORY_EMBEDDING_DIMS",
  "embedding_json",
  "function createLocalMemoryEmbedding",
  "function rankLongTermMemoryByVector",
  "function normalizeLongTermMemoryStatusFilter",
  "function compactLongTermPreferenceMemories",
  "function refreshLongTermMemorySummary",
  "preference_summary",
  "memory_compaction",
  "long_term_memory_query",
  "vector_search",
  "long_term_memories",
  "long_term:"
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
  "schema_migrations"
];

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
