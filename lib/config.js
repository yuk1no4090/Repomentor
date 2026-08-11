import { readFileSync } from "node:fs";
import path from "node:path";

// NOTE: This module is the shared, dependency-free base for lib/**. Per the
// storage-layer split, lib modules may only depend on lib/config.js (never on
// each other or on server.js), so a small number of generic, business-logic-free
// helpers that other lib modules need (apiError, normalizeUserId) live here
// alongside the environment-driven constants, even though they are not
// themselves environment configuration. Everything else in this file is a pure
// move of server.js's original top-of-file bootstrap/config block.

export const ROOT = process.cwd();

export function loadEnvFile() {
  try {
    const content = readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
    console.log("[env] Loaded .env file.");
  } catch {
    // .env file is optional
  }
}

loadEnvFile();

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || "127.0.0.1";
export const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
export const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
export const shouldLog = (level) => (LOG_LEVELS[level] ?? 1) >= (LOG_LEVELS[LOG_LEVEL] ?? 1);

export function log(level, message, extra = {}) {
  if (!shouldLog(level)) return;
  const entry = { time: new Date().toISOString(), level, message, ...extra };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
export const PUBLIC_DIR = path.join(ROOT, "public");
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");
export const STORE_PATH = process.env.STORE_PATH
  ? path.resolve(process.env.STORE_PATH)
  : path.join(DATA_DIR, "store.json");
export const MEMORY_DB_PATH = process.env.MEMORY_DB_PATH
  ? path.resolve(process.env.MEMORY_DB_PATH)
  : path.join(DATA_DIR, "memory.sqlite");
export const DEFAULT_USER_ID = "local-user";
export const MEMORY_EMBEDDING_MODEL = "local-hash-v1";
export const MEMORY_EMBEDDING_DIMS = 64;
export const MEMORY_VECTOR_INDEX_PROVIDER = String(process.env.MEMORY_VECTOR_INDEX_PROVIDER || "").toLowerCase();
export const AUTH_REQUIRED = /^(1|true|yes)$/i.test(String(process.env.AI_PM_AUTH_REQUIRED || ""));
export const AUTH_TOKEN_CONFIG = process.env.AI_PM_USER_TOKENS || "";

export function readTextFileSafe(filePath) {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function resolvePackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function resolveRuntimeCommit() {
  const envCommit = process.env.GITHUB_SHA
    || process.env.COMMIT_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.RENDER_GIT_COMMIT;
  if (envCommit) return envCommit.slice(0, 12);

  const gitDir = path.join(ROOT, ".git");
  const head = readTextFileSafe(path.join(gitDir, "HEAD"));
  if (!head) return "unknown";
  if (!head.startsWith("ref:")) return head.slice(0, 12);

  const refName = head.slice(5).trim();
  const refCommit = readTextFileSafe(path.join(gitDir, refName));
  if (refCommit) return refCommit.slice(0, 12);

  const packedRefs = readTextFileSafe(path.join(gitDir, "packed-refs"));
  const packedLine = packedRefs
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && line.endsWith(` ${refName}`));
  return packedLine ? packedLine.split(/\s+/)[0].slice(0, 12) : "unknown";
}

export const RUNTIME_METADATA = Object.freeze({
  version: resolvePackageVersion(),
  commit: resolveRuntimeCommit(),
  node: process.version,
  environment: process.env.NODE_ENV || "development"
});

export const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".js",
  ".ts",
  ".tsx",
  ".py",
  ".java",
  ".json",
  ".yaml",
  ".yml"
]);

export const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "vendor"
]);

export const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 2_500;
export const MAX_ZIP_BYTES = 22 * 1024 * 1024;
export const MAX_IMPORTED_FILES = 450;
export const MAX_IMPORTED_FILE_BYTES = 400_000;
export const MAX_IMPORTED_TOTAL_BYTES = 12 * 1024 * 1024;
export const GITHUB_IMPORT_TIMEOUT_MS = 15_000;
export const MAX_QUESTION_LENGTH = 16_000;
export const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

export const AGENT_MAX_STEPS = parsePositiveIntegerEnv("AGENT_MAX_STEPS", 14);
export const AGENT_BUDGETS = {
  max_steps: AGENT_MAX_STEPS,
  timeout_ms: 30_000,
  max_context_tokens: 8_000
};
export const AGENT_GRAPH_MODE = String(process.env.AGENT_GRAPH_MODE || "supervisor").toLowerCase();
export const AGENT_HITL_ENABLED = String(process.env.AGENT_HITL_ENABLED || "false").toLowerCase() === "true";

// ── Simple in-memory rate limiter (token bucket per IP) ──
export const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120);     // requests per window (0 = disabled)
export const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
export const rateBuckets = new Map();
let rateLimitRequestCount = 0;

export function checkRateLimit(ip) {
  if (RATE_LIMIT_MAX === 0) return true; // disabled
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true; // local dev
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  // Periodic cleanup (every 1000 requests)
  rateLimitRequestCount += 1;
  if (rateLimitRequestCount % 1000 === 0) {
    for (const [key, b] of rateBuckets) {
      if (now - b.windowStart > RATE_LIMIT_WINDOW_MS * 2) rateBuckets.delete(key);
    }
  }
  return bucket.count <= RATE_LIMIT_MAX;
}

