import crypto from "node:crypto";
import { DEFAULT_USER_ID, normalizeUserId, apiError } from "./config.js";
import { normalizeMemorySuggestion } from "./memory-db.js";

function createEmptyPreferences() {
  return {
    role: null,
    language: null,
    detailLevel: null,
    focusAreas: [],
    taskTypes: [],
    updatedAt: null
  };
}

const MEMORY_PREFERENCE_KEYS = new Set(["role", "language", "detailLevel", "focusAreas", "taskTypes"]);

const MEMORY_VALUE_OPTIONS = {
  role: new Set(["Product Manager", "QA", "Backend Engineer", "Frontend Engineer"]),
  language: new Set(["zh"]),
  detailLevel: new Set(["concise", "detailed"]),
  focusAreas: new Set(["testing", "risk", "safety"]),
  taskTypes: new Set(["impact_analysis"])
};

function normalizePreferences(preferences) {
  const normalized = {
    ...createEmptyPreferences(),
    ...(preferences || {})
  };
  normalized.focusAreas = Array.isArray(normalized.focusAreas)
    ? normalized.focusAreas.filter((value) => isKnownMemoryValue("focusAreas", value))
    : [];
  normalized.taskTypes = Array.isArray(normalized.taskTypes)
    ? normalized.taskTypes.filter((value) => isKnownMemoryValue("taskTypes", value))
    : [];
  if (!isKnownMemoryValue("role", normalized.role)) normalized.role = null;
  if (!isKnownMemoryValue("language", normalized.language)) normalized.language = null;
  if (!isKnownMemoryValue("detailLevel", normalized.detailLevel)) normalized.detailLevel = null;
  return normalized;
}

function getUserPreferences(store, userId = DEFAULT_USER_ID) {
  const normalizedUserId = normalizeUserId(userId);
  store.userPreferencesByUser ||= {};
  if (!store.userPreferencesByUser[normalizedUserId]) {
    store.userPreferencesByUser[normalizedUserId] = normalizedUserId === DEFAULT_USER_ID
      ? normalizePreferences(store.userPreferences)
      : createEmptyPreferences();
  }
  return normalizePreferences(store.userPreferencesByUser[normalizedUserId]);
}

function setUserPreferences(store, userId, preferences) {
  const normalizedUserId = normalizeUserId(userId);
  store.userPreferencesByUser ||= {};
  store.userPreferencesByUser[normalizedUserId] = normalizePreferences(preferences);
  if (normalizedUserId === DEFAULT_USER_ID) {
    store.userPreferences = store.userPreferencesByUser[normalizedUserId];
  }
  return store.userPreferencesByUser[normalizedUserId];
}

function isKnownMemoryValue(key, value) {
  if (value == null) return true;
  return typeof value === "string" && MEMORY_VALUE_OPTIONS[key]?.has(value);
}

function validateMemorySuggestionValue(suggestion) {
  if (!MEMORY_PREFERENCE_KEYS.has(suggestion.key)) {
    throw apiError("Unknown memory preference key.", "UNKNOWN_MEMORY_PREFERENCE_KEY");
  }
  if (!isKnownMemoryValue(suggestion.key, suggestion.value)) {
    throw apiError("Unknown memory preference value.", "UNKNOWN_MEMORY_PREFERENCE_VALUE");
  }
}

