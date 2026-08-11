import { SAFETY_POLICY } from "./config.js";

const SENSITIVE_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|BEGIN PRIVATE KEY|(?:api[_-]?key|apikey|token|password|credential|secret)["']?\s*[:=]\s*(?:"[^"]{8,}"|'[^']{8,}'|[A-Za-z0-9_./+-]*\d[A-Za-z0-9_./+-]{7,}))/i;
const SECRET_REDACTION = "[REDACTED_SECRET]";

const SAFETY_RISK_EXPLANATIONS = {
  prompt_injection: "The user request appears to override system or developer instructions.",
  secret_request: "The request asks for credentials, keys, tokens, or hidden configuration.",
  tool_permission: "The request asks the agent to write, execute, commit, push, or otherwise exceed read-only tool permissions.",
  unknown_agent_tool: "The trace contains a tool that is not registered in the read-only tool registry.",
  tool_policy_violation: "The trace contains a tool or policy state that violates the read-only, no-network, no-shell boundary.",
  retrieved_prompt_injection: "Retrieved repository content contains instruction-like text and must be treated only as untrusted evidence.",
  retrieved_sensitive_content: "Retrieved repository content contains credential-like values that must not be echoed.",
  missing_citation: "The output cites nonexistent files or omits required repository citations.",
  sensitive_output: "The output contains a value that looks like a credential or secret.",
  overconfidence: "The output lacks citations or uncertainty markers for claims that need evidence.",
  workflow_error: "The LangGraph workflow failed and deterministic fallback was used.",
  import_prompt_injection: "Imported repository files contain instruction-like prompt injection text.",
  import_sensitive_content: "Imported repository files contain sensitive-looking values."
};

function describeSafetyRisks(riskTypes = []) {
  return [...new Set(riskTypes)]
    .filter(Boolean)
    .map((type) => ({
      type,
      description: SAFETY_RISK_EXPLANATIONS[type] || "Safety review required."
    }));
}

function redactSensitiveText(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, SECRET_REDACTION)
    .replace(/AKIA[0-9A-Z]{16}/g, SECRET_REDACTION)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET_REDACTION)
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|apikey|token|password|credential|secret)[A-Za-z0-9_]*)\b\s*[:=]\s*["'][^"']+["']/gi, "$1 = \"[REDACTED_SECRET]\"")
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|apikey|token|password|credential|secret)[A-Za-z0-9_]*)\b\s*[:=]\s*([A-Za-z0-9_./+-]*\d[A-Za-z0-9_./+-]{7,})/gi, "$1 = [REDACTED_SECRET]");
}

function redactSensitivePayload(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitivePayload(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactSensitivePayload(item)])
  );
}

function countSensitivePayloadMatches(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value || "");
  const pattern = new RegExp(SENSITIVE_VALUE_PATTERN.source, "gi");
  return (serialized.match(pattern) || []).length;
}

function redactSensitivePayloadWithReport(value) {
  const matchCount = countSensitivePayloadMatches(value);
  return {
    payload: redactSensitivePayload(value),
    redaction: {
      applied: matchCount > 0,
      match_count: matchCount,
      marker: SECRET_REDACTION
    }
  };
}

function attachOutputRedactionReport(payload, redaction) {
  if (!payload || typeof payload !== "object") return payload;
  payload.safety = {
    ...(payload.safety || {}),
    output_redaction: redaction
  };
  return payload;
}

function collectCitationFiles(payload = {}) {
  const impactAreas = payload.impact_areas || [];
  return [
    ...(payload.related_files || []).map((file) => file.file_path || file),
    ...impactAreas.flatMap((area) => area.files || []),
    ...(payload.plan?.flatMap((day) => day.files_to_read || []) || []),
    ...(payload.trace?.flatMap((step) => step.citations || []) || [])
  ].filter(Boolean);
}

function validateAgentCitations(project, payload) {
  const knownFiles = new Set(project.files.map((file) => file.path));
  const impactAreas = payload.impact_areas || [];
  const uncitedImpactAreas = impactAreas
    .map((area, index) => ({
      index,
      area: area?.area || `impact_areas[${index}]`,
      files: Array.isArray(area?.files) ? area.files : []
    }))
    .filter((area) => area.files.length === 0);
  const citedFiles = collectCitationFiles(payload);
  const missingFiles = citedFiles.filter((file) => !knownFiles.has(file));
  return {
    passed: citedFiles.length > 0 && missingFiles.length === 0 && uncitedImpactAreas.length === 0,
    cited_file_count: new Set(citedFiles).size,
    missing_files: [...new Set(missingFiles)],
    uncited_impact_areas: uncitedImpactAreas.map((area) => area.area)
  };
}

function matchesSafetyPolicy(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(String(text || "")));
}

function scanInputSafety(question) {
  const lower = question.toLowerCase();
  const checks = [
    {
      name: "Prompt injection",
      risk_type: "prompt_injection",
      passed: !matchesSafetyPolicy(question, SAFETY_POLICY.input.prompt_injection),
      detail: "Detects attempts to override system or developer instructions."
    },
    {
      name: "Secret request",
      risk_type: "secret_request",
      passed: !matchesSafetyPolicy(question, SAFETY_POLICY.input.secret_request),
      detail: "Detects requests to reveal credentials or hidden configuration."
    },
    {
      name: "Tool permissions",
      risk_type: "tool_permission",
      passed: !matchesSafetyPolicy(lower, SAFETY_POLICY.input.tool_permission),
      detail: "Agent tools are restricted to read-only repository analysis."
    }
  ];
  const riskTypes = checks.filter((check) => !check.passed).map((check) => check.risk_type);
  return {
    status: riskTypes.length ? "needs_review" : "passed",
    risk_types: riskTypes,
    risk_details: describeSafetyRisks(riskTypes),
    checks
  };
}