export function parsePositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const LLM_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv("LLM_REQUEST_TIMEOUT_MS", AGENT_BUDGETS.timeout_ms);
export const LLM_CONTEXT_TOKEN_BUDGET = parsePositiveIntegerEnv("LLM_CONTEXT_TOKEN_BUDGET", AGENT_BUDGETS.max_context_tokens);
export const MEMORY_EMBEDDING_PROVIDER = String(process.env.MEMORY_EMBEDDING_PROVIDER || "").toLowerCase();

export const AGENT_TOOL_REGISTRY = [
  { name: "safety.scan_input", capability: "input_guardrail", access: "read-only", external_network: false, agent_role: "SafetyGuard" },
  { name: "memory.load_preferences", capability: "preference_memory", access: "read-only", external_network: false, agent_role: "MemoryCurator" },
  { name: "classifier_agent.classify_change_request", capability: "classification", access: "read-only", external_network: false, agent_role: "Classifier" },
  { name: "retriever_agent.retrieve_repository_chunks", capability: "repo_retrieval", access: "read-only", external_network: false, agent_role: "Retriever" },
  { name: "context_expander_agent.expand_dependency_context", capability: "repo_context_expansion", access: "read-only", external_network: false, agent_role: "Retriever" },
  { name: "impact_analyst_agent.estimate_impact_risk", capability: "impact_analysis", access: "read-only", external_network: false, agent_role: "ImpactAnalyst" },
  { name: "qa_planner_agent.plan_regression_tests", capability: "qa_planning", access: "read-only", external_network: false, agent_role: "QAPlanner" },
  { name: "onboarding_planner_agent.generate_plan", capability: "onboarding_planning", access: "read-only", external_network: false, agent_role: "OnboardingPlanner" },
  { name: "safety_guardrail_agent.validate_output", capability: "output_guardrail", access: "read-only", external_network: false, agent_role: "SafetyGuard" },
  { name: "synthesizer_agent.compose_structured_answer", capability: "structured_synthesis", access: "read-only", external_network: false, agent_role: "Synthesizer" },
  { name: "agent_harness.fallback", capability: "deterministic_fallback", access: "read-only", external_network: false, agent_role: "Harness" }
];

export const AGENT_TOOL_POLICY = {
  mode: "read-only",
  allow_external_network: false,
  allow_repository_writes: false,
  allow_shell_execution: false
};

export const SAFETY_POLICY = Object.freeze({
  version: "2026-07-06.redteam-v1",
  input: {
    prompt_injection: [
      /(ignore|bypass|override).{0,40}(system|developer|instruction|rules|previous)/i,
      /(reveal|show|print|dump|leak).{0,40}(system|developer).{0,20}(prompt|message|instruction)/i,
      /jailbreak/i,
      /忽略.{0,20}(系统|指令|规则)/i,
      /绕过.{0,20}(系统|指令|规则)/i,
      /泄露.{0,20}(系统|开发者|提示|指令)/i
    ],
    secret_request: [
      /(api[_ -]?key|secret|token|password|credential)/i,
      /泄露|密钥|令牌|密码|凭证/i
    ],
    tool_permission: [
      /(delete|write|commit|push|execute|run shell|rm -rf)/i,
      /删除|写入|提交|推送|执行命令/i
    ]
  },
  repository: {
    prompt_injection: [
      /(ignore previous|disregard (all )?(previous|system)|reveal the (system|developer) prompt|show the system prompt)/i,
      /(ignore|bypass|override).{0,40}(system|developer|instruction|rules|previous)/i,
      /(reveal|show|print|dump|leak).{0,40}(system|developer).{0,20}(prompt|message|instruction)/i,
      /jailbreak/i,
      /泄露|忽略.{0,20}(系统|指令|规则)/i
    ]
  },
  output: {
    require_citations: true,
    redact_sensitive_values: true,
    flag_overconfidence_without_citations: true
  }
});

export function safetyPolicySummary() {
  return {
    version: SAFETY_POLICY.version,
    input_rules: Object.fromEntries(Object.entries(SAFETY_POLICY.input).map(([key, rules]) => [key, rules.length])),
    repository_rules: Object.fromEntries(Object.entries(SAFETY_POLICY.repository).map(([key, rules]) => [key, rules.length])),
    output: SAFETY_POLICY.output
  };
}

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

// ── Cross-cutting, dependency-free helpers ──
// These two are used pervasively by lib/store.js, lib/memory-db.js and
// lib/checkpoints.js as well as by server.js's own route handlers. Neither
// depends on anything beyond what is already in this file, so centralizing
// them here (rather than duplicating them, or having lib/* import server.js
// and create an import cycle) is the lowest-risk fix for the cross-module
// dependency documented in the refactor report.

export function normalizeUserId(value) {
  const raw = String(value || DEFAULT_USER_ID).trim();
  const safe = raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
  return safe || DEFAULT_USER_ID;
}

export function apiError(message, code = "BAD_REQUEST", status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
