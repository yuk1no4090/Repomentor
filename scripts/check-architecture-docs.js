import { readFile } from "node:fs/promises";

const [doc, prd, userGuide] = await Promise.all([
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8"),
  readFile("docs/PRD.md", "utf8"),
  readFile("docs/USER_GUIDE.md", "utf8")
]);
const readme = await readFile("README.md", "utf8");

const requiredSections = [
  "## Scope",
  "## Graph Nodes",
  "## Memory Boundary",
  "## Auth Boundary",
  "## modelAdapter",
  "## agentHarness",
  "## Tool Policy",
  "## AI Safety Boundary",
  "## Non-Goals",
  "## Verification Gates"
];

const requiredTerms = [
  "LangGraph `StateGraph`",
  "userPreferences",
  "userPreferencesByUser",
  "memorySuggestions",
  "Confirmed preference memory is stored in `data/store.json` under `userPreferencesByUser`",
  "Memory suggestions carry `userId` and `projectId`",
  "runModelAdapter()",
  "buildAgentHarnessReport()",
  "withWorkflowTimeout()",
  "LLM_CONTEXT_TOKEN_BUDGET",
  "LLM_CONTEXT_BUDGET_EXCEEDED",
  "estimated prompt tokens",
  "read-only tool registry",
  "Repository content is never promoted into system instructions",
  "fake OpenAI-compatible schema failure",
  "valid schema with nonexistent citation",
  "valid schema with uncited impact area",
  "Selective forget clears one preference key",
  "Unsafe input does not create new memory suggestions",
  "Suggestion records are normalized on store load/save",
  "Confirmed preferences are applied to both impact analysis and ordinary Q&A",
  "Only pending suggestions can be confirmed or ignored",
  "Confirm and forget requests are user-scoped",
  "Confirm and forget requests may include `projectId`",
  "the suggestion must belong to that project",
  "Unknown preference keys are rejected instead of falling back to full memory deletion",
  "Memory API errors return `{ error, code }`",
  "token-bound user identity",
  "AUTH_USER_MISMATCH",
  "MEMORY_SUGGESTION_NOT_PENDING",
  "MEMORY_PROJECT_MISMATCH",
  "MEMORY_USER_MISMATCH",
  "UNKNOWN_MEMORY_PREFERENCE_KEY"
];

const missingSections = requiredSections.filter((section) => !doc.includes(section));
const missingTerms = requiredTerms.filter((term) => !doc.includes(term));
const readmeMissing = readme.includes("docs/AGENT_RUNTIME_ARCHITECTURE.md")
  ? []
  : ["README link to docs/AGENT_RUNTIME_ARCHITECTURE.md"];
const stalePrdTerms = [
  "当前 single-agent workflow 升级为 LangGraph",
  '"pattern": "single-agent tool workflow"'
].filter((term) => prd.includes(term));
const requiredUserGuideTerms = [
  "多 Agent 协同工作流",
  "Supervisor",
  "Memory、Harness、Safety",
  "HITL",
  "Agent Roster",
  "handoff",
  "/api/memory",
  "/api/memory/confirm",
  "/api/memory/forget",
  "guardrail hits",
  "memory confirmations",
  "fallback runs"
];
const missingUserGuideTerms = requiredUserGuideTerms.filter((term) => !userGuide.includes(term));
const staleUserGuideTerms = [
  "展示 6 步 Agent",
  "Agent 工作流的 6 步",
  "零依赖",
  "9 节点 LangGraph Agent 工作流",
  "展示 9 节点 LangGraph Agent 工作流"
].filter((term) => userGuide.includes(term));

if (
  missingSections.length
  || missingTerms.length
  || readmeMissing.length
  || stalePrdTerms.length
  || missingUserGuideTerms.length
  || staleUserGuideTerms.length
) {
  console.error(JSON.stringify({
    missingSections,
    missingTerms,
    readmeMissing,
    stalePrdTerms,
    missingUserGuideTerms,
    staleUserGuideTerms
  }, null, 2));
  throw new Error("Architecture documentation contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  sections: requiredSections.length,
  terms: requiredTerms.length
}, null, 2));
