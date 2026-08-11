import { promises as fs, readFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_USER_ID,
  MEMORY_DB_PATH,
  MEMORY_EMBEDDING_MODEL,
  MEMORY_EMBEDDING_DIMS,
  MEMORY_EMBEDDING_PROVIDER,
  MEMORY_VECTOR_INDEX_PROVIDER,
  LLM_REQUEST_TIMEOUT_MS,
  apiError
} from "./config.js";

let memoryDb = null;
let memoryDbFtsEnabled = false;

// ── Prepared statement + transaction helpers ──
// node:sqlite's db.prepare() is cheap relative to running a query, but it is
// not free, and a handful of hot paths (long-term memory retrieval in
// particular) used to call db.prepare() fresh on every loop iteration for a
// statement whose SQL text never changes. getCachedStatement() memoizes
// prepared statements by SQL text for the lifetime of the current `memoryDb`
// connection. The cache is deliberately reset alongside memoryDb itself
// (see closeMemoryDatabase()) so a restore-from-backup — which closes and
// reopens the connection against a swapped-out file — never hands out a
// statement prepared against the now-closed handle.
let memoryDbStatementCache = null;

function getCachedStatement(db, sql) {
  if (!memoryDbStatementCache) memoryDbStatementCache = new Map();
  let statement = memoryDbStatementCache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    memoryDbStatementCache.set(sql, statement);
  }
  return statement;
}

// Wraps a synchronous batch of statements in a transaction so multi-row writes
// (bulk inserts/updates) commit as a single unit instead of one implicit
// transaction per statement. `fn` must be fully synchronous — node:sqlite's
// DatabaseSync has no notion of an async-safe transaction, so anything that
// awaits between BEGIN and COMMIT/ROLLBACK would let unrelated code from
// elsewhere in the process interleave its own statements into this
// transaction on the same connection.
function runInSqliteTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // No active transaction to roll back (e.g. BEGIN itself failed) — the
      // original error is what matters here.
    }
    throw error;
  }
}

function ensureSchemaMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schema_migrations_scope ON schema_migrations(scope, applied_at);
  `);
}

function recordSchemaMigration(db, id, description, scope = "sqlite") {
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (id, scope, description, applied_at)
    VALUES (?, ?, ?, ?)
  `).run(id, scope, description, new Date().toISOString());
}

function listSchemaMigrations(limit = 20) {
  const db = getMemoryDatabase();
  return db.prepare(`
    SELECT id, scope, description, applied_at
    FROM schema_migrations
    ORDER BY applied_at DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    id: row.id,
    scope: row.scope,
    description: row.description,
    appliedAt: row.applied_at
  }));
}

// The FTS index used to be unconditionally dropped and rebuilt from scratch
// on every process start/reconnect, which means every restart paid an O(rows)
// cost even when the index was already correct — the common case, since every
// write path that touches memory_items content also calls syncMemoryFtsRow()
// to keep memory_items_fts in sync incrementally. Only fall back to a full
// rebuild when the table is missing outright or its row count has drifted
// from memory_items (both cheap COUNT(*) checks), which also self-heals the
// index if it were ever to fall out of sync.
function memoryFtsTableExists(db) {
  return !!db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_items_fts'
  `).get();
}

function memoryFtsNeedsRebuild(db) {
  if (!memoryFtsTableExists(db)) return true;
  const ftsCount = db.prepare("SELECT COUNT(*) AS count FROM memory_items_fts").get()?.count || 0;
  const itemsCount = db.prepare("SELECT COUNT(*) AS count FROM memory_items").get()?.count || 0;
  return ftsCount !== itemsCount;
}

