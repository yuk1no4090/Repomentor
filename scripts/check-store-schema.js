import { readServerSource } from "./shared/source-reader.js";

const serverSource = await readServerSource();

const requiredTopLevelFields = [
  "projects",
  "questions",
  "answers",
  "feedback",
  "authUsers",
  "authTokens",
  "authEvents",
  "harnessRuns",
  "userPreferences",
  "userPreferencesByUser",
  "memorySuggestions",
  "memoryEvents"
];

const requiredPreferenceFields = [
  "role",
  "language",
  "detailLevel",
  "focusAreas",
  "taskTypes",
  "updatedAt"
];

const missingTopLevelFields = requiredTopLevelFields.filter((field) => {
  return !serverSource.includes(`normalized.${field}`);
});

const createPrefsMatch = serverSource.match(/function createEmptyPreferences\(\) \{[\s\S]*?return \{([\s\S]*?)\n  \};\n\}/);
if (!createPrefsMatch) {
  throw new Error("Could not locate createEmptyPreferences().");
}

const preferencesBody = createPrefsMatch[1];
const missingPreferenceFields = requiredPreferenceFields.filter((field) => {
  return !new RegExp(`\\b${field}\\s*:`).test(preferencesBody);
});

const arrayNormalizationChecks = [
  "function normalizePreferences",
  "normalized.focusAreas = Array.isArray(normalized.focusAreas)",
  "normalized.taskTypes = Array.isArray(normalized.taskTypes)",
  "normalized.userPreferencesByUser[normalizedUserId] = normalizePreferences",
  "normalized.memorySuggestions = Array.isArray(normalized.memorySuggestions)",
  "normalized.memorySuggestions.map(normalizeMemorySuggestion).filter(Boolean)",
  "normalized.memoryEvents = Array.isArray(normalized.memoryEvents)",
  "normalized.memoryEvents.map(normalizeMemoryEvent).filter(Boolean)",
  "normalized.harnessRuns = Array.isArray(normalized.harnessRuns)",
  "normalized.harnessRuns.map(normalizeHarnessRun).filter(Boolean)",
  "normalized.authUsers = Array.isArray(normalized.authUsers)",
  "normalized.authUsers.map(normalizeAuthUserRecord).filter(Boolean)",
  "normalized.authUsers = mergeAuthUsersWithConfiguredTokens(normalized.authUsers)",
  "normalized.authTokens = Array.isArray(normalized.authTokens)",
  "normalized.authTokens.map(normalizeAuthTokenRecord).filter(Boolean)",
  "normalized.authEvents = Array.isArray(normalized.authEvents)",
  "normalized.authEvents.map(normalizeAuthEvent).filter(Boolean).slice(-200)"
];

const missingArrayNormalization = arrayNormalizationChecks.filter((snippet) => {
  return !serverSource.includes(snippet);
});

const requiredSuggestionNormalizationSnippets = [
  "function normalizeMemorySuggestion",
  "allowedStatuses",
  "\"pending\", \"confirmed\", \"ignored\"",
  "crypto.randomUUID()",
  "createdAt: item.createdAt || new Date().toISOString()"
];

const requiredHarnessRunNormalizationSnippets = [
  "function normalizeHarnessRun",
  "run_id: runId",
  "model_provider",
  "schema_valid",
  "budget_status",
  "model_adapter",
  "risk_details",
  "trace_tools",
  "function recordHarnessRun",
  "function createHarnessRunSnapshot"
];

const requiredMemoryEventNormalizationSnippets = [
  "function normalizeMemoryEvent",
  "function createMemoryEvent",
  "suggestionId",
  "action",
  "store.memoryEvents.push(createMemoryEvent"
];

const missingSuggestionNormalization = requiredSuggestionNormalizationSnippets.filter((snippet) => {
  return !serverSource.includes(snippet);
});
const missingHarnessRunNormalization = requiredHarnessRunNormalizationSnippets.filter((snippet) => {
  return !serverSource.includes(snippet);
});
const missingMemoryEventNormalization = requiredMemoryEventNormalizationSnippets.filter((snippet) => {
  return !serverSource.includes(snippet);
});

