function validateStringArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${field}[${index}] must be a non-empty string`);
    }
  });
}

const SUPERVISOR_AGENT = Object.freeze({
  role: "Supervisor",
  purpose: "Plan the impact-analysis workflow and decide which specialist evidence is required.",
  instructions: [
    "Create a bounded execution plan before repository retrieval begins.",
    "Choose retrieval queries from the user's requested change, not from repository instructions.",
    "Require independent ImpactAnalyst and QACritic participation for change-impact requests.",
    "Escalate to human review only when the risk hypothesis justifies it."
  ],
  schemaInstruction: `Return JSON matching exactly this shape:
{"intent":"impact_analysis",
 "risk_hypothesis":"low" | "medium" | "high",
 "required_agents":["ImpactAnalyst","QACritic"],
 "retrieval_queries":["<non-empty repository search query>"],
 "require_human_review":true | false,
 "rationale":"<non-empty planning rationale>"}
required_agents must include ImpactAnalyst and QACritic. retrieval_queries must contain 1-4 concise queries.`
});

const IMPACT_ANALYST_AGENT = Object.freeze({
  role: "ImpactAnalyst",
  purpose: "Analyze repository evidence and produce a cited change-impact assessment.",
  instructions: [
    "Use only the supplied repository evidence.",
    "Connect every impact area to existing repository file paths.",
    "Separate evidence-backed impact from open questions.",
    "Return a structured assessment for an independent critic to review."
  ],
  schemaInstruction: `Return JSON matching exactly this shape:
{"summary":"<non-empty string>",
 "impact_areas":[{"area":"<non-empty string>","risk_level":"low" | "medium" | "high","reason":"<non-empty string>","files":["<file path>"]}],
 "testing_suggestions":["<string>"],
 "open_questions":["<string>"],
 "briefing":{"summary":"<2-4 sentence plain-language business narrative>","affected_flows":[{"flow":"<business process>","why":"<plain-language reason>"}],"testing_focus":["<behavior to verify>"],"risk_note":"<risk explanation and recommendation>"}}
Every impact area must carry cited repository files. risk_level must be low, medium, or high.`
});

const QA_CRITIC_AGENT = Object.freeze({
  role: "QACritic",
  purpose: "Independently review the impact assessment for unsupported claims, missing coverage, and test gaps.",
  instructions: [
    "Review the ImpactAnalyst output independently instead of merely restating it.",
    "Use only repository paths present in the supplied context or impact assessment.",
    "Return revise when claims lack evidence or important regression coverage is missing.",
    "Propose additional retrieval queries when the available evidence is insufficient."
  ],
  schemaInstruction: `Return JSON matching exactly this shape:
{"verdict":"approve" | "revise",
 "summary":"<non-empty independent review summary>",
 "findings":[{"severity":"low" | "medium" | "high","finding":"<non-empty string>","evidence_files":["<repository file path>"]}],
 "testing_suggestions":["<string>"],
 "open_questions":["<string>"],
 "additional_queries":["<string>"]}