function getMemoryDatabase() {
  if (memoryDb) return memoryDb;
  mkdirSync(path.dirname(MEMORY_DB_PATH), { recursive: true });
  memoryDb = new DatabaseSync(MEMORY_DB_PATH);
  ensureSchemaMigrationTable(memoryDb);
  memoryDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      project_id TEXT,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT,
      value TEXT,
      label TEXT,
      content TEXT NOT NULL,
      embedding_json TEXT,
      embedding_model TEXT,
      embedding_updated_at TEXT,
      source TEXT,
      confidence TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_items_project_status ON memory_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_memory_items_key_status ON memory_items(key, status);
    CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id TEXT,
      thread_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      source TEXT,
      step INTEGER,
      node TEXT,
      metadata_json TEXT,
      state_summary_json TEXT,
      resume_input_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_run ON langgraph_checkpoints(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_project ON langgraph_checkpoints(project_id, created_at);
    CREATE TABLE IF NOT EXISTS langgraph_checkpoint_payloads (
      run_id TEXT PRIMARY KEY,
      project_id TEXT,
      thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoint_payloads_project ON langgraph_checkpoint_payloads(project_id, created_at);
  `);
  recordSchemaMigration(memoryDb, "001_base_memory_and_checkpoints", "Create memory_items and langgraph_checkpoints base tables.");
  const memoryColumns = memoryDb.prepare("PRAGMA table_info(memory_items)").all().map((column) => column.name);
  const checkpointColumns = memoryDb.prepare("PRAGMA table_info(langgraph_checkpoints)").all().map((column) => column.name);
  if (!memoryColumns.includes("user_id")) {
    memoryDb.exec(`ALTER TABLE memory_items ADD COLUMN user_id TEXT;`);
  }
  recordSchemaMigration(memoryDb, "002_memory_items_user_id", "Add user_id to memory_items for user-scoped long-term memory.");
  if (!memoryColumns.includes("embedding_json")) {
    memoryDb.exec(`ALTER TABLE memory_items ADD COLUMN embedding_json TEXT;`);
  }
  recordSchemaMigration(memoryDb, "003_memory_items_embedding_json", "Add embedding_json to memory_items for local vector retrieval.");
  if (!memoryColumns.includes("embedding_model")) {
    memoryDb.exec(`ALTER TABLE memory_items ADD COLUMN embedding_model TEXT;`);
  }
  recordSchemaMigration(memoryDb, "004_memory_items_embedding_model", "Add embedding_model to memory_items.");
  if (!memoryColumns.includes("embedding_updated_at")) {
    memoryDb.exec(`ALTER TABLE memory_items ADD COLUMN embedding_updated_at TEXT;`);
  }
  recordSchemaMigration(memoryDb, "005_memory_items_embedding_updated_at", "Add embedding_updated_at to memory_items.");
  const userBackfill = memoryDb.prepare("UPDATE memory_items SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(DEFAULT_USER_ID);
  if (userBackfill.changes) {
    recordSchemaMigration(memoryDb, "006_backfill_default_user_id", "Backfill legacy memory rows to the default local user.");
  }
  memoryDb.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_user_status ON memory_items(user_id, status);`);
  recordSchemaMigration(memoryDb, "007_memory_items_user_status_index", "Create user/status index for memory_items.");
  if (!checkpointColumns.includes("resume_input_json")) {
    memoryDb.exec(`ALTER TABLE langgraph_checkpoints ADD COLUMN resume_input_json TEXT;`);
  }
  recordSchemaMigration(memoryDb, "010_langgraph_checkpoint_resume_input", "Add replayable resume input snapshots to LangGraph checkpoints.");
  memoryDb.exec(`
    CREATE TABLE IF NOT EXISTS langgraph_checkpoint_payloads (
      run_id TEXT PRIMARY KEY,
      project_id TEXT,
      thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoint_payloads_project ON langgraph_checkpoint_payloads(project_id, created_at);
  `);
  recordSchemaMigration(memoryDb, "011_langgraph_checkpoint_payloads", "Persist sanitized MemorySaver payloads for executable checkpoint continuation.");
  const embeddingBackfill = hydrateMissingMemoryEmbeddings(memoryDb);
  if (embeddingBackfill) {
    recordSchemaMigration(memoryDb, "008_backfill_memory_embeddings", "Backfill local embeddings for existing memory rows.");
  }
  try {
    if (memoryFtsNeedsRebuild(memoryDb)) {
      memoryDb.exec(`
        DROP TABLE IF EXISTS memory_items_fts;
        CREATE VIRTUAL TABLE memory_items_fts
        USING fts5(memory_id UNINDEXED, content, key, value, label);
      `);
      memoryDbFtsEnabled = true;
      rebuildMemoryFtsIndex(memoryDb);
    } else {
      memoryDbFtsEnabled = true;
    }
    recordSchemaMigration(memoryDb, "009_rebuild_memory_fts", "Rebuild memory_items FTS index.");
  } catch (error) {
    memoryDbFtsEnabled = false;
    console.warn(`[memory] FTS5 unavailable for ${MEMORY_DB_PATH}; falling back to LIKE search. ${error.message}`);
  }
  return memoryDb;
}

function closeMemoryDatabase() {
  if (!memoryDb) return;
  try {
    memoryDb.close();
  } finally {
    memoryDb = null;
    memoryDbFtsEnabled = false;
    // Statements cached via getCachedStatement() are bound to the connection
    // we just closed; drop them so the next getMemoryDatabase() call starts a
    // fresh cache against the new connection instead of handing out
    // statements prepared on a now-invalid handle (e.g. after
    // restoreMemoryDatabaseFromBackup() swaps the underlying file).
    memoryDbStatementCache = null;
  }
}

function getMemoryDatabaseStatus() {
  const db = getMemoryDatabase();
  const memoryCounts = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM memory_items
    GROUP BY status
    ORDER BY status
  `).all().map((row) => ({
    status: row.status || "unknown",
    count: Number(row.count || 0)
  }));
  const memoryTypeCounts = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM memory_items
    GROUP BY type
    ORDER BY type
  `).all().map((row) => ({
    type: row.type || "unknown",
    count: Number(row.count || 0)
  }));
  const embeddingRows = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN embedding_json IS NOT NULL AND embedding_json != '' THEN 1 ELSE 0 END) AS embedded
    FROM memory_items
  `).get();
  const checkpointCount = db.prepare("SELECT COUNT(*) AS count FROM langgraph_checkpoints").get();
  const checkpointPayloadCount = db.prepare("SELECT COUNT(*) AS count FROM langgraph_checkpoint_payloads").get();
  const migrationCount = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get();
  const latestMemory = db.prepare("SELECT MAX(updated_at) AS updated_at FROM memory_items").get();
  let sizeBytes = 0;
  try {
    // Only the byte length is needed here, so stat the file instead of
    // reading the whole (potentially large) database into memory just to
    // measure it.
    sizeBytes = statSync(MEMORY_DB_PATH).size;
  } catch {
    sizeBytes = 0;
  }
  return {
    store: "SQLite memory database",
    path_basename: path.basename(MEMORY_DB_PATH),
    directory_basename: path.basename(path.dirname(MEMORY_DB_PATH)),
    size_bytes: sizeBytes,
    fts_enabled: memoryDbFtsEnabled,
    embedding_model: resolveMemoryEmbeddingMode().model,
    embedding_provider: resolveMemoryEmbeddingMode().provider,
    vector_index_provider: resolveMemoryVectorIndexMode().provider,
    vector_search: true,
    memory_counts: memoryCounts,
    memory_type_counts: memoryTypeCounts,
    embedded_memory_items: Number(embeddingRows?.embedded || 0),
    total_memory_items: Number(embeddingRows?.total || 0),
    langgraph_checkpoint_count: Number(checkpointCount?.count || 0),
    langgraph_checkpoint_payload_count: Number(checkpointPayloadCount?.count || 0),
    schema_migration_count: Number(migrationCount?.count || 0),
    latest_memory_updated_at: latestMemory?.updated_at || null
  };
}

async function createMemoryDatabaseBackup() {
  const db = getMemoryDatabase();
  db.exec("PRAGMA wal_checkpoint(FULL);");
  await fs.mkdir(path.dirname(MEMORY_DB_PATH), { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(path.dirname(MEMORY_DB_PATH), `memory-${timestamp}.sqlite.bak`);
  await fs.copyFile(MEMORY_DB_PATH, backupPath);
  const bytes = readFileSync(backupPath);
  return {
    store: "SQLite memory database",
    path_basename: path.basename(backupPath),
    directory_basename: path.basename(path.dirname(backupPath)),
    size_bytes: bytes.byteLength,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    createdAt: new Date().toISOString()
  };
}

async function listMemoryDatabaseBackups() {
  await fs.mkdir(path.dirname(MEMORY_DB_PATH), { recursive: true });
  const entries = await fs.readdir(path.dirname(MEMORY_DB_PATH), { withFileTypes: true });
  const backups = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^memory-.+\.sqlite\.bak$/.test(entry.name))
    .map(async (entry) => {
      const backupPath = path.join(path.dirname(MEMORY_DB_PATH), entry.name);
      const stats = await fs.stat(backupPath);
      return {
        path_basename: entry.name,
        directory_basename: path.basename(path.dirname(backupPath)),
        size_bytes: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString()
      };
    }));
  backups.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
  return backups;
}

function resolveMemoryBackupPath(backupName) {
  const basename = path.basename(String(backupName || "").trim());
  if (!/^memory-.+\.sqlite\.bak$/.test(basename)) {
    throw apiError("Backup basename is required.", "MEMORY_BACKUP_REQUIRED");
  }
  const backupPath = path.join(path.dirname(MEMORY_DB_PATH), basename);
  const resolvedBackupPath = path.resolve(backupPath);
  const resolvedMemoryDir = path.resolve(path.dirname(MEMORY_DB_PATH));
  if (path.dirname(resolvedBackupPath) !== resolvedMemoryDir) {
    throw apiError("Backup path is outside the memory database directory.", "MEMORY_BACKUP_INVALID", 400);
  }
  return resolvedBackupPath;
}

function createMemoryDatabaseRestorePlan({ backupName, expectedSha256 = null } = {}) {
  getMemoryDatabase();
  const backupPath = resolveMemoryBackupPath(backupName);
  let bytes;
  try {
    bytes = readFileSync(backupPath);
  } catch {
    throw apiError("Memory database backup not found.", "MEMORY_BACKUP_NOT_FOUND", 404);
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && String(expectedSha256).toLowerCase() !== sha256) {
    throw apiError("Backup checksum does not match expected SHA-256.", "MEMORY_BACKUP_CHECKSUM_MISMATCH", 409);
  }
  const current = getMemoryDatabaseStatus();
  return {
    mode: "restore plan",
    executable: false,
    backup: {
      path_basename: path.basename(backupPath),
      directory_basename: path.basename(path.dirname(backupPath)),
      size_bytes: bytes.byteLength,
      sha256
    },
    current_database: {
      path_basename: current.path_basename,
      size_bytes: current.size_bytes,
      total_memory_items: current.total_memory_items,
      schema_migration_count: current.schema_migration_count,
      langgraph_checkpoint_count: current.langgraph_checkpoint_count
    },
    steps: [
      "Stop application writes.",
      "Create a fresh backup of the current memory database.",
      "Verify the selected backup SHA-256 checksum.",
      "Replace the memory database file while the application is stopped.",
      "Restart the application and verify /api/memory/status."
    ],
    note: "This endpoint validates a backup and returns a rollback plan only; it does not replace or mutate the active SQLite database."
  };
}

async function restoreMemoryDatabaseFromBackup({ backupName, expectedSha256, confirm } = {}) {
  if (confirm !== "RESTORE_MEMORY_DATABASE") {
    throw apiError("Restore confirmation phrase is required.", "MEMORY_RESTORE_CONFIRMATION_REQUIRED", 400);
  }
  if (!expectedSha256) {
    throw apiError("Restore requires an expected SHA-256 checksum.", "MEMORY_RESTORE_CHECKSUM_REQUIRED", 400);
  }
  const restorePlan = createMemoryDatabaseRestorePlan({ backupName, expectedSha256 });
  const currentBackup = await createMemoryDatabaseBackup();
  const backupPath = resolveMemoryBackupPath(backupName);
  const tempRestorePath = path.join(
    path.dirname(MEMORY_DB_PATH),
    `.memory-restore-${process.pid}-${Date.now()}.sqlite.tmp`
  );
  closeMemoryDatabase();
  try {
    await fs.copyFile(backupPath, tempRestorePath);
    await fs.copyFile(tempRestorePath, MEMORY_DB_PATH);
    await fs.unlink(tempRestorePath).catch(() => {});
    await fs.unlink(`${MEMORY_DB_PATH}-wal`).catch(() => {});
    await fs.unlink(`${MEMORY_DB_PATH}-shm`).catch(() => {});
    const restoredStatus = getMemoryDatabaseStatus();
    return {
      mode: "restore executed",
      restored: true,
      backup: restorePlan.backup,
      pre_restore_backup: currentBackup,
      restored_database: {
        path_basename: restoredStatus.path_basename,
        size_bytes: restoredStatus.size_bytes,
        total_memory_items: restoredStatus.total_memory_items,
        schema_migration_count: restoredStatus.schema_migration_count,
        langgraph_checkpoint_count: restoredStatus.langgraph_checkpoint_count
      },
      note: "The selected backup replaced the active SQLite memory database. The previous active database was backed up first."
    };
  } catch (error) {
    await fs.unlink(tempRestorePath).catch(() => {});
    closeMemoryDatabase();
    getMemoryDatabase();
    throw error;
  }
}

function normalizeLongTermMemoryItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    id: String(item.id || crypto.randomUUID()),
    userId: item.user_id || item.userId || DEFAULT_USER_ID,
    projectId: item.project_id || item.projectId || null,
    scope: item.scope || "user",
    type: item.type || "preference",
    key: item.key || null,
    value: item.value || null,
    label: item.label || item.key || "Long-term memory",
    content: item.content || "",
    embedding: {
      available: !!item.embedding_json,
      model: item.embedding_model || null,
      dims: parseMemoryEmbedding(item.embedding_json)?.length || 0,
      updatedAt: item.embedding_updated_at || null,
      score: Number.isFinite(Number(item.vector_score)) ? Number(item.vector_score) : null
    },
    source: item.source || "memory",
    confidence: item.confidence || "medium",
    status: item.status || "active",
    createdAt: item.created_at || item.createdAt || null,
    updatedAt: item.updated_at || item.updatedAt || null,
    lastUsedAt: item.last_used_at || item.lastUsedAt || null
  };
}

function tokenizeMemoryEmbeddingText(text) {
  return [...String(text || "").toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)]
    .map((match) => match[0])
    .filter((token) => token.length >= 2)
    .slice(0, 120);
}

function hashEmbeddingToken(token) {
  const hash = crypto.createHash("sha256").update(token).digest();
  return {
    index: hash[0] % MEMORY_EMBEDDING_DIMS,
    sign: hash[1] % 2 === 0 ? 1 : -1,
    weight: 1 + (hash[2] % 3) / 10
  };
}

function createLocalMemoryEmbedding(text) {
  const vector = Array.from({ length: MEMORY_EMBEDDING_DIMS }, () => 0);
  tokenizeMemoryEmbeddingText(text).forEach((token) => {
    const { index, sign, weight } = hashEmbeddingToken(token);
    vector[index] += sign * weight;
  });
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function parseMemoryEmbedding(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed.map((item) => Number(item) || 0);
  } catch {
    return null;
  }
}

function memoryEmbeddingInput(row) {
  return [
    row.type,
    row.key,
    row.value,
    row.label,
    row.content
  ].filter(Boolean).join(" ");
}

function memoryEmbeddingFields(row, now = new Date().toISOString()) {
  return {
    embeddingJson: JSON.stringify(createLocalMemoryEmbedding(memoryEmbeddingInput(row))),
    embeddingModel: MEMORY_EMBEDDING_MODEL,
    embeddingUpdatedAt: now
  };
}

function resolveMemoryEmbeddingMode() {
  const provider = MEMORY_EMBEDDING_PROVIDER || (process.env.OPENAI_EMBEDDING_MODEL ? "openai" : "local");
  const apiKey = process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "";
  if ((provider === "openai" || provider === "openai-compatible") && apiKey) {
    return {
      provider: "openai-compatible",
      model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      endpoint: `${(process.env.OPENAI_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "")}/v1/embeddings`,
      apiKey
    };
  }
  return {
    provider: "local",
    model: MEMORY_EMBEDDING_MODEL,
    endpoint: null,
    apiKey: null
  };
}

function resolveMemoryVectorIndexMode() {
  const endpoint = String(process.env.MEMORY_VECTOR_INDEX_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.MEMORY_VECTOR_INDEX_API_KEY || "";
  if ((MEMORY_VECTOR_INDEX_PROVIDER === "http" || MEMORY_VECTOR_INDEX_PROVIDER === "http-compatible") && endpoint) {
    return {
      provider: "http-compatible",
      endpoint,
      apiKey,
      namespace: process.env.MEMORY_VECTOR_INDEX_NAMESPACE || "ai-pm-memory"
    };
  }
  if ((MEMORY_VECTOR_INDEX_PROVIDER === "qdrant" || MEMORY_VECTOR_INDEX_PROVIDER === "qdrant-cloud") && endpoint) {
    return {
      provider: "qdrant",
      endpoint,
      apiKey,
      namespace: process.env.MEMORY_VECTOR_INDEX_NAMESPACE || "ai_pm_memory"
    };
  }
  if (MEMORY_VECTOR_INDEX_PROVIDER === "pinecone" && endpoint) {
    return {
      provider: "pinecone",
      endpoint,
      apiKey,
      namespace: process.env.MEMORY_VECTOR_INDEX_NAMESPACE || "ai-pm-memory"
    };
  }
  return {
    provider: "local-sqlite",
    endpoint: null,
    apiKey: null,
    namespace: "memory_items"
  };
}

function normalizeEmbeddingVector(vector) {
  const numeric = Array.isArray(vector)
    ? vector.map((value) => Number(value) || 0)
    : [];
  const norm = Math.sqrt(numeric.reduce((sum, value) => sum + value * value, 0));
  if (!numeric.length || !norm) return null;
  return numeric.map((value) => Number((value / norm).toFixed(6)));
}

async function createExternalMemoryEmbedding(text, mode = resolveMemoryEmbeddingMode()) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(mode.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mode.apiKey}`
      },
      body: JSON.stringify({
        model: mode.model,
        input: String(text || "").slice(0, 8000)
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status}`);
    }
    const vector = normalizeEmbeddingVector(payload?.data?.[0]?.embedding);
    if (!vector) throw new Error("embedding response did not contain a numeric vector");
    return vector;
  } finally {
    clearTimeout(timeout);
  }
}

async function memoryEmbeddingFieldsAsync(row, now = new Date().toISOString()) {
  const input = memoryEmbeddingInput(row);
  const mode = resolveMemoryEmbeddingMode();
  if (mode.provider === "openai-compatible") {
    try {
      return {
        embeddingJson: JSON.stringify(await createExternalMemoryEmbedding(input, mode)),
        embeddingModel: mode.model,
        embeddingUpdatedAt: now
      };
    } catch (error) {
      console.warn(`[memory] External embedding failed; falling back to ${MEMORY_EMBEDDING_MODEL}. ${error.message}`);
    }
  }
  return memoryEmbeddingFields(row, now);
}

async function createMemoryQueryEmbedding(query) {
  const mode = resolveMemoryEmbeddingMode();
  if (mode.provider === "openai-compatible") {
    try {
      return {
        vector: await createExternalMemoryEmbedding(query, mode),
        model: mode.model
      };
    } catch (error) {
      console.warn(`[memory] External query embedding failed; falling back to ${MEMORY_EMBEDDING_MODEL}. ${error.message}`);
    }
  }
  return {
    vector: createLocalMemoryEmbedding(query),
    model: MEMORY_EMBEDDING_MODEL
  };
}

async function requestMemoryVectorIndex(pathname, body, mode = resolveMemoryVectorIndexMode()) {
  if (!["http-compatible", "qdrant", "pinecone"].includes(mode.provider)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${mode.endpoint}${pathname}`, {
      method: mode.provider === "qdrant" && pathname.includes("/points?") ? "PUT" : "POST",
      headers: {
        "content-type": "application/json",
        ...(mode.apiKey && mode.provider === "qdrant" ? { "api-key": mode.apiKey } : {}),
        ...(mode.apiKey && mode.provider === "pinecone" ? { "Api-Key": mode.apiKey } : {}),
        ...(mode.apiKey && mode.provider === "http-compatible" ? { authorization: `Bearer ${mode.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`memory vector index request failed: ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function qdrantFilter({ userId = DEFAULT_USER_ID, projectId = null, status = "active" } = {}) {
  const must = [
    { key: "user_id", match: { value: userId } },
    { key: "status", match: { value: status } }
  ];
  if (projectId) {
    must.push({ key: "project_id", match: { value: projectId } });
  }
  return { must };
}

function pineconeFilter({ userId = DEFAULT_USER_ID, projectId = null, status = "active" } = {}) {
  const filter = {
    user_id: { $eq: userId },
    status: { $eq: status }
  };
  if (projectId) {
    filter.project_id = { $eq: projectId };
  }
  return filter;
}

function memoryVectorMetadata(memoryRow) {
  return {
    user_id: memoryRow.user_id || DEFAULT_USER_ID,
    project_id: memoryRow.project_id || null,
    status: memoryRow.status || "active",
    type: memoryRow.type || "memory",
    key: memoryRow.key || null,
    value: memoryRow.value || null,
    label: memoryRow.label || null,
    content: memoryRow.content || "",
    embedding_model: memoryRow.embedding_model || null,
    updated_at: memoryRow.updated_at || null
  };
}

async function upsertMemoryVectorIndex(memoryRow) {
  const mode = resolveMemoryVectorIndexMode();
  if (!["http-compatible", "qdrant", "pinecone"].includes(mode.provider) || !memoryRow) {
    return { attempted: false, provider: mode.provider };
  }
  const vector = parseMemoryEmbedding(memoryRow.embedding_json);
  if (!vector?.length) {
    return { attempted: false, provider: mode.provider, reason: "missing_embedding" };
  }
  try {
    if (mode.provider === "qdrant") {
      await requestMemoryVectorIndex(`/collections/${encodeURIComponent(mode.namespace)}/points?wait=true`, {
        points: [{
          id: memoryRow.id,
          vector,
          payload: memoryVectorMetadata(memoryRow)
        }]
      }, mode);
    } else if (mode.provider === "pinecone") {
      await requestMemoryVectorIndex("/vectors/upsert", {
        namespace: mode.namespace,
        vectors: [{
          id: memoryRow.id,
          values: vector,
          metadata: memoryVectorMetadata(memoryRow)
        }]
      }, mode);
    } else {
      await requestMemoryVectorIndex("/upsert", {
        namespace: mode.namespace,
        vectors: [{
          id: memoryRow.id,
          values: vector,
          metadata: memoryVectorMetadata(memoryRow)
        }]
      }, mode);
    }
    return { attempted: true, provider: mode.provider, ok: true };
  } catch (error) {
    console.warn(`[memory] Remote vector upsert failed; local SQLite retrieval remains active. ${error.message}`);
    return { attempted: true, provider: mode.provider, ok: false, error: error.message };
  }
}

async function queryMemoryVectorIndex({ userId = DEFAULT_USER_ID, projectId = null, query = "", status = "active", limit = 5 } = {}) {
  const mode = resolveMemoryVectorIndexMode();
  if (!["http-compatible", "qdrant", "pinecone"].includes(mode.provider) || !query) {
    return { attempted: false, provider: mode.provider, rows: [] };
  }
  try {
    const queryEmbedding = await createMemoryQueryEmbedding(query);
    const payload = mode.provider === "qdrant"
      ? await requestMemoryVectorIndex(`/collections/${encodeURIComponent(mode.namespace)}/points/search`, {
        vector: queryEmbedding.vector,
        limit: Math.max(limit, 10),
        with_payload: false,
        filter: qdrantFilter({ userId, projectId, status })
      }, mode)
      : mode.provider === "pinecone"
        ? await requestMemoryVectorIndex("/query", {
          namespace: mode.namespace,
          vector: queryEmbedding.vector,
          topK: Math.max(limit, 10),
          includeValues: false,
          includeMetadata: false,
          filter: pineconeFilter({ userId, projectId, status })
        }, mode)
      : await requestMemoryVectorIndex("/query", {
        namespace: mode.namespace,
        vector: queryEmbedding.vector,
        topK: Math.max(limit, 10),
        filter: {
          user_id: userId,
          project_id: projectId,
          status
        }
      }, mode);
    const matches = mode.provider === "qdrant" ? (payload?.result || []) : (payload?.matches || []);
    const ids = matches
      .map((match) => String(match.id || "").trim())
      .filter(Boolean)
      .slice(0, 50);
    if (!ids.length) return { attempted: true, provider: mode.provider, rows: [] };
    const db = getMemoryDatabase();
    const filters = buildLongTermMemoryFilters({ userId, projectId, status });
    const placeholders = ids.map(() => "?").join(", ");
    const scoreById = new Map(matches.map((match) => [String(match.id), Number(match.score) || 0]));
    const rows = db.prepare(`
      SELECT m.* FROM memory_items m
      WHERE m.id IN (${placeholders})
        ${filters.sql}
    `).all(...ids, ...filters.params)
      .map((row) => ({ ...row, vector_score: scoreById.get(row.id) || 0 }))
      .sort((left, right) => {
        if (right.vector_score !== left.vector_score) return right.vector_score - left.vector_score;
        return ids.indexOf(left.id) - ids.indexOf(right.id);
      })
      .slice(0, limit);
    return { attempted: true, provider: mode.provider, rows };
  } catch (error) {
    console.warn(`[memory] Remote vector query failed; falling back to local SQLite vector search. ${error.message}`);
    return { attempted: true, provider: mode.provider, rows: [], error: error.message };
  }
}

function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function hydrateMissingMemoryEmbeddings(db) {
  const rows = db.prepare(`
    SELECT id, type, key, value, label, content FROM memory_items
    WHERE embedding_json IS NULL OR embedding_model IS NULL OR embedding_model != ?
  `).all(MEMORY_EMBEDDING_MODEL);
  if (!rows.length) return 0;
  const update = db.prepare(`
    UPDATE memory_items
    SET embedding_json = ?, embedding_model = ?, embedding_updated_at = ?
    WHERE id = ?
  `);
  const now = new Date().toISOString();
  runInSqliteTransaction(db, () => {
    rows.forEach((row) => {
      const embedding = memoryEmbeddingFields(row, now);
      update.run(embedding.embeddingJson, embedding.embeddingModel, embedding.embeddingUpdatedAt, row.id);
    });
  });
  return rows.length;
}

function syncMemoryFtsRow(db, memoryId) {
  if (!memoryDbFtsEnabled) return;
  const row = db.prepare("SELECT id, content, key, value, label FROM memory_items WHERE id = ?").get(memoryId);
  if (!row) return;
  db.prepare("DELETE FROM memory_items_fts WHERE memory_id = ?").run(row.id);
  db.prepare("INSERT INTO memory_items_fts(memory_id, content, key, value, label) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.content || "", row.key || "", row.value || "", row.label || "");
}

function rebuildMemoryFtsIndex(db) {
  if (!memoryDbFtsEnabled) return;
  const rows = db.prepare("SELECT id, content, key, value, label FROM memory_items").all();
  const insert = db.prepare("INSERT INTO memory_items_fts(memory_id, content, key, value, label) VALUES (?, ?, ?, ?, ?)");
  runInSqliteTransaction(db, () => {
    db.prepare("DELETE FROM memory_items_fts").run();
    rows.forEach((row) => {
      insert.run(row.id, row.content || "", row.key || "", row.value || "", row.label || "");
    });
  });
}

async function upsertLongTermMemoryFromSuggestion(suggestion) {
  if (!suggestion) return null;
  const db = getMemoryDatabase();
  const now = new Date().toISOString();
  const id = `suggestion_${suggestion.id}`;
  const content = [
    `User preference ${suggestion.key}: ${suggestion.value}.`,
    suggestion.label ? `Label: ${suggestion.label}.` : "",
    suggestion.reason ? `Reason: ${suggestion.reason}` : ""
  ].filter(Boolean).join(" ");
  const rowForEmbedding = {
    type: "preference",
    key: suggestion.key,
    value: String(suggestion.value),
    label: suggestion.label || suggestion.key,
    content
  };
  const embedding = await memoryEmbeddingFieldsAsync(rowForEmbedding, now);
  db.prepare(`
    INSERT INTO memory_items (
      id, user_id, project_id, scope, type, key, value, label, content, embedding_json, embedding_model, embedding_updated_at, source, confidence, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      user_id = excluded.user_id,
      scope = excluded.scope,
      type = excluded.type,
      key = excluded.key,
      value = excluded.value,
      label = excluded.label,
      content = excluded.content,
      embedding_json = excluded.embedding_json,
      embedding_model = excluded.embedding_model,
      embedding_updated_at = excluded.embedding_updated_at,
      source = excluded.source,
      confidence = excluded.confidence,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    id,
    suggestion.userId || DEFAULT_USER_ID,
    suggestion.projectId || null,
    "user",
    "preference",
    suggestion.key,
    String(suggestion.value),
    suggestion.label || suggestion.key,
    content,
    embedding.embeddingJson,
    embedding.embeddingModel,
    embedding.embeddingUpdatedAt,
    `memory_suggestion:${suggestion.id}`,
    suggestion.confidence || "medium",
    "active",
    suggestion.createdAt || now,
    now
  );
  compactLongTermPreferenceMemories({ userId: suggestion.userId || DEFAULT_USER_ID, projectId: suggestion.projectId || null, changedKey: suggestion.key, activeValue: String(suggestion.value) });
  syncMemoryFtsRow(db, id);
  await upsertMemoryVectorIndex(db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id));
  await refreshLongTermMemorySummary({ userId: suggestion.userId || DEFAULT_USER_ID, projectId: suggestion.projectId || null });
  return getLongTermMemoryById(id);
}

function compactLongTermPreferenceMemories({ userId = DEFAULT_USER_ID, projectId = null, changedKey = null, activeValue = null } = {}) {
  if (!["role", "language", "detailLevel"].includes(changedKey)) {
    return { superseded: 0 };
  }
  const db = getMemoryDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE memory_items
    SET status = 'superseded', updated_at = ?
    WHERE status = 'active'
      AND type = 'preference'
      AND key = ?
      AND value != ?
      AND user_id = ?
      AND (? IS NULL OR project_id = ? OR project_id IS NULL)
  `).run(now, changedKey, String(activeValue), userId, projectId, projectId);
  return { superseded: result.changes || 0 };
}

async function refreshLongTermMemorySummary({ userId = DEFAULT_USER_ID, projectId = null } = {}) {
  const db = getMemoryDatabase();
  const now = new Date().toISOString();
  const active = db.prepare(`
    SELECT key, value, label FROM memory_items
    WHERE status = 'active'
      AND type = 'preference'
      AND user_id = ?
      AND (? IS NULL OR project_id = ? OR project_id IS NULL)
    ORDER BY key ASC, updated_at DESC
  `).all(userId, projectId, projectId);
  const summaryId = `summary_${userId}_${projectId || "global"}_preferences`;
  if (!active.length) {
    db.prepare("UPDATE memory_items SET status = 'forgotten', updated_at = ? WHERE id = ?").run(now, summaryId);
    syncMemoryFtsRow(db, summaryId);
    return null;
  }
  const grouped = new Map();
  active.forEach((item) => {
    if (!grouped.has(item.key)) grouped.set(item.key, []);
    if (!grouped.get(item.key).includes(item.value)) grouped.get(item.key).push(item.value);
  });
  const summary = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .join("; ");
  const content = `Compressed user preference memory. ${summary}`;
  const rowForEmbedding = {
    type: "preference_summary",
    key: "profile",
    value: summary,
    label: "Compressed preference summary",
    content
  };
  const embedding = await memoryEmbeddingFieldsAsync(rowForEmbedding, now);
  db.prepare(`
    INSERT INTO memory_items (
      id, user_id, project_id, scope, type, key, value, label, content, embedding_json, embedding_model, embedding_updated_at, source, confidence, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      user_id = excluded.user_id,
      value = excluded.value,
      content = excluded.content,
      embedding_json = excluded.embedding_json,
      embedding_model = excluded.embedding_model,
      embedding_updated_at = excluded.embedding_updated_at,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    summaryId,
    userId,
    projectId,
    "user",
    "preference_summary",
    "profile",
    summary,
    "Compressed preference summary",
    content,
    embedding.embeddingJson,
    embedding.embeddingModel,
    embedding.embeddingUpdatedAt,
    "memory_compaction",
    "high",
    "active",
    now,
    now
  );
  syncMemoryFtsRow(db, summaryId);
  await upsertMemoryVectorIndex(db.prepare("SELECT * FROM memory_items WHERE id = ?").get(summaryId));
  return getLongTermMemoryById(summaryId);
}

async function markLongTermMemoryForgotten({ userId = DEFAULT_USER_ID, projectId = null, key = null, value = null, reason = "forgotten" }) {
  const db = getMemoryDatabase();
  const now = new Date().toISOString();
  let sql = "UPDATE memory_items SET status = ?, updated_at = ? WHERE status = 'active'";
  const params = [reason, now];
  sql += " AND user_id = ?";
  params.push(userId);
  if (projectId) {
    sql += " AND (project_id = ? OR project_id IS NULL)";
    params.push(projectId);
  }
  if (key) {
    sql += " AND key = ?";
    params.push(key);
  }
  if (value) {
    sql += " AND value = ?";
    params.push(String(value));
  }
  const result = db.prepare(sql).run(...params);
  await refreshLongTermMemorySummary({ userId, projectId });
  return result.changes || 0;
}

function getLongTermMemoryById(id) {
  const item = getMemoryDatabase().prepare("SELECT * FROM memory_items WHERE id = ?").get(id);
  return normalizeLongTermMemoryItem(item);
}

function tokenizeMemoryQuery(text) {
  return [...String(text || "").matchAll(/[\p{L}\p{N}_]+/gu)]
    .map((match) => match[0].toLowerCase())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function normalizeLongTermMemoryStatusFilter(status = "active") {
  const normalized = String(status || "active").toLowerCase();
  if (normalized === "all") return "all";
  if (normalized === "superseded") return "superseded";
  if (normalized === "forgotten") return "forgotten";
  return "active";
}

function parsePositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function buildLongTermMemoryFilters({ userId = DEFAULT_USER_ID, projectId = null, status = "active" } = {}) {
  const statusFilter = normalizeLongTermMemoryStatusFilter(status);
  const clauses = [];
  const params = [];
  clauses.push("m.user_id = ?");
  params.push(userId);
  if (statusFilter === "active") {
    clauses.push("m.status = ?");
    params.push("active");
  } else if (statusFilter === "superseded") {
    clauses.push("m.status = ?");
    params.push("superseded");
  } else if (statusFilter === "forgotten") {
    clauses.push("m.status = ?");
    params.push("forgotten");
  }
  if (projectId) {
    clauses.push("(m.project_id = ? OR m.project_id IS NULL)");
    params.push(projectId);
  }
  return {
    status: statusFilter,
    sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "",
    params
  };
}

async function rankLongTermMemoryByVector(rows, query, limit) {
  const queryEmbedding = await createMemoryQueryEmbedding(query);
  return rows
    .map((row) => ({
      ...row,
      vector_score: row.embedding_model === queryEmbedding.model
        ? cosineSimilarity(queryEmbedding.vector, parseMemoryEmbedding(row.embedding_json))
        : 0
    }))
    .filter((row) => row.vector_score > 0.05)
    .sort((left, right) => {
      if (right.vector_score !== left.vector_score) return right.vector_score - left.vector_score;
      return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
    })
    .slice(0, limit);
}

function mergeMemoryRows(primaryRows, vectorRows, limit) {
  const seen = new Set();
  return [...primaryRows, ...vectorRows]
    .filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    })
    .slice(0, limit);
}

async function searchLongTermMemory({ userId = DEFAULT_USER_ID, projectId = null, query = "", limit = 5, status = "active", recordUsage = true } = {}) {
  const db = getMemoryDatabase();
  const tokens = tokenizeMemoryQuery(query);
  const filters = buildLongTermMemoryFilters({ userId, projectId, status });
  let rows = [];
  if (tokens.length && memoryDbFtsEnabled) {
    const ftsQuery = tokens.map((token) => `${token.replaceAll('"', "")}*`).join(" OR ");
    rows = db.prepare(`
      SELECT m.* FROM memory_items_fts f
      JOIN memory_items m ON m.id = f.memory_id
      WHERE memory_items_fts MATCH ?
        ${filters.sql}
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, ...filters.params, limit);
  }
  if (!rows.length && tokens.length) {
    const like = `%${tokens[0]}%`;
    rows = db.prepare(`
      SELECT m.* FROM memory_items m
      WHERE 1 = 1
        ${filters.sql}
        AND (lower(m.content) LIKE ? OR lower(m.key) LIKE ? OR lower(m.value) LIKE ? OR lower(m.label) LIKE ?)
      ORDER BY m.updated_at DESC
      LIMIT ?
    `).all(...filters.params, like, like, like, like, limit);
  }
  if (tokens.length) {
    const remoteVector = await queryMemoryVectorIndex({ userId, projectId, query, status, limit });
    rows = mergeMemoryRows(rows, remoteVector.rows, limit);
    const vectorCandidates = db.prepare(`
      SELECT m.* FROM memory_items m
      WHERE 1 = 1
        ${filters.sql}
        AND m.embedding_json IS NOT NULL
      ORDER BY m.updated_at DESC
      LIMIT 50
    `).all(...filters.params);
    rows = mergeMemoryRows(rows, await rankLongTermMemoryByVector(vectorCandidates, query, limit), limit);
  }
  if (!rows.length) {
    rows = db.prepare(`
      SELECT m.* FROM memory_items m
      WHERE 1 = 1
        ${filters.sql}
      ORDER BY m.updated_at DESC
      LIMIT ?
    `).all(...filters.params, limit);
  }
  if (recordUsage && rows.length) {
    const now = new Date().toISOString();
    const touchLastUsed = getCachedStatement(db, "UPDATE memory_items SET last_used_at = ? WHERE id = ?");
    rows.forEach((row) => {
      touchLastUsed.run(now, row.id);
    });
  }
  return rows.map(normalizeLongTermMemoryItem).filter(Boolean);
}

function listLongTermMemories({ userId = DEFAULT_USER_ID, projectId = null, limit = 20, status = "active" } = {}) {
  const db = getMemoryDatabase();
  const filters = buildLongTermMemoryFilters({ userId, projectId, status });
  const rows = db.prepare(`
    SELECT * FROM memory_items m
    WHERE 1 = 1
      ${filters.sql}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...filters.params, limit);
  return rows.map(normalizeLongTermMemoryItem).filter(Boolean);
}

function summarizeLongTermMemories(items = []) {
  if (!items.length) return "none";
  return items.map((item) => `${item.type}:${item.key || "memory"}=${item.value || item.content}`).join("; ");
}


function normalizeMemorySuggestion(item) {
  if (!item || typeof item !== "object") return null;
  const allowedStatuses = new Set(["pending", "confirmed", "ignored"]);
  const status = allowedStatuses.has(item.status) ? item.status : "pending";
  return {
    ...item,
    id: item.id || crypto.randomUUID(),
    userId: typeof item.userId === "string" && item.userId ? item.userId : DEFAULT_USER_ID,
    key: typeof item.key === "string" ? item.key : "unknown",
    label: typeof item.label === "string" ? item.label : String(item.key || "Memory suggestion"),
    confidence: typeof item.confidence === "string" ? item.confidence : "medium",
    status,
    createdAt: item.createdAt || new Date().toISOString()
  };
}

function normalizeMemoryEvent(item) {
  if (!item || typeof item !== "object") return null;
  const action = typeof item.action === "string" ? item.action : "memory_event";
  return {
    id: item.id || crypto.randomUUID(),
    userId: typeof item.userId === "string" && item.userId ? item.userId : DEFAULT_USER_ID,
    projectId: typeof item.projectId === "string" ? item.projectId : null,
    suggestionId: typeof item.suggestionId === "string" ? item.suggestionId : null,
    action,
    key: typeof item.key === "string" ? item.key : null,
    value: typeof item.value === "string" ? item.value : null,
    label: typeof item.label === "string" ? item.label : action,
    status: typeof item.status === "string" ? item.status : action,
    createdAt: item.createdAt || new Date().toISOString()
  };
}

export {
  getCachedStatement,
  runInSqliteTransaction,
  listSchemaMigrations,
  getMemoryDatabase,
  closeMemoryDatabase,
  getMemoryDatabaseStatus,
  createMemoryDatabaseBackup,
  listMemoryDatabaseBackups,
  resolveMemoryBackupPath,
  createMemoryDatabaseRestorePlan,
  restoreMemoryDatabaseFromBackup,
  normalizeLongTermMemoryItem,
  createLocalMemoryEmbedding,
  parseMemoryEmbedding,
  resolveMemoryEmbeddingMode,
  resolveMemoryVectorIndexMode,
  createMemoryQueryEmbedding,
  requestMemoryVectorIndex,
  upsertMemoryVectorIndex,
  queryMemoryVectorIndex,
  cosineSimilarity,
  hydrateMissingMemoryEmbeddings,
  syncMemoryFtsRow,
  rebuildMemoryFtsIndex,
  upsertLongTermMemoryFromSuggestion,
  compactLongTermPreferenceMemories,
  refreshLongTermMemorySummary,
  markLongTermMemoryForgotten,
  getLongTermMemoryById,
  parsePositiveInteger,
  normalizeLongTermMemoryStatusFilter,
  buildLongTermMemoryFilters,
  searchLongTermMemory,
  listLongTermMemories,
  summarizeLongTermMemories,
  memoryEmbeddingFieldsAsync,
  normalizeMemorySuggestion,
  normalizeMemoryEvent
};
