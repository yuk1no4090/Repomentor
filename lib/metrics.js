import { listSchemaMigrations } from "./memory-db.js";
import { listLangGraphCheckpoints } from "./checkpoints.js";
import { SECRET_REDACTION, collectCitationFiles, validateAgentCitations } from "./safety.js";
import { createHarnessRunSnapshot } from "./agent-graph.js";

const FEEDBACK_TYPES = new Set(["helpful", "not_helpful", "inaccurate", "missing_citation", "too_generic"]);

function computeMetrics(store, projectId) {
  const project = store.projects.find((item) => item.id === projectId);
  const questions = store.questions.filter((item) => item.projectId === projectId);
  const answers = store.answers.filter((item) => item.projectId === projectId);
  const feedback = store.feedback.filter((item) => {
    return item.projectId === projectId && FEEDBACK_TYPES.has(item.type);
  });
  const suggestions = store.memorySuggestions.filter((item) => !projectId || item.projectId === projectId);
  const helpful = feedback.filter((item) => item.type === "helpful").length;
  const negativeTypes = new Set(["not_helpful", "inaccurate", "missing_citation", "too_generic"]);
  const negative = feedback.filter((item) => negativeTypes.has(item.type)).length;
  const cited = answers.filter((item) => {
    const refs = collectCitationFiles(item.payload || {});
    return refs.length > 0;
  }).length;
  const uncertain = answers.filter((item) => {
    const u = item.payload?.uncertainty;
    if (u === true || u === "true") return true;
    return /high|not sure|insufficient|uncertain|不确定/i.test(String(u || ""));
  }).length;
  const counts = feedback.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
  const responseTimes = answers
    .map((item) => Number(item.responseTimeMs || item.payload?.harness?.duration_ms || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const safetyRiskCounts = answers.reduce((acc, item) => {
    (item.payload?.safety?.risk_types || []).forEach((riskType) => {
      acc[riskType] = (acc[riskType] || 0) + 1;
    });
    return acc;
  }, {});
  const safetyStatusCounts = answers.reduce((acc, item) => {
    const status = item.payload?.safety?.status || "not_applicable";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const memoryStatusCounts = suggestions.reduce((acc, item) => {
    const status = item.status || "pending";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const harnessRuntimeCounts = answers.reduce((acc, item) => {
    const runtime = item.payload?.harness?.runtime;
    if (!runtime) return acc;
    acc[runtime] = (acc[runtime] || 0) + 1;
    return acc;
  }, {});
  const modelModeCounts = answers.reduce((acc, item) => {
    const mode = item.payload?.harness?.model_mode;
    if (!mode) return acc;
    acc[mode] = (acc[mode] || 0) + 1;
    return acc;
  }, {});
  const toolPolicyCounts = answers.reduce((acc, item) => {
    const policyMode = item.payload?.harness?.tool_registry?.policy?.mode;
    if (!policyMode) return acc;
    acc[policyMode] = (acc[policyMode] || 0) + 1;
    return acc;
  }, {});
  const budgetStatusCounts = answers.reduce((acc, item) => {
    const budget = item.payload?.harness?.budget_status;
    if (!budget) return acc;
    const status = budget.timeout_exceeded
      ? "timeout_exceeded"
      : budget.context_budget_exceeded
        ? "context_budget_exceeded"
      : budget.step_budget_exceeded
        ? "step_budget_exceeded"
        : "within_budget";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const schemaStatusCounts = answers.reduce((acc, item) => {
    const harness = item.payload?.harness;
    if (!harness) return acc;
    const status = harness.schema_valid === false ? "schema_invalid" : "schema_valid";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const llmUsageCounts = answers.reduce((acc, item) => {
    const adapter = item.payload?.harness?.model_adapter;
    if (!adapter) return acc;
    const status = adapter.llm_used
      ? "llm_used"
      : adapter.llm_attempted
        ? "llm_attempted_fallback"
        : "offline_retrieval";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const traceToolCounts = answers.reduce((acc, item) => {
    (item.payload?.trace || []).forEach((step) => {
      if (!step?.tool) return;
      acc[step.tool] = (acc[step.tool] || 0) + 1;
    });
    return acc;
  }, {});
  const citationStatusCounts = answers.reduce((acc, item) => {
    if (!project) return acc;
    const citation = validateAgentCitations(project, item.payload || {});
    const status = citation.passed
      ? "citation_valid"
      : citation.missing_files.length
        ? "missing_citation"
        : citation.uncited_impact_areas.length
          ? "uncited_impact_area"
          : "no_citation";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const fallbackReasonCounts = answers.reduce((acc, item) => {
    if (!item.payload?.harness?.fallback_used) return acc;
    const reason = item.payload.harness.model_adapter?.error_code
      || item.payload.harness.fallback_reason
      || "fallback";
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});
  const outputRedactionEvents = answers
    .filter((item) => item.payload?.safety?.output_redaction?.applied)
    .map((item) => ({
      answer_id: item.id,
      run_id: item.payload?.harness?.run_id || null,
      kind: item.kind,
      match_count: Number(item.payload.safety.output_redaction.match_count || 0),
      marker: item.payload.safety.output_redaction.marker || SECRET_REDACTION,
      createdAt: item.createdAt
    }));
  const outputRedactionMatches = outputRedactionEvents.reduce((sum, item) => sum + item.match_count, 0);
  const importSafety = project?.summary?.safetyReview || {
    status: "not_applicable",
    risk_types: [],
    prompt_injection_file_count: 0,
    sensitive_file_count: 0,
    prompt_injection_files: [],
    sensitive_files: []
  };
  const importSafetyRiskCounts = (importSafety.risk_types || []).reduce((acc, riskType) => {
    acc[riskType] = (acc[riskType] || 0) + 1;
    return acc;
  }, {});
  const rankCounts = (items) => Object.entries(items)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));
  const answersById = new Map(answers.map((item) => [item.id, item]));
  const projectHarnessRuns = (store.harnessRuns || []).filter((item) => item.projectId === projectId);
  const modelAgentCalls = answers.flatMap((item) => item.payload?.harness?.model_calls || []);
  const completeMultiAgentRuns = answers.filter((item) => {
    if (item.kind !== "agent_impact") return false;
    const roles = new Set((item.payload?.harness?.model_calls || []).map((call) => call.agent_role));
    return ["Supervisor", "ImpactAnalyst", "QACritic"].every((role) => roles.has(role));
  }).length;
  const modelAgentRoleCounts = modelAgentCalls.reduce((acc, call) => {
    const role = call.agent_role || "unknown";
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  const projectMemoryEvents = (store.memoryEvents || []).filter((item) => {
    return !projectId || item.projectId === projectId || item.projectId == null;
  });
  const memoryEventCounts = (projectMemoryEvents.length ? projectMemoryEvents : suggestions).reduce((acc, item) => {
    const type = item.action || item.status || "memory_event";
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const recentHarnessRuns = (projectHarnessRuns.length
    ? projectHarnessRuns
    : answers
      .filter((item) => item.payload?.harness?.run_id)
      .map((item) => createHarnessRunSnapshot(item))
      .filter(Boolean))
    .slice(-8)
    .reverse();
  const recentLangGraphCheckpoints = listLangGraphCheckpoints({ projectId, limit: 20 });
  const recentSchemaMigrations = listSchemaMigrations(20);
  const recentSafetyEvents = answers
    .filter((item) => item.payload?.safety?.status === "needs_review" || item.payload?.safety?.risk_types?.length)
    .slice(-8)
    .reverse()
    .map((item) => ({
      answer_id: item.id,
      run_id: item.payload?.harness?.run_id || null,
      kind: item.kind,
      safety_status: item.payload?.safety?.status || "unknown",
      risk_types: item.payload?.safety?.risk_types || [],
      guardrails: (item.payload?.guardrails || [])
        .filter((guardrail) => guardrail.status === "needs_review")
        .map((guardrail) => guardrail.name),
      createdAt: item.createdAt
    }));
  const recentToolPolicyEvents = answers
    .filter((item) => item.payload?.harness?.tool_registry)
    .slice(-8)
    .reverse()
    .map((item) => {
      const toolGuardrail = (item.payload?.guardrails || []).find((guardrail) => guardrail.name === "Agent tool policy");
      const toolRiskTypes = (item.payload?.safety?.risk_types || []).filter((riskType) => {
        return riskType === "unknown_agent_tool" || riskType === "tool_policy_violation";
      });
      return {
        answer_id: item.id,
        run_id: item.payload?.harness?.run_id || null,
        kind: item.kind,
        policy_mode: item.payload?.harness?.tool_registry?.policy?.mode || "unknown",
        status: toolGuardrail?.status || (toolRiskTypes.length ? "needs_review" : "passed"),
        risk_types: toolRiskTypes,
        trace_tools: (item.payload?.trace || []).map((step) => step.tool).filter(Boolean),
        detail: toolGuardrail?.detail || "",
        createdAt: item.createdAt
      };
    });
  const recentMemoryEvents = (projectMemoryEvents.length
    ? projectMemoryEvents
    : suggestions)
    .slice(-8)
    .reverse()
    .map((item) => ({
      id: item.id,
      suggestionId: item.suggestionId || null,
      action: item.action || item.status,
      key: item.key,
      value: item.value,
      label: item.label,
      status: item.status,
      confidence: item.confidence || null,
      createdAt: item.createdAt
    }));
  return {
    total_questions: questions.length,
    helpful_rate: feedback.length ? Math.round((helpful / feedback.length) * 100) : 0,
    citation_coverage: answers.length ? Math.round((cited / answers.length) * 100) : 0,
    uncertain_answer_rate: answers.length ? Math.round((uncertain / answers.length) * 100) : 0,
    negative_feedback_rate: feedback.length ? Math.round((negative / feedback.length) * 100) : 0,
    agent_runs: answers.filter((item) => item.kind === "agent_impact").length,
    complete_multi_agent_runs: completeMultiAgentRuns,
    model_agent_calls: modelAgentCalls.length,
    successful_model_agent_calls: modelAgentCalls.filter((call) => call.llm_used).length,
    model_agent_fallback_calls: modelAgentCalls.filter((call) => call.fallback_used).length,
    high_risk_questions: answers.filter((item) => JSON.stringify(item.payload).includes("high")).length,
    guardrail_hits: answers.filter((item) => item.payload?.safety?.status === "needs_review").length,
    output_redaction_runs: outputRedactionEvents.length,
    output_redaction_matches: outputRedactionMatches,
    memory_confirmations: suggestions.filter((item) => item.status === "confirmed").length,
    fallback_runs: answers.filter((item) => item.payload?.harness?.fallback_used).length,
    harness_run_snapshots: projectHarnessRuns.length,
    langgraph_checkpoint_count: recentLangGraphCheckpoints.length,
    schema_migration_count: recentSchemaMigrations.length,
    average_response_time_ms: responseTimes.length
      ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
      : 0,
    safety_risk_counts: rankCounts(safetyRiskCounts),
    safety_status_counts: rankCounts(safetyStatusCounts),
    memory_status_counts: rankCounts(memoryStatusCounts),
    memory_event_counts: rankCounts(memoryEventCounts),
    harness_runtime_counts: rankCounts(harnessRuntimeCounts),
    model_mode_counts: rankCounts(modelModeCounts),
    tool_policy_counts: rankCounts(toolPolicyCounts),
    budget_status_counts: rankCounts(budgetStatusCounts),
    schema_status_counts: rankCounts(schemaStatusCounts),
    llm_usage_counts: rankCounts(llmUsageCounts),
    model_agent_role_counts: rankCounts(modelAgentRoleCounts),
    trace_tool_counts: rankCounts(traceToolCounts),
    citation_status_counts: rankCounts(citationStatusCounts),
    fallback_reasons: rankCounts(fallbackReasonCounts),
    import_safety_status: importSafety.status || "not_applicable",
    import_safety_risk_counts: rankCounts(importSafetyRiskCounts),
    import_prompt_risk_file_count: importSafety.prompt_injection_file_count || 0,
    import_sensitive_file_count: importSafety.sensitive_file_count || 0,
    import_prompt_risk_files: importSafety.prompt_injection_files || [],
    import_sensitive_files: importSafety.sensitive_files || [],
    recent_harness_runs: recentHarnessRuns,
    recent_langgraph_checkpoints: recentLangGraphCheckpoints.slice(0, 8),
    recent_schema_migrations: recentSchemaMigrations.slice(0, 8),
    recent_safety_events: recentSafetyEvents,
    recent_tool_policy_events: recentToolPolicyEvents,
    recent_redaction_events: outputRedactionEvents.slice(-8).reverse(),
    recent_memory_events: recentMemoryEvents,
    top_failure_reasons: Object.entries(counts)
      .filter(([type]) => type !== "helpful")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([type, count]) => ({ type, count })),
    recent_feedback: feedback.slice(-8).reverse().map((item) => {
      const answer = answersById.get(item.answerId);
      return {
        ...item,
        answer_kind: answer?.kind || null,
        harness_run_id: item.harness_run_id || answer?.payload?.harness?.run_id || null,
        safety_status: answer?.payload?.safety?.status || "not_applicable"
      };
    })
  };
}

export { FEEDBACK_TYPES, computeMetrics };