function extractSymbols(content) {
  const symbols = [];
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g,
    /(?:class|interface|type)\s+([A-Za-z0-9_]+)/g,
    /([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g
  ];
  patterns.forEach((pattern) => {
    for (const match of content.matchAll(pattern)) symbols.push(match[1]);
  });
  return [...new Set(symbols)].slice(0, 6);
}

function relatedFilesFromChunks(chunks) {
  const seen = new Map();
  chunks.forEach((chunk) => {
    if (!seen.has(chunk.file_path)) {
      const symbols = extractSymbols(chunk.content);
      seen.set(chunk.file_path, {
        file_path: chunk.file_path,
        reason: symbols.length
          ? `Relevant symbols: ${symbols.join(", ")}`
          : `Relevant lines ${chunk.start_line}-${chunk.end_line}`
      });
    }
  });
  return [...seen.values()].slice(0, 8);
}

function inferQuestionType(question) {
  const lower = question.toLowerCase();
  if (/impact|affect|change|add|modify|影响|变更|新增|修改|状态|字段/.test(lower)) return "impact";
  if (/onboard|learning|first week|read first|新人|入门|学习/.test(lower)) return "onboarding";
  return "qa";
}

function generateQaAnswer(question, chunks) {
  const relatedFiles = relatedFilesFromChunks(chunks);
  if (chunks.length === 0) {
    return {
      answer: "I could not find enough repository context to answer this confidently.",
      key_points: ["No matching chunks were retrieved from the imported files."],
      related_files: [],
      uncertainty: "High. Ask a more specific question or import a repository with source files and documentation.",
      suggested_next_questions: [
        "What files should I read first?",
        "What are the main modules in this repository?"
      ]
    };
  }

  const keyPoints = chunks.slice(0, 5).map((chunk) => {
    const symbols = extractSymbols(chunk.content);
    const symbolText = symbols.length ? ` Symbols found: ${symbols.join(", ")}.` : "";
    return `${chunk.file_path} contains matching context around lines ${chunk.start_line}-${chunk.end_line}.${symbolText}`;
  });

  return {
    answer: `Based on the retrieved repository context, the most relevant evidence for "${question}" is concentrated in ${relatedFiles.map((file) => file.file_path).join(", ")}. The answer should be treated as code-grounded: inspect those files first, especially the cited symbols and line ranges.`,
    key_points: keyPoints,
    related_files: relatedFiles,
    uncertainty: chunks.length < 3
      ? "Medium to high. Only a small amount of matching repository context was retrieved."
      : "Low to medium. The answer is based on retrieved files, but runtime behavior may depend on code outside the top matches.",
    suggested_next_questions: [
      "Which functions are most important here?",
      "What tests should cover this behavior?",
      "What would be impacted if this logic changes?"
    ]
  };
}

function generateImpactAnswer(question, chunks, project) {
  const related = relatedFilesFromChunks(chunks);
  const areas = [];
  const areaRules = [
    ["Data Model", ["model", "schema", "type", "interface", "entity"]],
    ["API Routes", ["route", "controller", "api", "endpoint"]],
    ["Business Logic", ["service", "usecase", "workflow"]],
    ["Persistence", ["repository", "database", "migration", "prisma"]],
    ["UI / Presentation", ["page", "component", "view", "tsx"]],
    ["Tests", ["test", "spec", "__tests__"]]
  ];

  areaRules.forEach(([area, terms]) => {
    const files = related
      .filter((file) => terms.some((term) => file.file_path.toLowerCase().includes(term) || file.reason.toLowerCase().includes(term)))
      .map((file) => file.file_path);
    if (files.length) {
      areas.push({
        area,
        files,
        risk_level: area === "Data Model" || area === "Business Logic" ? "high" : "medium",
        reason: `${area} files matched the requested change and may need coordinated updates.`
      });
    }
  });

  if (areas.length === 0 && related.length) {
    areas.push({
      area: "Relevant Code Paths",
      files: related.map((file) => file.file_path),
      risk_level: "medium",
      reason: "The retriever found these files as the closest available evidence for the requested change."
    });
  }

  const risk = areas.some((area) => area.risk_level === "high") ? "medium-high" : "medium";
  return {
    summary: `Requested change: ${question}. Based on ${project.name}, this looks like a ${risk} risk change because it may touch data shape, business flow, UI display, and tests depending on the cited files.`,
    impact_areas: areas,
    testing_suggestions: [
      "Add or update unit tests around the changed status, field, or branch.",
      "Test the happy path and failure path for every cited service or route.",
      "Verify UI display, filters, and empty states if presentation files are cited.",
      "Run regression tests for adjacent flows such as create, update, cancel, refund, or payment where applicable."
    ],
    open_questions: [
      "Is the new behavior backwards compatible with existing persisted data?",
      "Are there analytics, reports, or admin filters that depend on this value?",
      "Should API clients receive a versioned response or migration notice?"
    ]
  };
}

function inferPreferenceSignals(question) {
  const lower = question.toLowerCase();
  const signals = [];
  if (/[\u4e00-\u9fa5]/.test(question)) {
    signals.push({ key: "language", value: "zh", label: "Chinese preferred", confidence: "high" });
  }
  if (/\b(pm|product manager|prd|requirement)\b|产品|需求/.test(lower)) {
    signals.push({ key: "role", value: "Product Manager", label: "Product manager perspective", confidence: "medium" });
  }
  if (/\bqa\b|test|测试|质量/.test(lower)) {
    signals.push({ key: "role", value: "QA", label: "QA perspective", confidence: "medium" });
    signals.push({ key: "focusAreas", value: "testing", label: "Testing focus", confidence: "medium" });
  }
  if (/backend|api|service|database|后端/.test(lower)) {
    signals.push({ key: "role", value: "Backend Engineer", label: "Backend perspective", confidence: "medium" });
  }
  if (/frontend|ui|page|component|前端|页面|组件/.test(lower)) {
    signals.push({ key: "role", value: "Frontend Engineer", label: "Frontend perspective", confidence: "medium" });
  }
  if (/short|brief|concise|简洁|简短/.test(lower)) {
    signals.push({ key: "detailLevel", value: "concise", label: "Concise answers", confidence: "high" });
  }
  if (/deep|detailed|详细|深入/.test(lower)) {
    signals.push({ key: "detailLevel", value: "detailed", label: "Detailed answers", confidence: "medium" });
  }
  if (/risk|impact|风险|影响/.test(lower)) {
    signals.push({ key: "focusAreas", value: "risk", label: "Risk focus", confidence: "medium" });
    signals.push({ key: "taskTypes", value: "impact_analysis", label: "Impact analysis tasks", confidence: "medium" });
  }
  if (/security|prompt injection|guardrail|安全|护栏/.test(lower)) {
    signals.push({ key: "focusAreas", value: "safety", label: "AI safety focus", confidence: "medium" });
  }
  return signals;
}

function preferenceAlreadyKnown(preferences, signal) {
  const current = preferences?.[signal.key];
  if (Array.isArray(current)) return current.includes(signal.value);
  return current === signal.value;
}

function createMemorySuggestions(store, projectId, question, userId = DEFAULT_USER_ID) {
  const normalizedUserId = normalizeUserId(userId);
  const preferences = getUserPreferences(store, normalizedUserId);
  return inferPreferenceSignals(question)
    .filter((signal) => !preferenceAlreadyKnown(preferences, signal))
    .filter((signal) => !store.memorySuggestions.some((item) => {
      return ["pending", "ignored"].includes(item.status)
        && (item.userId || DEFAULT_USER_ID) === normalizedUserId
        && item.key === signal.key
        && item.value === signal.value;
    }))
    .map((signal) => ({
      id: crypto.randomUUID(),
      userId: normalizedUserId,
      projectId,
      key: signal.key,
      value: signal.value,
      label: signal.label,
      confidence: signal.confidence,
      reason: `Inferred from recent request: "${question.slice(0, 120)}"`,
      status: "pending",
      createdAt: new Date().toISOString()
    }))
    .slice(0, 3);
}

function appendMemorySuggestions(store, suggestions = []) {
  const appended = [];
  for (const suggestion of suggestions) {
    const normalized = normalizeMemorySuggestion(suggestion);
    if (!normalized) continue;
    const duplicate = store.memorySuggestions.some((item) => {
      return item.status === normalized.status
        && (item.userId || DEFAULT_USER_ID) === (normalized.userId || DEFAULT_USER_ID)
        && (item.projectId || null) === (normalized.projectId || null)
        && item.key === normalized.key
        && item.value === normalized.value;
    });
    if (duplicate) continue;
    store.memorySuggestions.push(normalized);
    appended.push(normalized);
  }
  return appended;
}

function applyMemorySuggestion(preferences, suggestion) {
  const next = {
    ...createEmptyPreferences(),
    ...(preferences || {})
  };
  if (suggestion.key === "focusAreas" || suggestion.key === "taskTypes") {
    const values = new Set(Array.isArray(next[suggestion.key]) ? next[suggestion.key] : []);
    values.add(suggestion.value);
    next[suggestion.key] = [...values];
  } else if (Object.hasOwn(next, suggestion.key)) {
    next[suggestion.key] = suggestion.value;
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function createMemoryEvent({ userId = DEFAULT_USER_ID, projectId = null, suggestion = null, action, key = null, value = null, label = null, status = null }) {
  return {
    id: crypto.randomUUID(),
    userId: suggestion?.userId || normalizeUserId(userId),
    projectId: suggestion?.projectId || projectId || null,
    suggestionId: suggestion?.id || null,
    action,
    key: suggestion?.key || key || null,
    value: suggestion?.value || value || null,
    label: suggestion?.label || label || action,
    status: status || action,
    createdAt: new Date().toISOString()
  };
}

function summarizePreferences(preferences) {
  const active = [];
  if (preferences.role) active.push(`role=${preferences.role}`);
  if (preferences.language) active.push(`language=${preferences.language}`);
  if (preferences.detailLevel) active.push(`detail=${preferences.detailLevel}`);
  if (preferences.focusAreas?.length) active.push(`focus=${preferences.focusAreas.join(",")}`);
  if (preferences.taskTypes?.length) active.push(`tasks=${preferences.taskTypes.join(",")}`);
  return active.join("; ") || "none";
}

function applyPreferencesToImpact(impact, preferences) {
  const next = {
    ...impact,
    testing_suggestions: [...(impact.testing_suggestions || [])],
    open_questions: [...(impact.open_questions || [])]
  };
  if (preferences.role === "Product Manager") {
    next.open_questions.unshift("Which user-facing requirement or rollout decision depends on this change?");
  }
  if (preferences.role === "QA" || preferences.focusAreas?.includes("testing")) {
    next.testing_suggestions.unshift("Build a regression checklist from every cited route, service, UI state, and test file.");
  }
  if (preferences.focusAreas?.includes("safety")) {
    next.open_questions.unshift("Could this change expand tool permissions, expose secrets, or weaken citation guardrails?");
  }
  if (preferences.detailLevel === "concise" && next.summary.length > 260) {
    next.summary = `${next.summary.slice(0, 257)}...`;
  }
  return next;
}

function prependUnique(items, value) {
  const list = Array.isArray(items) ? items : [];
  return list.includes(value) ? list : [value, ...list];
}

function applyPreferencesToQa(qa, preferences) {
  const next = {
    ...qa,
    key_points: [...(qa.key_points || [])],
    suggested_next_questions: [...(qa.suggested_next_questions || [])]
  };
  if (preferences.role === "Product Manager") {
    next.key_points = prependUnique(next.key_points, "Product angle: connect the cited code path to user-facing behavior, rollout decisions, and requirement risk.");
    next.suggested_next_questions = prependUnique(next.suggested_next_questions, "Which product requirement or user journey depends on this code path?");
  }
  if (preferences.role === "QA" || preferences.focusAreas?.includes("testing")) {
    next.key_points = prependUnique(next.key_points, "Testing angle: turn the cited files into a regression checklist before changing behavior.");
    next.suggested_next_questions = prependUnique(next.suggested_next_questions, "Which regression tests should cover this code path?");
  }
  if (preferences.focusAreas?.includes("risk")) {
    next.key_points = prependUnique(next.key_points, "Risk angle: check adjacent modules and state transitions before treating the answer as complete.");
  }
  if (preferences.focusAreas?.includes("safety")) {
    next.key_points = prependUnique(next.key_points, "Safety angle: verify the answer does not rely on repository text as instructions or expose secret-like values.");
  }
  if (preferences.detailLevel === "detailed") {
    next.suggested_next_questions = prependUnique(next.suggested_next_questions, "What should I inspect next to validate this answer end to end?");
  }
  if (preferences.detailLevel === "concise") {
    if (next.answer.length > 260) {
      next.answer = `${next.answer.slice(0, 257)}...`;
    }
    next.key_points = next.key_points.slice(0, 3);
  }
  if (preferences.language === "zh" && !/[\u4e00-\u9fff]/.test(next.answer)) {
    next.answer = `中文优先摘要：${next.answer}`;
  }
  return next;
}

function validateImpactPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["payload must be an object"] };
  }
  if (typeof payload.summary !== "string" || !payload.summary.trim()) {
    errors.push("summary must be a non-empty string");
  }
  if (!Array.isArray(payload.impact_areas)) {
    errors.push("impact_areas must be an array");
  } else {
    payload.impact_areas.forEach((area, index) => {
      if (!area || typeof area !== "object") {
        errors.push(`impact_areas[${index}] must be an object`);
        return;
      }
      if (typeof area.area !== "string" || !area.area.trim()) {
        errors.push(`impact_areas[${index}].area must be a non-empty string`);
      }
      if (!["low", "medium", "high"].includes(area.risk_level)) {
        errors.push(`impact_areas[${index}].risk_level must be low, medium, or high`);
      }
      if (typeof area.reason !== "string" || !area.reason.trim()) {
        errors.push(`impact_areas[${index}].reason must be a non-empty string`);
      }
      if (!Array.isArray(area.files)) {
        errors.push(`impact_areas[${index}].files must be an array`);
      }
    });
  }
  if (!Array.isArray(payload.testing_suggestions)) {
    errors.push("testing_suggestions must be an array");
  }
  if (!Array.isArray(payload.open_questions)) {
    errors.push("open_questions must be an array");
  }
  return { valid: errors.length === 0, errors };
}

function validateQaPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["payload must be an object"] };
  }
  if (typeof payload.answer !== "string" || !payload.answer.trim()) {
    errors.push("answer must be a non-empty string");
  }
  if (!Array.isArray(payload.key_points)) {
    errors.push("key_points must be an array");
  }
  if (!Array.isArray(payload.related_files)) {
    errors.push("related_files must be an array");
  } else {
    payload.related_files.forEach((file, index) => {
      if (!file || typeof file !== "object") {
        errors.push(`related_files[${index}] must be an object`);
        return;
      }
      if (typeof file.file_path !== "string" || !file.file_path.trim()) {
        errors.push(`related_files[${index}].file_path must be a non-empty string`);
      }
      if (typeof file.reason !== "string" || !file.reason.trim()) {
        errors.push(`related_files[${index}].reason must be a non-empty string`);
      }
    });
  }
  if (typeof payload.uncertainty !== "string" || !payload.uncertainty.trim()) {
    errors.push("uncertainty must be a non-empty string");
  }
  if (!Array.isArray(payload.suggested_next_questions)) {
    errors.push("suggested_next_questions must be an array");
  }
  return { valid: errors.length === 0, errors };
}

function generateOnboardingPlan(project, role, duration) {
  const days = duration === "5 days" ? 5 : 3;
  const recommended = project.summary.recommendedFiles.length
    ? project.summary.recommendedFiles
    : project.files.slice(0, 8).map((file) => file.path);
  const roleFocus = {
    "Backend Engineer": ["startup and architecture", "routes, services, and data models", "core business flow and tests", "error handling and integrations", "first scoped change plan"],
    "Frontend Engineer": ["app structure and UI entry points", "pages and components", "API contracts and states", "edge cases and design gaps", "first scoped UI improvement"],
    "Product Manager": ["product context and modules", "business flows and APIs", "state changes and risks", "metrics and user scenarios", "requirements and rollout plan"],
    QA: ["business rules and critical flows", "test files and edge cases", "failure paths and data states", "regression matrix", "test plan review"]
  };
  const focus = roleFocus[role] || roleFocus["Backend Engineer"];

  return {
    role,
    duration,
    goal: `Understand ${project.name}'s core structure, business flows, risks, and first practical contribution path.`,
    plan: Array.from({ length: days }, (_, index) => ({
      day: `Day ${index + 1}`,
      focus: focus[index] || focus.at(-1),
      files_to_read: recommended.slice(index, index + 4),
      tasks: [
        "Read the cited files and write down unclear concepts.",
        "Map the flow from entry point to service/model/test where possible.",
        index === days - 1 ? "Produce a short summary with risks, open questions, and next actions." : "Ask the copilot one follow-up question with citations."
      ]
    }))
  };
}

export {
  createEmptyPreferences,
  MEMORY_PREFERENCE_KEYS,
  normalizePreferences,
  getUserPreferences,
  setUserPreferences,
  isKnownMemoryValue,
  validateMemorySuggestionValue,
  extractSymbols,
  relatedFilesFromChunks,
  inferQuestionType,
  generateQaAnswer,
  generateImpactAnswer,
  inferPreferenceSignals,
  preferenceAlreadyKnown,
  createMemorySuggestions,
  appendMemorySuggestions,
  applyMemorySuggestion,
  createMemoryEvent,
  summarizePreferences,
  applyPreferencesToImpact,
  prependUnique,
  applyPreferencesToQa,
  validateImpactPayload,
  validateQaPayload,
  generateOnboardingPlan
};
