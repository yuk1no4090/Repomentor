import { readFile } from "node:fs/promises";
import { readFrontendSource } from "./shared/source-reader.js";

const appSource = await readFrontendSource();
const stylesSource = await readFile("public/styles.css", "utf8");

const renderRuntimeMatch = appSource.match(/function renderRuntimeStatus\(payload\) \{([\s\S]*?)\n\}/);
if (!renderRuntimeMatch) {
  throw new Error("Could not locate renderRuntimeStatus(payload).");
}

const runtimeBody = renderRuntimeMatch[1];

const requiredRuntimeSnippets = [
  "payload.memory_suggestions",
  "pendingMemory",
  "harness.duration_ms",
  "harness.run_id",
  "harness.fallback_used",
  "harness.fallback_reason",
  "modelAdapter.error_code",
  "modelAdapter.http_status",
  "harness.budget_status",
  "budget.step_budget_exceeded",
  "budget.timeout_exceeded",
  "budget.context_budget_exceeded",
  "c.chat.fallbackUsed",
  "c.chat.noFallback",
  "c.chat.budgetExceeded",
  "c.chat.budgetOk",
  "safety.risk_types",
  "safety.output_redaction",
  "redacted",
  "runtime-status"
];

const missingRuntimeSnippets = requiredRuntimeSnippets.filter((snippet) => {
  return !runtimeBody.includes(snippet);
});

const requiredChatRuntimeSnippets = [
  "function renderOptionalRuntimeStatus",
  "renderOptionalRuntimeStatus(payload)",
  "function renderOnboardingMessage",
  "renderMemorySuggestions(payload.memory_suggestions)",
  "summary.safetyReview",
  "prompt_injection_file_count",
  "sensitive_file_count",
  "state.llmStatus?.llm?.request_timeout_ms",
  "timeoutTitle"
];

const missingChatRuntimeSnippets = requiredChatRuntimeSnippets.filter((snippet) => {
  return !appSource.includes(snippet);
});

const requiredMemoryActionSnippets = [
  'data-memory-action="confirm"',
  'data-memory-action="ignore"',
  'data-memory-forget-key',
  'data-memory-forget-all',
  "/api/memory/confirm",
  "/api/memory/forget",
  "/api/memory?projectId=",
  "state.memory?.events",
  "state.memory?.long_term_memories",
  "payload.events || state.memory?.events || []",
  "payload.long_term_memories || state.memory?.long_term_memories || []",
  "Memory audit",
  "Long-term memory",
  "memory-events",
  "function refreshMemory",
  "function renderMemoryManager",
  "function forgetMemoryPreference",
  "const visible = suggestions.slice(0, 3)",
  "item.status === \"pending\"",
  "memory-state",
  "error.code = payload.code || \"REQUEST_FAILED\"",
  "error.status = response.status",
  "error.payload = payload",
  "function showError",
  "showError(error)"
];

const missingMemoryActionSnippets = requiredMemoryActionSnippets.filter((snippet) => {
  return !appSource.includes(snippet);
});

const requiredDashboardSnippets = [
  "recent_memory_events",
  "recentMemoryEvents(metrics.recent_memory_events)",
  "c.dashboard.recentMemory",
  "memory_status_counts",
  "memory_event_counts",
  "Memory Events",
  "safety_status_counts",
  "import_safety_status",
  "import_safety_risk_counts",
  "import_prompt_risk_file_count",
  "import_sensitive_file_count",
  "citation_status_counts",
  "harness_runtime_counts",
  "model_mode_counts",
  "tool_policy_counts",
  "recent_tool_policy_events",
  "recentToolPolicyEvents(metrics.recent_tool_policy_events)",
  "Recent Tool Policy",
  "budget_status_counts",
  "schema_status_counts",
  "llm_usage_counts",
  "trace_tool_counts",
  "c.dashboard.memoryStatus",
  "c.dashboard.safetyStatus",
  "c.dashboard.citationStatus",
  "c.dashboard.harnessRuntime",
  "c.dashboard.modelMode",
  "c.dashboard.toolPolicy",
  "c.dashboard.budgetStatus",
  "c.dashboard.schemaStatus",
  "c.dashboard.llmUsage",
  "c.dashboard.traceTools",
  "recent_harness_runs",
  "recentHarnessRuns(metrics.recent_harness_runs)",
  "harness_run_snapshots",
  "item.schema_valid === false",
  "item.budget_status?.context_budget_exceeded",
  "audit.run?.model_adapter",
  "audit.run?.budget_status",
  "Harness Snapshots",
  "data-harness-run",
  "function loadHarnessAudit",
  "/api/harness-run?projectId=",
  "function harnessAuditPanel",
  "state.harnessAudit",
  "risk_details",
  "Risk Details",
  "recent_safety_events",
  "recentSafetyEvents(metrics.recent_safety_events)",
  "c.dashboard.recentSafety",
  "output_redaction_runs",
  "output_redaction_matches",
  "recent_redaction_events",
  "recentRedactionEvents(metrics.recent_redaction_events)",
  "Recent Redactions",
  "item.guardrails",
  "c.dashboard.recentRuns",
  "item.fallback_used",
  "item.safety_status",
  "item.harness_run_id",
  "item.answer_kind"
];

