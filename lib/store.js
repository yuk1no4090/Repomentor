import { promises as fs } from "node:fs";
import path from "node:path";
import {
  STORE_PATH,
  DEFAULT_USER_ID,
  normalizeUserId,
  STORE_MAX_QUESTIONS,
  STORE_MAX_ANSWERS,
  STORE_MAX_HARNESS_RUNS,
  STORE_MAX_MEMORY_EVENTS
} from "./config.js";

let writeQueue = Promise.resolve();

export async function withWriteLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

// ── Resident in-memory cache ──
// store.json can grow to tens of MB (it embeds each imported project's full
// source + retrieval chunks), so re-reading + JSON.parse()-ing + normalizeStore()-ing
// it on literally every API request (as ensureStore() used to do unconditionally)
// dominates request latency once a project of any size is loaded. Instead we keep
// the parsed, normalized store resident across requests and only pay the
// read+parse+normalize cost again when the on-disk file has actually changed
// since we last saw it (detected via a cheap fs.stat() mtime+size signature,
// rather than a full read). Our own writes (saveStore()) update the cached
// object + signature directly, so the common case — this process is the only
// writer — never re-reads what it just wrote.
//
// This intentionally stops short of literal time-debounced async writes: this
// codebase's smoke tests (scripts/smoke-test.js) spawn the server as a separate
// child process and then, mid-test, read and even directly overwrite store.json
// from the test process with no delay, expecting the very next request to
// observe that on-disk change (see e.g. the "dirty store" and "concurrent
// feedback" smoke scenarios). A writer-side delay decoupled from the
// request/response boundary would make store.json's on-disk content lag behind
// what a client was just told was persisted, breaking that cross-process
// contract. Since every mutating request already serializes on withWriteLock()
// (so there is no batching opportunity across concurrent mutations anyway), we
// keep saveStore() synchronous relative to its caller and get the actual
// performance win from skipping redundant reloads instead.
let cachedStore = null;
let cachedSignature = null;

async function statSignature(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function signaturesMatch(a, b) {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function updateCache(store, signature) {
  cachedStore = store;
  cachedSignature = signature;
  return store;
}

// Exposed for gracefulShutdown() / restore-style endpoints that replace
// store.json out from under this process: forces the next ensureStore() call
// to reload from disk instead of trusting the resident cache. (No such endpoint
// exists for STORE_PATH today — only the SQLite memory database has a
// restore-from-backup flow — but this stays available for anything that ever
// needs it, and keeps the invalidation path testable in isolation.)
export function invalidateStoreCache() {
  cachedStore = null;
  cachedSignature = null;
}

async function ensureStore() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const currentSignature = await statSignature(STORE_PATH);
  if (cachedStore && signaturesMatch(currentSignature, cachedSignature)) {
    return cachedStore;
  }
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const store = normalizeStore(JSON.parse(raw));
    return updateCache(store, currentSignature || await statSignature(STORE_PATH));
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
  // The file at STORE_PATH is gone (renamed to backupPath); nothing cached
  // against it is valid any more.
  invalidateStoreCache();
}

// Tracks the most recently started disk write so gracefulShutdown() can wait
// for it via flushStore() instead of racing process exit against an in-flight
// fs.writeFile()/fs.rename(). saveStore() itself already awaits the write
// before resolving/rejecting for its own caller; pendingSave exists purely so
// *other* code (the shutdown hook) can observe "is there a save in flight"
// without holding a reference to that specific call's promise.
let pendingSave = null;

async function saveStore(store) {
  const task = (async () => {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    const tempPath = path.join(
      path.dirname(STORE_PATH),
      `.${path.basename(STORE_PATH)}.${process.pid}.${Date.now()}.tmp`
    );
    const normalized = normalizeStore(store);
    try {
      await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2));
      await fs.rename(tempPath, STORE_PATH);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
    // The object we just wrote is now the authoritative in-memory copy too;
    // record the on-disk signature we produced so the next ensureStore() call
    // (from this request or any other) can skip re-reading what we just wrote.
    updateCache(normalized, await statSignature(STORE_PATH));
  })();
  pendingSave = task.catch(() => {});
  return task;
}

// Awaits the most recent in-flight saveStore() call, if any. Called from
// server.js's gracefulShutdown() so a SIGTERM/SIGINT during/just after a write
// can't exit the process before that write has actually landed on disk.
export async function flushStore() {
  if (pendingSave) await pendingSave;
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
  // questions/answers are always pushed in pairs (one of each per Q&A/onboarding/
  // agent-impact request — see server.js), so slicing both to the same window
  // keeps them index-aligned. feedback references answers by id (never questions),
  // so once answers are capped we also drop any feedback left pointing at an
  // answer that fell outside the retained window — otherwise those records would
  // become permanent orphans (harmless today thanks to optional chaining in
  // lib/metrics.js's recent_feedback, but pure accumulated cruft) instead of
  // being trimmed along with the answer they describe.
  normalized.questions = Array.isArray(normalized.questions)
    ? normalized.questions.slice(-STORE_MAX_QUESTIONS)
    : [];
  normalized.answers = Array.isArray(normalized.answers)
    ? normalized.answers.slice(-STORE_MAX_ANSWERS)
    : [];
  const retainedAnswerIds = new Set(normalized.answers.map((item) => item?.id));
  normalized.feedback = Array.isArray(normalized.feedback)
    ? normalized.feedback.filter((item) => retainedAnswerIds.has(item?.answerId))
    : [];
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
    ? normalized.harnessRuns.map(normalizeHarnessRun).filter(Boolean).slice(-STORE_MAX_HARNESS_RUNS)
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
    ? normalized.memoryEvents.map(normalizeMemoryEvent).filter(Boolean).slice(-STORE_MAX_MEMORY_EVENTS)
    : [];
  normalized.authUsers = mergeAuthUsersWithConfiguredTokens(normalized.authUsers);
  return normalized;
}

export { ensureStore, saveStore, backupCorruptStore, normalizeStore };