function scanRetrievedSafety(chunks) {
  const injectionFiles = chunks.filter((chunk) => {
    return matchesSafetyPolicy(chunk.content, SAFETY_POLICY.repository.prompt_injection);
  }).map((chunk) => chunk.file_path);
  const sensitiveFiles = chunks.filter((chunk) => SENSITIVE_VALUE_PATTERN.test(chunk.content)).map((chunk) => chunk.file_path);
  const riskTypes = [
    injectionFiles.length ? "retrieved_prompt_injection" : null,
    sensitiveFiles.length ? "retrieved_sensitive_content" : null
  ].filter(Boolean);
  const checks = [
    {
      name: "Retrieved prompt injection",
      risk_type: "retrieved_prompt_injection",
      passed: injectionFiles.length === 0,
      detail: injectionFiles.length
        ? `Instruction-like repository text found in: ${[...new Set(injectionFiles)].slice(0, 5).join(", ")}.`
        : "Retrieved repository text did not contain obvious instruction-override patterns."
    },
    {
      name: "Retrieved sensitive content",
      risk_type: "retrieved_sensitive_content",
      passed: sensitiveFiles.length === 0,
      detail: sensitiveFiles.length
        ? `Sensitive-looking repository values found in: ${[...new Set(sensitiveFiles)].slice(0, 5).join(", ")}. Do not echo raw values.`
        : "Retrieved repository text did not contain obvious credential-like values."
    }
  ];
  return {
    status: riskTypes.length ? "needs_review" : "passed",
    risk_types: riskTypes,
    risk_details: describeSafetyRisks(riskTypes),
    checks,
    flagged_files: [...new Set([...injectionFiles, ...sensitiveFiles])].slice(0, 8),
    flagged_sensitive_files: [...new Set(sensitiveFiles)].slice(0, 8),
    detail: riskTypes.length
      ? "Retrieved repository text contains untrusted instruction-like or sensitive-looking content and was treated only as evidence."
      : "Retrieved repository text did not contain obvious instruction-override or credential-like patterns."
  };
}

function scanOutputSafety(project, payload) {
  const citation = validateAgentCitations(project, payload);
  const serialized = JSON.stringify(payload);
  const secretLike = SENSITIVE_VALUE_PATTERN.test(serialized);
  const refs = collectCitationFiles(payload);
  const impactRefs = [
    ...(payload.impact_areas?.flatMap((area) => area.files || []) || [])
  ].filter(Boolean);
  const uncertainty = String(payload.uncertainty || "");
  const hasImpactAreas = Array.isArray(payload.impact_areas) && payload.impact_areas.length > 0;
  const hasRequiredCitations = hasImpactAreas ? impactRefs.length > 0 : refs.length > 0;
  const overconfident = !hasRequiredCitations && !/high|not sure|insufficient|uncertain|不确定/i.test(uncertainty);
  const checks = [
    {
      name: "Citation coverage",
      risk_type: "missing_citation",
      passed: citation.passed,
      detail: citation.passed
        ? `${citation.cited_file_count} cited repository files validated.`
        : `Missing or unsupported citations: ${citation.missing_files.join(", ") || "none found"}. Uncited impact areas: ${citation.uncited_impact_areas.join(", ") || "none"}.`
    },
    {
      name: "Sensitive output",
      risk_type: "sensitive_output",
      passed: !secretLike,
      detail: secretLike ? "Output contains a value that looks like a credential." : "No obvious credentials detected in output."
    },
    {
      name: "Overconfidence",
      risk_type: "overconfidence",
      passed: !overconfident,
      detail: overconfident ? "Output has no citations and does not clearly mark uncertainty." : "Output cites evidence or marks uncertainty."
    }
  ];
  const riskTypes = checks.filter((check) => !check.passed).map((check) => check.risk_type);
  return {
    status: riskTypes.length ? "needs_review" : "passed",
    risk_types: riskTypes,
    risk_details: describeSafetyRisks(riskTypes),
    checks,
    citation
  };
}

function mergeSafetyReports(...reports) {
  const checks = reports.flatMap((report) => report.checks || [{
    name: report.risk_types?.[0] || "Safety check",
    risk_type: report.risk_types?.[0] || "safety",
    passed: report.status === "passed",
    detail: report.detail || ""
  }]);
  const riskTypes = [...new Set(reports.flatMap((report) => report.risk_types || []))];
  return {
    status: riskTypes.length ? "needs_review" : "passed",
    risk_types: riskTypes,
    risk_details: describeSafetyRisks(riskTypes),
    checks
  };
}

function safetyChecksToGuardrails(checks = []) {
  return checks.map((check) => ({
    name: check.name,
    status: check.passed ? "passed" : "needs_review",
    detail: check.detail
  }));
}

export {
  SENSITIVE_VALUE_PATTERN,
  SECRET_REDACTION,
  SAFETY_RISK_EXPLANATIONS,
  describeSafetyRisks,
  redactSensitiveText,
  redactSensitivePayload,
  countSensitivePayloadMatches,
  redactSensitivePayloadWithReport,
  attachOutputRedactionReport,
  collectCitationFiles,
  validateAgentCitations,
  matchesSafetyPolicy,
  scanInputSafety,
  scanRetrievedSafety,
  scanOutputSafety,
  mergeSafetyReports,
  safetyChecksToGuardrails
};