const missingDashboardSnippets = requiredDashboardSnippets.filter((snippet) => {
  return !appSource.includes(snippet);
});

const requiredAuthUiSnippets = [
  "state.authToken",
  "localStorage.getItem(\"aido-api-token\")",
  "Authorization = `Bearer ${state.authToken}`",
  "topbar-auth",
  "data-auth-token-input",
  "function renderAuthOperationsPanel",
  "Auth Operations",
  "/api/auth/users",
  "/api/auth/events?limit=20",
  "function refreshAuthAdmin",
  "function saveBrowserAuthToken",
  "function createAuthUserFromForm",
  "function disableAuthUser",
  "data-auth-action=\"create-user\"",
  "data-auth-disable-user",
  "confirm(`Disable local auth user",
  "createdToken"
];

const missingAuthUiSnippets = requiredAuthUiSnippets.filter((snippet) => {
  return !appSource.includes(snippet);
});

const requiredStyleSnippets = [
  ".runtime-status",
  ".memory-suggestions",
  ".memory-actions",
  ".memory-state",
  ".memory-manager",
  ".memory-preferences",
  ".memory-events",
  ".memory-clear",
  ".text-button",
  ".compact-trace",
  ".topbar-auth",
  ".auth-ops",
  ".auth-grid",
  ".auth-created-token"
];

const staleFrontendTerms = [
  "single-agent tool workflow",
  "alert(error.message)",
  "Updated preference memory. Run the agent again to apply it.",
  "memory_used: action === \"confirm\""
].filter((term) => appSource.includes(term));

const missingStyleSnippets = requiredStyleSnippets.filter((snippet) => {
  return !stylesSource.includes(snippet);
});

// Whitespace-tolerant: asserts forgetMemoryPreference posts { suggestionId, projectId }
// without pinning exact spacing/formatting of the JSON.stringify(...) call.
const forgetsMemoryPreferenceWithSuggestionAndProject = /JSON\.stringify\(\{\s*suggestionId,\s*projectId:\s*state\.project\?\.id\s*\}\)/.test(appSource);

if (
  missingRuntimeSnippets.length
  || missingChatRuntimeSnippets.length
  || missingMemoryActionSnippets.length
  || missingDashboardSnippets.length
  || missingAuthUiSnippets.length
  || missingStyleSnippets.length
  || staleFrontendTerms.length
  || !forgetsMemoryPreferenceWithSuggestionAndProject
) {
  console.error(JSON.stringify({
    missingRuntimeSnippets,
    missingChatRuntimeSnippets,
    missingMemoryActionSnippets,
    missingDashboardSnippets,
    missingAuthUiSnippets,
    missingStyleSnippets,
    staleFrontendTerms,
    forgetsMemoryPreferenceWithSuggestionAndProject
  }, null, 2));
  throw new Error("Frontend agent UI contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  runtimeSnippets: requiredRuntimeSnippets.length,
  chatRuntimeSnippets: requiredChatRuntimeSnippets.length,
  memoryActionSnippets: requiredMemoryActionSnippets.length,
  dashboardSnippets: requiredDashboardSnippets.length,
  authUiSnippets: requiredAuthUiSnippets.length,
  styleSnippets: requiredStyleSnippets.length
}, null, 2));
