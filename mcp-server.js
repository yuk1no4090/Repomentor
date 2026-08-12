#!/usr/bin/env node
// AI PM MCP Server
// -----------------
// A thin stdio-transport MCP proxy in front of the already-running AI PM
// HTTP API (server.js). It intentionally does NOT import lib/store.js or any
// other lib/ module directly: the store is a single-process, in-memory-cache
// + write-lock design, so a second Node process writing to the same
// data/store.json would race the main server and could silently lose writes.
// Going through HTTP instead means every MCP tool call reuses the same
// guardrails (safety scans, harness recording, auth) as the web UI.
//
// Requires the main server to already be running (`npm start` / `npm run
// dev`). On startup this process probes GET /api/health once; if the API is
// unreachable it prints an actionable error to stderr and exits non-zero
// instead of silently registering tools that can never succeed.
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
).version || "0.0.0";

const BASE_URL = String(process.env.AI_PM_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const API_TOKEN = process.env.AI_PM_API_TOKEN || "";
const DEFAULT_PROJECT_ID = process.env.AI_PM_PROJECT_ID || "";
const HEALTH_PROBE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 45_000;

// ── HTTP client against the local AI PM API ──

async function apiRequest(pathname, { method = "GET", body, searchParams } = {}) {
  const url = new URL(pathname, `${BASE_URL}/`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  }
  const headers = { "content-type": "application/json" };
  if (API_TOKEN) headers.authorization = `Bearer ${API_TOKEN}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    const reason = error.name === "AbortError" ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : error.message;
    const wrapped = new Error(`Could not reach the AI PM API at ${url}: ${reason}`);
    wrapped.apiUnreachable = true;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const failure = new Error(payload.error || `Request failed with HTTP ${response.status}`);
    failure.status = response.status;
    failure.code = payload.code || "UNKNOWN_ERROR";
    throw failure;
  }
  return payload;
}

async function probeHealth() {
  const url = new URL("/api/health", `${BASE_URL}/`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`API responded with HTTP ${response.status}`);
    return { ok: true };
  } catch (error) {
    const reason = error.name === "AbortError" ? `timed out after ${HEALTH_PROBE_TIMEOUT_MS}ms` : error.message;
    return { ok: false, reason, url: url.toString() };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Response shaping helpers (compact, agent-friendly text) ──

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(error, context) {
  const parts = [`${context} failed: ${error.message}`];
  if (error.status) parts.push(`HTTP status: ${error.status}`);
  if (error.code) parts.push(`error code: ${error.code}`);
  if (error.apiUnreachable) {
    parts.push(`Hint: is the main AI PM server running? Start it with "npm start" (or "npm run dev"), then retry. Current AI_PM_BASE_URL=${BASE_URL}`);
  }
  return { isError: true, content: [{ type: "text", text: parts.join("\n") }] };
}

function resolveProjectId(args) {
  const projectId = String(args?.projectId || args?.project_id || DEFAULT_PROJECT_ID || "").trim();
  if (!projectId) {
    throw new Error("projectId is required (no AI_PM_PROJECT_ID default is configured on this MCP server). Call list_projects first to find a valid id.");
  }
  return projectId;
}

function collectCitations(payload = {}) {
  const files = new Set();
  (payload.related_files || []).forEach((file) => file?.file_path && files.add(file.file_path));
  (payload.impact_areas || []).forEach((area) => (area.files || []).forEach((file) => files.add(file)));
  (payload.trace || []).forEach((step) => (step.citations || []).forEach((file) => files.add(file)));
  return [...files];
}

function formatSafetyLine(payload = {}) {
  const status = payload.safety?.status || "unknown";
  const risks = payload.safety?.risk_types?.length ? ` (risk types: ${payload.safety.risk_types.join(", ")})` : "";
  return `Safety status: ${status}${risks}`;
}

function formatChatAnswer(payload = {}) {
  const lines = [];
  if (payload.answer) {
    lines.push(`Answer: ${payload.answer}`);
    if (payload.key_points?.length) {
      lines.push("", "Key points:");
      payload.key_points.forEach((point) => lines.push(`- ${point}`));
    }
    if (payload.suggested_next_questions?.length) {
      lines.push("", "Suggested follow-up questions:");
      payload.suggested_next_questions.forEach((question) => lines.push(`- ${question}`));
    }
  } else if (payload.summary) {
    lines.push(`Impact summary: ${payload.summary}`);
    if (payload.impact_areas?.length) {
      lines.push("", "Impact areas:");
      payload.impact_areas.forEach((area) => {
        lines.push(`- [${area.risk_level}] ${area.area}: ${(area.files || []).join(", ")} - ${area.reason}`);
      });
    }
    if (payload.testing_suggestions?.length) {
      lines.push("", "Testing suggestions:");
      payload.testing_suggestions.forEach((item) => lines.push(`- ${item}`));
    }
  } else {
    lines.push("No answer payload was returned.");
  }
  const citations = collectCitations(payload);
  lines.push("", `File references (${citations.length}): ${citations.length ? citations.join(", ") : "none"}`);
  if (payload.uncertainty) lines.push("", `Uncertainty: ${payload.uncertainty}`);
  lines.push("", formatSafetyLine(payload));
  lines.push(`Mode: ${payload.llm_used ? "AI-enhanced" : "offline deterministic retrieval"}`);
  if (payload.memory_suggestions?.length) {
    lines.push(`Pending memory suggestions: ${payload.memory_suggestions.length} (confirm via the web UI or POST /api/memory/confirm)`);
  }
  return lines.join("\n");
}

function formatAgentImpact(payload = {}) {
  const lines = [];
  lines.push(`Summary: ${payload.summary || "(no summary returned)"}`);
  const areas = payload.impact_areas || [];
  const overallRisk = areas.some((area) => area.risk_level === "high")
    ? "high"
    : areas.some((area) => area.risk_level === "medium")
      ? "medium"
      : areas.length
        ? "low"
        : "unknown";
  lines.push(`Overall risk level: ${overallRisk}`);
  if (areas.length) {
    lines.push("", "Impacted modules:");
    areas.forEach((area) => {
      lines.push(`- [${area.risk_level}] ${area.area}: ${(area.files || []).join(", ")} - ${area.reason}`);
    });
  }
  if (payload.testing_suggestions?.length) {
    lines.push("", "Testing focus:");
    payload.testing_suggestions.forEach((item) => lines.push(`- ${item}`));
  }
  if (payload.open_questions?.length) {
    lines.push("", "Open questions:");
    payload.open_questions.forEach((item) => lines.push(`- ${item}`));
  }
  const citations = collectCitations(payload);
  lines.push("", `File references (${citations.length}): ${citations.length ? citations.join(", ") : "none"}`);
  if (payload.hitl) {
    lines.push("", `HITL: paused=${payload.hitl.paused} approved=${payload.hitl.approved} rejected=${payload.hitl.rejected}`);
  }
  lines.push("", formatSafetyLine(payload));
  if (payload.harness) {
    lines.push(`Harness: run_id=${payload.harness.run_id} runtime=${payload.harness.runtime} model_mode=${payload.harness.model_mode} steps_executed=${payload.harness.steps_executed} fallback_used=${payload.harness.fallback_used}`);
  }
  if (payload.trace?.length) {
    lines.push("", "Execution trace:");
    payload.trace.forEach((step) => lines.push(`- ${step.step} (${step.tool})`));
  }
  return lines.join("\n");
}

function formatOnboardingPlan(payload = {}) {
  const lines = [];
  lines.push(`Onboarding plan - role: ${payload.role || "unknown"}, duration: ${payload.duration || "unknown"}`);
  if (payload.goal) lines.push(`Goal: ${payload.goal}`);
  (payload.plan || []).forEach((day) => {
    lines.push("", `${day.day} - ${day.focus}`);
    if (day.files_to_read?.length) lines.push(`  Files to read: ${day.files_to_read.join(", ")}`);
    (day.tasks || []).forEach((task) => lines.push(`  - ${task}`));
  });
  const citations = collectCitations(payload);
  lines.push("", `File references (${citations.length}): ${citations.length ? citations.join(", ") : "none"}`);
  lines.push("", formatSafetyLine(payload));
  return lines.join("\n");
}

function formatProjects(projects = []) {
  if (!projects.length) {
    return "No projects have been imported yet. Import one first (sample repository, public GitHub URL, or ZIP upload) via the AI PM web UI or POST /api/import, then call this tool again to get a projectId.";
  }
  return projects
    .map((project) => {
      const stack = project.summary?.techStack?.length ? project.summary.techStack.join(", ") : "unknown stack";
      const overview = project.summary?.overview || "(no summary)";
      return `- id=${project.id}  name="${project.name}"  source=${project.source}  files=${project.fileCount}  chunks=${project.chunkCount}\n  stack: ${stack}\n  overview: ${overview}`;
    })
    .join("\n\n");
}

// ── Tool definitions ──
// Each tool proxies exactly one AI PM API endpoint. Descriptions are written
// for the calling AI agent, not a human reader, so they spell out *when* to
// reach for each tool relative to the others.

const TOOLS = [
  {
    name: "list_projects",
    description:
      "List repositories already imported into this AI PM instance: id, name, import source, file/chunk counts, inferred tech stack, and a one-line overview. Call this first whenever you do not already know a valid projectId, or when the user asks what repositories are available. Maps to GET /api/projects.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    handler: async () => {
      const data = await apiRequest("/api/projects");
      return textResult(formatProjects(data.projects));
    }
  },
  {
    name: "ask_codebase",
    description:
      "Ask a grounded, citation-backed question about one imported repository's code, architecture, or behavior (e.g. \"how does the refund flow work\", \"where is the JWT issued\"). Returns an answer, the specific files it is grounded in, an uncertainty rating, and suggested follow-up questions. Use this to understand existing code. For assessing the blast radius of a proposed CHANGE prefer analyze_impact, which runs a deeper multi-agent workflow with risk levels and test guidance; passing kind=\"impact\" here only runs a lighter, non-agentic impact scan. Maps to POST /api/chat.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project id from list_projects. Optional if the MCP server was started with an AI_PM_PROJECT_ID default."
        },
        question: {
          type: "string",
          description: "Natural-language question about the repository."
        },
        kind: {
          type: "string",
          enum: ["qa", "impact"],
          description: "Optional. \"qa\" (default, auto-detected from the question) for explanatory answers; \"impact\" for a lightweight, non-agentic change-impact scan. For the full multi-agent impact workflow use analyze_impact instead."
        }
      },
      required: ["question"],
      additionalProperties: false
    },
    handler: async (args) => {
      const projectId = resolveProjectId(args);
      const question = String(args?.question || "").trim();
      if (!question) throw new Error("question is required.");
      const body = { projectId, question };
      if (args?.kind) body.kind = args.kind;
      const data = await apiRequest("/api/chat", { method: "POST", body });
      return textResult(formatChatAnswer(data.payload));
    }
  },
  {
    name: "analyze_impact",
    description:
      "Run the full multi-agent LangGraph change-impact workflow for a proposed code change against one imported repository. Returns impacted modules grouped by area with risk levels (low/medium/high), targeted testing suggestions, open questions to resolve before implementing, safety-guardrail status, and an execution trace across the classifier/retriever/impact-analyst/QA-planner/synthesizer agents. Use this before making a non-trivial change, or when asked \"what would break if I changed X\". Maps to POST /api/agent-impact.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project id from list_projects. Optional if the MCP server was started with an AI_PM_PROJECT_ID default."
        },
        question: {
          type: "string",
          description: "Describe the proposed code change, e.g. \"add a discount field to Order\"."
        }
      },
      required: ["question"],
      additionalProperties: false
    },
    handler: async (args) => {
      const projectId = resolveProjectId(args);
      const question = String(args?.question || "").trim();
      if (!question) throw new Error("question is required.");
      const data = await apiRequest("/api/agent-impact", { method: "POST", body: { projectId, question } });
      return textResult(formatAgentImpact(data.payload));
    }
  },
  {
    name: "get_onboarding_plan",
    description:
      "Generate a role-based, day-by-day onboarding reading plan for one imported repository: which files to read each day and concrete tasks. Use this when a user is new to a repository and wants a structured ramp-up plan, e.g. \"give me a 3-day onboarding plan for a backend engineer joining this project\". Maps to POST /api/onboarding.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project id from list_projects. Optional if the MCP server was started with an AI_PM_PROJECT_ID default."
        },
        role: {
          type: "string",
          enum: ["Backend Engineer", "Frontend Engineer", "Product Manager", "QA"],
          description: "Optional, defaults to \"Backend Engineer\"."
        },
        duration: {
          type: "string",
          enum: ["3 days", "5 days"],
          description: "Optional, defaults to \"3 days\"."
        }
      },
      required: [],
      additionalProperties: false
    },
    handler: async (args) => {
      const projectId = resolveProjectId(args);
      const body = { projectId };
      if (args?.role) body.role = args.role;
      if (args?.duration) body.duration = args.duration;
      const data = await apiRequest("/api/onboarding", { method: "POST", body });
      return textResult(formatOnboardingPlan(data.payload));
    }
  }
];
// Note on scope: the AI PM API has no standalone "search/retrieve chunks"
// endpoint - retrieval only happens embedded inside /api/chat and
// /api/agent-impact (see lib/retrieval.js's retrieveChunks(), which is
// invoked from within those two route handlers in server.js, not exposed on
// its own route). So a fifth, retrieval-only tool is intentionally omitted
// here rather than reimplemented against lib/ directly, which would violate
// the "thin HTTP proxy, no direct lib/ access" design of this MCP server.

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

async function main() {
  const health = await probeHealth();
  if (!health.ok) {
    console.error(
      `[ai-pm-mcp] Cannot reach the AI PM API at ${health.url} (${health.reason}).\n` +
      `[ai-pm-mcp] The MCP server is a thin proxy in front of the main AI PM HTTP server and requires it to already be running.\n` +
      `[ai-pm-mcp] Start it first, e.g.:\n` +
      `[ai-pm-mcp]   npm start        # or: npm run dev\n` +
      `[ai-pm-mcp] Then restart this MCP server. If the API runs on a different host/port, set AI_PM_BASE_URL (current value: ${BASE_URL}).`
    );
    process.exit(1);
  }

  const server = new Server(
    { name: "ai-pm-mcp", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      return await tool.handler(args || {});
    } catch (error) {
      return errorResult(error, `Tool "${name}"`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[ai-pm-mcp] Ready. Proxying ${TOOLS.length} tools to ${BASE_URL}.`);
}

main().catch((error) => {
  console.error(`[ai-pm-mcp] Fatal error: ${error.message}`);
  process.exit(1);
});