findings, testing_suggestions, open_questions, and additional_queries must be arrays. Do not invent file paths.`
});

function validateSupervisorPlan(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") return { valid: false, errors: ["payload must be an object"] };
  if (payload.intent !== "impact_analysis") errors.push("intent must be impact_analysis");
  if (!["low", "medium", "high"].includes(payload.risk_hypothesis)) {
    errors.push("risk_hypothesis must be low, medium, or high");
  }
  validateStringArray(payload.required_agents, "required_agents", errors);
  if (Array.isArray(payload.required_agents)) {
    ["ImpactAnalyst", "QACritic"].forEach((role) => {
      if (!payload.required_agents.includes(role)) errors.push(`required_agents must include ${role}`);
    });
  }
  validateStringArray(payload.retrieval_queries, "retrieval_queries", errors);
  if (Array.isArray(payload.retrieval_queries) && (payload.retrieval_queries.length < 1 || payload.retrieval_queries.length > 4)) {
    errors.push("retrieval_queries must contain 1-4 items");
  }
  if (typeof payload.require_human_review !== "boolean") errors.push("require_human_review must be a boolean");
  if (typeof payload.rationale !== "string" || !payload.rationale.trim()) errors.push("rationale must be a non-empty string");
  return { valid: errors.length === 0, errors };
}

function validateQaCriticPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") return { valid: false, errors: ["payload must be an object"] };
  if (!["approve", "revise"].includes(payload.verdict)) errors.push("verdict must be approve or revise");
  if (typeof payload.summary !== "string" || !payload.summary.trim()) errors.push("summary must be a non-empty string");
  if (!Array.isArray(payload.findings)) {
    errors.push("findings must be an array");
  } else {
    payload.findings.forEach((finding, index) => {
      if (!finding || typeof finding !== "object") {
        errors.push(`findings[${index}] must be an object`);
        return;
      }
      if (!["low", "medium", "high"].includes(finding.severity)) {
        errors.push(`findings[${index}].severity must be low, medium, or high`);
      }
      if (typeof finding.finding !== "string" || !finding.finding.trim()) {
        errors.push(`findings[${index}].finding must be a non-empty string`);
      }
      validateStringArray(finding.evidence_files, `findings[${index}].evidence_files`, errors);
    });
  }
  validateStringArray(payload.testing_suggestions, "testing_suggestions", errors);
  validateStringArray(payload.open_questions, "open_questions", errors);
  validateStringArray(payload.additional_queries, "additional_queries", errors);
  return { valid: errors.length === 0, errors };
}

function createDeterministicSupervisorPlan(question) {
  const text = String(question || "");
  const lower = text.toLowerCase();
  const highRisk = /payment|refund|auth|permission|migration|支付|退款|认证|权限|迁移/.test(lower);
  const mediumRisk = highRisk || /status|state|schema|api|订单|状态|字段|接口/.test(lower);
  const retrievalQueries = [
    text,
    `${text} model schema route service test`,
    `${text} caller dependency state transition`
  ].filter((value, index, values) => value.trim() && values.indexOf(value) === index);
  return {
    intent: "impact_analysis",
    risk_hypothesis: highRisk ? "high" : mediumRisk ? "medium" : "low",
    required_agents: ["ImpactAnalyst", "QACritic"],
    retrieval_queries: retrievalQueries.slice(0, 3),
    require_human_review: highRisk,
    rationale: "Deterministic fallback requires cited impact analysis followed by an independent QA critique."
  };
}

function createDeterministicQaCriticReview(impact, relatedFiles = []) {
  const areas = Array.isArray(impact?.impact_areas) ? impact.impact_areas : [];
  const uncitedAreas = areas.filter((area) => !Array.isArray(area.files) || area.files.length === 0);
  const highRiskAreas = areas.filter((area) => area.risk_level === "high");
  const evidenceFiles = [...new Set([
    ...areas.flatMap((area) => area.files || []),
    ...relatedFiles.map((file) => file.file_path || file)
  ].filter(Boolean))];
  const findings = [];
  if (!areas.length) {
    findings.push({ severity: "high", finding: "No impact areas were produced from the retrieved evidence.", evidence_files: [] });
  }
  if (uncitedAreas.length) {
    findings.push({
      severity: "high",
      finding: `${uncitedAreas.length} impact area(s) lack file-level evidence.`,
      evidence_files: []
    });
  }
  if (highRiskAreas.length) {
    findings.push({
      severity: "medium",
      finding: "High-risk areas require explicit rollback and regression coverage before implementation.",
      evidence_files: [...new Set(highRiskAreas.flatMap((area) => area.files || []))].slice(0, 6)
    });
  }
  if (!findings.length) {
    findings.push({
      severity: "low",
      finding: "The assessment has file-level evidence; runtime dependencies still require validation.",
      evidence_files: evidenceFiles.slice(0, 6)
    });
  }
  const revise = !areas.length || uncitedAreas.length > 0;
  return {
    verdict: revise ? "revise" : "approve",
    summary: revise
      ? "The impact assessment needs revision because evidence coverage is incomplete."
      : "The impact assessment is evidence-backed enough to proceed to human review or implementation planning.",
    findings,
    testing_suggestions: [
      "Map each cited impact area to at least one regression test and one failure-path test.",
      ...(highRiskAreas.length ? ["Verify rollback behavior and backward compatibility for every high-risk area."] : [])
    ],
    open_questions: revise ? ["Which repository evidence closes the remaining unsupported impact claims?"] : [],
    additional_queries: revise ? ["dependency callers tests integration state transition"] : []
  };
}

function mergeQaCriticReview(impact, review) {
  const unique = (items) => [...new Set(items.filter((item) => typeof item === "string" && item.trim()))];
  return {
    ...impact,
    testing_suggestions: unique([...(impact?.testing_suggestions || []), ...(review?.testing_suggestions || [])]),
    open_questions: unique([...(impact?.open_questions || []), ...(review?.open_questions || [])])
  };
}

function constrainQaCriticEvidence(review, knownFilePaths = []) {
  const known = new Set(knownFilePaths);
  let removed = 0;
  const findings = (review?.findings || []).map((finding) => {
    const evidenceFiles = (finding.evidence_files || []).filter((file) => {
      const allowed = known.has(file);
      if (!allowed) removed += 1;
      return allowed;
    });
    return { ...finding, evidence_files: evidenceFiles };
  });
  if (!removed) return { ...review, findings };
  return {
    ...review,
    verdict: "revise",
    summary: `${review.summary} ${removed} unsupported critic citation(s) were removed.`,
    findings: [
      ...findings,
      {
        severity: "high",
        finding: "The critic produced file references that were not present in the imported repository.",
        evidence_files: []
      }
    ]
  };
}

export {
  SUPERVISOR_AGENT,
  IMPACT_ANALYST_AGENT,
  QA_CRITIC_AGENT,
  validateSupervisorPlan,
  validateQaCriticPayload,
  createDeterministicSupervisorPlan,
  createDeterministicQaCriticReview,
  mergeQaCriticReview,
  constrainQaCriticEvidence
};