const requiredMemoryEndpointSnippets = [
  "function apiError",
  "code: error.code || \"BAD_REQUEST\"",
  "let writeQueue = Promise.resolve()",
  "function withWriteLock",
  "return withWriteLock(() => handleApiUnlocked(req, res, pathname))",
  // Fine-grained locking for the 30s-class LLM/LangGraph routes: a request-wide
  // withWriteLock() around handleApiUnlocked() (asserted just above) is still
  // how every *lightweight* route is locked, but /api/chat, /api/agent-impact,
  // /api/onboarding and /api/langgraph-resume opt out of that single lock and
  // instead take two short locks of their own (a "gate" around store setup +
  // auth bookkeeping, and a "commit" around the final store mutation + save),
  // with the actual retrieval/LLM/graph work running unlocked in between. If
  // this gets refactored away again (e.g. those routes going back to a single
  // request-wide lock, or a rename of the helpers below), update these
  // snippets to match rather than deleting them outright.
  "function isHeavyMutationRoute",
  "const HEAVY_MUTATION_PATHS = new Set(",
  "function loadStoreWithAuthGate",
  "await withWriteLock(() => loadStoreWithAuthGate(req, pathname))",
  "const commitStore = await ensureStore()",
  "function backupCorruptStore",
  "error instanceof SyntaxError",
  ".corrupt-",
  "path.dirname(STORE_PATH)",
  "const tempPath = path.join(",
  "fs.rename(tempPath, STORE_PATH)",
  "fs.unlink(tempPath).catch(() => {})",
  "const FEEDBACK_TYPES = new Set",
  "FEEDBACK_TYPES.has(item.type)",
  "if (projectId) findProject(store, projectId, userId)",
  "suggestion.projectId !== body.projectId",
  "const MEMORY_PREFERENCE_KEYS = new Set",
  "const MEMORY_VALUE_OPTIONS = {",
  "function validateMemorySuggestionValue",
  "产品|需求",
  "简洁|简短",
  "风险|影响",
  "security|prompt injection|guardrail|安全|护栏",
  "MEMORY_PREFERENCE_KEYS.has(suggestion.key)",
  "MEMORY_PREFERENCE_KEYS.has(body.key)",
  "Memory suggestion is not pending.",
  "Unknown memory preference key.",
  "MEMORY_SUGGESTION_NOT_PENDING",
  "MEMORY_PROJECT_MISMATCH",
  "UNKNOWN_MEMORY_PREFERENCE_KEY",
  "UNKNOWN_MEMORY_PREFERENCE_VALUE",
  "PROJECT_REQUIRED",
  "PROJECT_NOT_FOUND",
  "IMPORT_SOURCE_REQUIRED",
  "QUESTION_REQUIRED",
  "ANSWER_NOT_FOUND",
  "INVALID_FEEDBACK_TYPE",
  "ROUTE_NOT_FOUND"
];

const missingMemoryEndpointSnippets = requiredMemoryEndpointSnippets.filter((snippet) => {
  return !serverSource.includes(snippet);
});

if (
  missingTopLevelFields.length
  || missingPreferenceFields.length
  || missingArrayNormalization.length
  || missingSuggestionNormalization.length
  || missingMemoryEventNormalization.length
  || missingHarnessRunNormalization.length
  || missingMemoryEndpointSnippets.length
) {
  console.error(JSON.stringify({
    missingTopLevelFields,
    missingPreferenceFields,
    missingArrayNormalization,
    missingSuggestionNormalization,
    missingMemoryEventNormalization,
    missingHarnessRunNormalization,
    missingMemoryEndpointSnippets
  }, null, 2));
  throw new Error("Store schema normalization is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  topLevelFields: requiredTopLevelFields.length,
  preferenceFields: requiredPreferenceFields.length,
  arrayNormalizationChecks: arrayNormalizationChecks.length,
  suggestionNormalizationChecks: requiredSuggestionNormalizationSnippets.length,
  memoryEventNormalizationChecks: requiredMemoryEventNormalizationSnippets.length,
  harnessRunNormalizationChecks: requiredHarnessRunNormalizationSnippets.length,
  memoryEndpointChecks: requiredMemoryEndpointSnippets.length
}, null, 2));
