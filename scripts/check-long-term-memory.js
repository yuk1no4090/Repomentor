import { readFile } from "node:fs/promises";
import { readServerSource, readFrontendSource } from "./shared/source-reader.js";

const [serverSource, appSource, readme, architectureDoc] = await Promise.all([
  readServerSource(),
  readFrontendSource(),
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
  "MEMORY_EMBEDDING_PROVIDER",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_BASE_URL",
  "MEMORY_VECTOR_INDEX_PROVIDER",
  "MEMORY_VECTOR_INDEX_URL",
  "function resolveMemoryVectorIndexMode",
  "provider: \"qdrant\"",
  "provider: \"pinecone\"",
  "function qdrantFilter",
  "function pineconeFilter",
  "function upsertMemoryVectorIndex",
  "function queryMemoryVectorIndex",
  "function createExternalMemoryEmbedding",
  "function memoryEmbeddingFieldsAsync",
  "embedding_json",
  "function createLocalMemoryEmbedding",
  "function rankLongTermMemoryByVector",
  "function normalizeLongTermMemoryStatusFilter",
  "function compactLongTermPreferenceMemories",
  "function refreshLongTermMemorySummary",
  "function getMemoryDatabaseStatus",
  "function createMemoryDatabaseBackup",
  "function listMemoryDatabaseBackups",
  "function createMemoryDatabaseRestorePlan",
  "function restoreMemoryDatabaseFromBackup",
  "function closeMemoryDatabase",
  "preference_summary",
  "memory_compaction",
  "long_term_memory_query",
  "memory_database",
  "vector_index_provider",
  "\"/api/memory/status\"",
  "\"/api/memory/backups\"",
  "\"/api/memory/backup\"",
  "\"/api/memory/restore-plan\"",
  "\"/api/memory/restore\"",
  "MEMORY_BACKUP_CHECKSUM_MISMATCH",
  "MEMORY_RESTORE_CONFIRMATION_REQUIRED",
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
