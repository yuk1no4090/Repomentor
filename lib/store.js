import { promises as fs } from "node:fs";
import path from "node:path";
import { STORE_PATH, DEFAULT_USER_ID, normalizeUserId } from "./config.js";

let writeQueue = Promise.resolve();

export async function withWriteLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

async function ensureStore() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const seed = normalizeStore({});
      await saveStore(seed);
      return seed;
    }
    if (error instanceof SyntaxError) {
      await backupCorruptStore(error);
      const seed = normalizeStore({});
      await saveStore(seed);
      return seed;
    }
    // Unexpected error (e.g. transient EBUSY/EPERM on Windows) — fail the
    // request instead of silently wiping the on-disk store with an empty seed.
    throw error;
  }
}

async function backupCorruptStore(error) {
  if (!(error instanceof SyntaxError)) return;
  const backupPath = path.join(
    path.dirname(STORE_PATH),
    `${path.basename(STORE_PATH)}.corrupt-${Date.now()}`
  );
  await fs.rename(STORE_PATH, backupPath).catch(() => {});
  console.error(`[store] Invalid JSON in ${STORE_PATH}; moved corrupt store to ${backupPath}`);
}

async function saveStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = path.join(
    path.dirname(STORE_PATH),
    `.${path.basename(STORE_PATH)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await fs.writeFile(tempPath, JSON.stringify(normalizeStore(store), null, 2));
    await fs.rename(tempPath, STORE_PATH);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

// ── Record normalizers injected by server.js ──
// normalizeStore() delegates normalization of the store's authUsers/authTokens/
// authEvents/harnessRuns/userPreferences*/memorySuggestions/memoryEvents
// sub-collections to helper functions that now live in lib/auth.js
// (normalizeAuthUserRecord/normalizeAuthTokenRecord/normalizeAuthEvent/
// mergeAuthUsersWithConfiguredTokens), lib/answers.js (createEmptyPreferences/
// normalizePreferences), lib/agent-graph.js (normalizeHarnessRun) and
// lib/memory-db.js (normalizeMemorySuggestion/normalizeMemoryEvent). Since
// lib/store.js must not import from those sibling lib modules (normalizeStore()
// runs before any domain module has necessarily finished its own setup, and a
// static import here would also make the module graph harder to reason about
// than a single injection point), server.js imports each normalizer from its
// owning module and injects the full set once at startup via
// setStoreRecordNormalizers(), before the store is ever read or written.
let storeRecordNormalizers = null;

export function setStoreRecordNormalizers(normalizers) {
  storeRecordNormalizers = normalizers;
}

function getStoreRecordNormalizers() {
  if (!storeRecordNormalizers) {
    throw new Error("[store] setStoreRecordNormalizers() must be called before the store is used.");
  }
  return storeRecordNormalizers;
}

function normalizeStore(store) {
  const {
    normalizeAuthUserRecord,
    normalizeAuthTokenRecord,
    normalizeAuthEvent,
    normalizeHarnessRun,
    createEmptyPreferences,
    normalizePreferences,
    normalizeMemorySuggestion,
    normalizeMemoryEvent,
    mergeAuthUsersWithConfiguredTokens
  } = getStoreRecordNormalizers();
  const normalized = store && typeof store === "object" ? store : {};
  normalized.projects ||= [];
  normalized.questions ||= [];
  normalized.answers ||= [];
  normalized.feedback ||= [];
  normalized.authUsers = Array.isArray(normalized.authUsers)
    ? normalized.authUsers.map(normalizeAuthUserRecord).filter(Boolean)
    : [];
  normalized.authTokens = Array.isArray(normalized.authTokens)
    ? normalized.authTokens.map(normalizeAuthTokenRecord).filter(Boolean)
    : [];
  normalized.authEvents = Array.isArray(normalized.authEvents)
    ? normalized.authEvents.map(normalizeAuthEvent).filter(Boolean).slice(-200)
    : [];
  normalized.harnessRuns = Array.isArray(normalized.harnessRuns)
    ? normalized.harnessRuns.map(normalizeHarnessRun).filter(Boolean)
    : [];
  normalized.userPreferences = {
    ...createEmptyPreferences(),
    ...(normalized.userPreferences || {})
  };
  normalized.userPreferencesByUser = normalized.userPreferencesByUser && typeof normalized.userPreferencesByUser === "object"
    ? normalized.userPreferencesByUser
    : {};
  if (!normalized.userPreferencesByUser[DEFAULT_USER_ID]) {
    normalized.userPreferencesByUser[DEFAULT_USER_ID] = normalized.userPreferences;
  }
  Object.keys(normalized.userPreferencesByUser).forEach((userId) => {
    const normalizedUserId = normalizeUserId(userId);
    normalized.userPreferencesByUser[normalizedUserId] = normalizePreferences(normalized.userPreferencesByUser[userId]);
    if (normalizedUserId !== userId) delete normalized.userPreferencesByUser[userId];
  });
  normalized.userPreferences = normalized.userPreferencesByUser[DEFAULT_USER_ID] || createEmptyPreferences();
  normalized.memorySuggestions = Array.isArray(normalized.memorySuggestions)
    ? normalized.memorySuggestions.map(normalizeMemorySuggestion).filter(Boolean)
    : [];
  normalized.memoryEvents = Array.isArray(normalized.memoryEvents)
    ? normalized.memoryEvents.map(normalizeMemoryEvent).filter(Boolean)
    : [];
  normalized.authUsers = mergeAuthUsersWithConfiguredTokens(normalized.authUsers);
  return normalized;
}

export { ensureStore, saveStore, backupCorruptStore, normalizeStore };
