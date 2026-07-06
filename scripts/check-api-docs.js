import { readFile } from "node:fs/promises";

const [serverSource, readme, userGuide] = await Promise.all([
  readFile("server.js", "utf8"),
  readFile("README.md", "utf8"),
  readFile("docs/USER_GUIDE.md", "utf8")
]);

const routePattern = /req\.method === "([^"]+)" && pathname === "(\/api\/[^"]+)"/g;
const documentedPattern = /\|\s*`?([A-Z]+)`?\s*\|\s*`(\/api\/[^`]+)`\s*\|/g;

function collectMatches(pattern, source) {
  return [...source.matchAll(pattern)]
    .map((match) => `${match[1]} ${match[2]}`)
    .sort();
}

const implemented = collectMatches(routePattern, serverSource);
const readmeDocumented = collectMatches(documentedPattern, readme);
const userGuideDocumented = collectMatches(documentedPattern, userGuide);

function diffDocumentedRoutes(documented) {
  return {
    missingFromDoc: implemented.filter((route) => !documented.includes(route)),
    missingFromServer: documented.filter((route) => !implemented.includes(route))
  };
}

const readmeDiff = diffDocumentedRoutes(readmeDocumented);
const userGuideDiff = diffDocumentedRoutes(userGuideDocumented);
const requiredErrorDocSnippets = [
  "Error responses keep a human-readable `error` string and add a machine-readable `code`",
  "Confirmed preferences are scoped by `userId`",
  "suggestions carry user and project ownership",
  "MEMORY_SUGGESTION_NOT_FOUND",
  "MEMORY_SUGGESTION_NOT_PENDING",
  "MEMORY_PROJECT_MISMATCH",
  "MEMORY_USER_MISMATCH",
  "UNKNOWN_MEMORY_PREFERENCE_KEY",
  "UNKNOWN_MEMORY_PREFERENCE_VALUE",
  "MEMORY_BACKUP_REQUIRED",
  "MEMORY_BACKUP_INVALID",
  "MEMORY_BACKUP_NOT_FOUND",
  "MEMORY_BACKUP_CHECKSUM_MISMATCH",
  "MEMORY_RESTORE_CONFIRMATION_REQUIRED",
  "MEMORY_RESTORE_CHECKSUM_REQUIRED",
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_USER_MISMATCH",
  "AUTH_SCOPE_FORBIDDEN",
  "PROJECT_REQUIRED",
  "PROJECT_NOT_FOUND",
  "INVALID_GITHUB_REPO",
  "GITHUB_IMPORT_FAILED",
  "GITHUB_IMPORT_TIMEOUT",
  "IMPORT_SOURCE_REQUIRED",
  "IMPORT_INVALID_ZIP",
  "IMPORT_TOO_LARGE",
  "NO_SUPPORTED_FILES",
  "REQUEST_BODY_TOO_LARGE",
  "QUESTION_REQUIRED",
  "ANSWER_NOT_FOUND",
  "RUN_ID_REQUIRED",
  "HARNESS_RUN_NOT_FOUND",
  "CHECKPOINT_ID_REQUIRED",
  "LANGGRAPH_CHECKPOINT_NOT_FOUND",
  "LANGGRAPH_RESUME_UNAVAILABLE",
  "LANGGRAPH_RESUME_USER_MISMATCH",
  "INVALID_FEEDBACK_TYPE",
  "ROUTE_NOT_FOUND",
  "Metrics ignore unknown feedback types",
  "average response time",
  "citation status distribution",
  "memory status distribution",
  "recent memory events",
  "safety risk and status distribution",
  "import safety risk/status",
  "recent safety events",
  "harness runtime, model mode, tool policy, budget status, schema status, LLM usage, and trace tool distribution",
  "fallback reason distribution",
  "recent harness runs",
  "recent schema migrations",
  "harness snapshot count",
  "persisted harness run audit",
  "risk_details",
  "output_redaction",
  "recent feedback run correlation",
  "git commit",
  "Node runtime",
  "uptime",
  "effective request timeout",
  "context token budget"
];
const missingReadmeErrorDocs = requiredErrorDocSnippets.filter((snippet) => !readme.includes(snippet));

const requiredEvaluationMetricSnippets = [
  "average_response_time_ms",
  "memory_status_counts",
  "memory_event_counts",
  "recent_memory_events",
  "safety_risk_counts",
  "safety_status_counts",
  "recent_safety_events",
  "output_redaction_runs",
  "output_redaction_matches",
  "recent_redaction_events",
  "harness_runtime_counts",
  "model_mode_counts",
  "tool_policy_counts",
  "recent_tool_policy_events",
  "budget_status_counts",
  "schema_status_counts",
  "llm_usage_counts",
  "trace_tool_counts",
  "citation_status_counts",
  "import_safety_status",
  "import_safety_risk_counts",
  "import_prompt_risk_file_count",
  "import_sensitive_file_count",
  "fallback_reasons",
  "recent_harness_runs",
  "harness_run_snapshots",
  "schema_migration_count",
  "recent_schema_migrations",
  "rankCounts(safetyRiskCounts)",
  "rankCounts(fallbackReasonCounts)"
];
const missingEvaluationMetricSnippets = requiredEvaluationMetricSnippets.filter((snippet) => !serverSource.includes(snippet));

if (
  readmeDiff.missingFromDoc.length
  || readmeDiff.missingFromServer.length
  || userGuideDiff.missingFromDoc.length
  || userGuideDiff.missingFromServer.length
  || missingReadmeErrorDocs.length
  || missingEvaluationMetricSnippets.length
) {
  console.error(JSON.stringify({
    implemented,
    readmeDocumented,
    userGuideDocumented,
    missingFromReadme: readmeDiff.missingFromDoc,
    readmeOnlyRoutes: readmeDiff.missingFromServer,
    missingFromUserGuide: userGuideDiff.missingFromDoc,
    userGuideOnlyRoutes: userGuideDiff.missingFromServer,
    missingReadmeErrorDocs,
    missingEvaluationMetricSnippets
  }, null, 2));
  throw new Error("API documentation is out of sync with server routes.");
}

console.log(JSON.stringify({
  ok: true,
  readmeRoutes: readmeDocumented.length,
  userGuideRoutes: userGuideDocumented.length,
  errorDocSnippets: requiredErrorDocSnippets.length,
  evaluationMetricSnippets: requiredEvaluationMetricSnippets.length
}, null, 2));
