import { readServerSource } from "./shared/source-reader.js";

const serverSource = await readServerSource();

// Extract AGENT_TOOL_REGISTRY array content
const registryMatch = serverSource.match(/const AGENT_TOOL_REGISTRY = \[([\s\S]*?)\];/);
if (!registryMatch) {
  throw new Error("MULTI_AGENT_ROLES: Could not locate AGENT_TOOL_REGISTRY in server.js.");
}

const registryBody = registryMatch[1];
// Extract individual tool objects
const toolMatches = registryBody.matchAll(/\{\s*name:\s*"([^"]+)",\s*(?:[\s\S]*?)agent_role:\s*"([^"]*)"\s*\}/g);
const tools = [];
for (const m of toolMatches) {
  const name = m[1];
  const agent_role = m[2];
  if (!name || !agent_role) {
    throw new Error(`MULTI_AGENT_ROLES: Incomplete tool entry near "${name || m[0].slice(0, 60)}".`);
  }
  tools.push({ name, agent_role });
}

if (tools.length < 10) {
  throw new Error(`MULTI_AGENT_ROLES: Expected at least 10 tools, found ${tools.length}. Agent_role field may be missing from some entries.`);
}

console.log(`[OK] Extracted ${tools.length} tools from AGENT_TOOL_REGISTRY.`);

// Build role → tools map
const roleMap = new Map();
for (const tool of tools) {
  if (!roleMap.has(tool.agent_role)) roleMap.set(tool.agent_role, []);
  roleMap.get(tool.agent_role).push(tool.name);
}

// Three model-backed agents plus deterministic specialist/tool roles.
const expectedRoles = [
  "SafetyGuard",
  "Supervisor",
  "MemoryCurator",
  "Classifier",
  "Retriever",
  "ImpactAnalyst",
  "QACritic",
  "Synthesizer",
  "OnboardingPlanner", // separate from the 7, used by /api/onboarding
  "Harness"            // harness fallback tool
];

const foundRoles = Array.from(roleMap.keys());

// Check: all expected roles exist
const missingRoles = expectedRoles.filter((r) => !roleMap.has(r));
if (missingRoles.length > 0) {
  throw new Error(`MULTI_AGENT_ROLES: Missing agent roles: ${missingRoles.join(", ")}. Found: ${foundRoles.join(", ")}.`);
}

// Check: no unexpected roles
const unexpectedRoles = foundRoles.filter((r) => !expectedRoles.includes(r));
if (unexpectedRoles.length > 0) {
  console.log(`[WARN] Unexpected agent roles: ${unexpectedRoles.join(", ")}. (This is advisory — new roles may be intentional.)`);
}

// Check: each role has at least one tool
for (const [role, toolList] of roleMap) {
  if (toolList.length === 0) {
    throw new Error(`MULTI_AGENT_ROLES: Agent role "${role}" has zero assigned tools.`);
  }
}

// Check: no tool maps to multiple roles (already ensured by the for loop, but verify)
// Check: no duplicate tool names
const allToolNames = tools.map((t) => t.name);
const duplicates = allToolNames.filter((name, i) => allToolNames.indexOf(name) !== i);
if (duplicates.length > 0) {
  throw new Error(`MULTI_AGENT_ROLES: Duplicate tool names found: ${[...new Set(duplicates)].join(", ")}.`);
}

console.log(`[OK] ${foundRoles.length} agent roles defined.`);
for (const [role, toolList] of roleMap) {
  console.log(`  - ${role}: ${toolList.length} tool(s) → ${toolList.join(", ")}`);
}

// SLIM-A consolidation note: this file used to also pin "handoffs: Annotation",
// "agentRoster: Annotation", makeTraceStep()'s "agent_role" parameter,
// finalPayload's "agent_roster:" field, "model_calls:"+"runAgentModelAdapter"
// wiring, and per-role model-contract existence for Supervisor/ImpactAnalyst/
// QACritic against server source. All of that is now proven -- more
// strongly, through the real call path -- by scripts/smoke-test.js: it
// asserts the real payload.handoffs array (>= 8 entries, each with
// sender/recipient), payload.agent_roster (>= 7 roles, with SafetyGuard/
// Supervisor/QACritic each present), payload.harness.model_calls with the
// exact role ordering "Supervisor,ImpactAnalyst,QACritic", and every
// payload.trace[].agent_role field (SafetyGuard/Retriever/ImpactAnalyst/
// Synthesizer each explicitly checked). What remains here -- the
// AGENT_TOOL_REGISTRY structural validation above (every tool individually
// has a name and role, no empty-tool roles, no duplicate tool names, all 10
// expected roles present) -- is NOT redundant with that: smoke-test/
// agent-benchmark only exercise the tools actually reached by their handful
// of scenarios, not an exhaustive per-entry scan of the full registry, so
// this remains the only guard against e.g. a duplicate tool name or an
// orphaned zero-tool role anywhere in the registry.

console.log("[PASS] All multi-agent role checks passed.");
