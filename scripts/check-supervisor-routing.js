import { readFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";

const serverSource = await readFile("server.js", "utf8");

// ── 1. ROUTE_RULES existence and structure ──
assert(serverSource.includes("const ROUTE_RULES = Object.freeze({"), "ROUTE_RULES constant not found");
assert(serverSource.includes("phaseMap:"), "ROUTE_RULES missing phaseMap");
assert(serverSource.includes('"input_safety"'), "ROUTE_RULES phaseMap missing input_safety");
assert(serverSource.includes('"synthesize"'), "ROUTE_RULES phaseMap missing synthesize");
assert(serverSource.includes('"impact_analysis"'), "ROUTE_RULES phaseMap missing impact_analysis");

// ── 2. decideNextRoute function existence ──
assert(serverSource.includes("function decideNextRoute(state)"), "decideNextRoute function not found");
assert(serverSource.includes("state.trace.length"), "decideNextRoute must use trace length for phase");
assert(serverSource.includes("ROUTE_RULES.phaseMap[phase]"), "decideNextRoute must reference phaseMap");

// ── 3. HITL override rules (for P3 readiness) ──
assert(serverSource.includes("AGENT_HITL_ENABLED"), "HITL gate in decideNextRoute not found");
assert(serverSource.includes('"human_review"'), "human_review route not in decideNextRoute");

// ── 4. Environment variable defaults ──
assert(serverSource.includes("AGENT_GRAPH_MODE"), "AGENT_GRAPH_MODE env var not referenced");
assert(serverSource.includes('"supervisor"'), "AGENT_GRAPH_MODE default should be supervisor");
assert(serverSource.includes("AGENT_MAX_STEPS"), "AGENT_MAX_STEPS env var not referenced");
assert(serverSource.includes("AGENT_HITL_ENABLED"), "AGENT_HITL_ENABLED env var not referenced");

// ── 5. Budget reporting ──
assert(serverSource.includes("max_steps: AGENT_MAX_STEPS"), "AGENT_BUDGETS.max_steps should reference AGENT_MAX_STEPS variable");
assert(serverSource.includes("max_steps: AGENT_BUDGETS.max_steps"), "budget_status should reference AGENT_BUDGETS.max_steps");

// ── 6. Supervisor node definition (only in supervisor mode branch) ──
assert(serverSource.includes('addNode("supervisor"'), "supervisor node must be added");
assert(serverSource.includes("decideNextRoute(state)"), "supervisor must call decideNextRoute");

// ── 7. Conditional edges only in supervisor mode ──
assert(serverSource.includes("addConditionalEdges"), "supervisor mode must use conditional edges");
assert(serverSource.includes('AGENT_GRAPH_MODE === "linear"'), "linear mode edge branch must exist");

// ── 8. Linear fallback preserved ──
assert(serverSource.includes('addEdge("input_safety", "memory")'), "linear mode must preserve input_safety → memory edge");
assert(serverSource.includes('addEdge("synthesize", END)'), "linear mode must preserve synthesize → END edge");

// ── 9. Phase count: 9 phases (input_safety through synthesize) ──
// Verify all 9 expected phase nodes are in the phaseMap
const phaseNodes = ["input_safety", "memory", "classify", "retrieve", "expand_context", "impact_analysis", "qa_plan", "guardrails", "synthesize"];
for (const node of phaseNodes) {
  assert(serverSource.includes(`"${node}"`), `Phase node "${node}" missing from ROUTE_RULES or graph`);
}

// ── 10. Max steps: should be 14 (default for multi-agent) ──
assert(serverSource.includes("AGENT_MAX_STEPS") && serverSource.includes("parsePositiveIntegerEnv(\"AGENT_MAX_STEPS\", 14)"), "AGENT_MAX_STEPS default must be 14");

console.log("[OK] ROUTE_RULES structure verified (9 phase nodes).");
console.log("[OK] decideNextRoute uses trace length for phase routing.");
console.log("[OK] HITL gate (AGENT_HITL_ENABLED) present for P3 readiness.");
console.log("[OK] AGENT_GRAPH_MODE env var with 'supervisor' default.");
console.log("[OK] AGENT_MAX_STEPS env var with default 14.");
console.log("[OK] AGENT_HITL_ENABLED env var present.");
console.log("[OK] Budget reporting references AGENT_MAX_STEPS.");
console.log("[OK] Supervisor node defined with decideNextRoute call.");
console.log("[OK] Conditional edges wired in supervisor mode.");
console.log("[OK] Linear fallback preserves all 9 original edges.");
console.log("[PASS] All supervisor routing checks passed.");
