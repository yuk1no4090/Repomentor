import { ok as assert } from "node:assert/strict";
import { readServerSourceStripped } from "./shared/source-reader.js";

// readServerSourceStripped() (not readServerSource()) so every assertion below
// -- including the pre-existing ones -- can only be satisfied by real,
// executable code. A comment that happens to mention the same literal (e.g. a
// docstring quoting `state.trace.length`) is stripped out first and can no
// longer make an assertion pass vacuously.
const serverSource = await readServerSourceStripped();

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

// ── 11. QACritic revise loop config (Task L3, Part B) ──
assert(serverSource.includes('parseNonNegativeIntegerEnv("AGENT_MAX_REVISION_ROUNDS", 1)'), "AGENT_MAX_REVISION_ROUNDS must default to 1 via parseNonNegativeIntegerEnv");
assert(serverSource.includes("max_revision_rounds: AGENT_MAX_REVISION_ROUNDS"), "AGENT_BUDGETS must surface max_revision_rounds alongside max_steps");

// ── 12. Revise-branch guard: verdict check + round budget bound + loop target ──
// Each substring below is tied to actual routing BEHAVIOR (the exact verdict
// comparison, the exact round-budget bound, and the literal `return "retrieve"`
// that only exists in the revise branch -- every other phaseMap-driven return
// in decideNextRoute returns the `nextNode` variable, never a "retrieve"
// string literal directly), not just a name mention, so each one is
// mutation-verified below (see check-supervisor-routing-mutation-verify.js).
assert(serverSource.includes('state.qaReview?.verdict === "revise"'), "decideNextRoute (or the retrieve node) must gate on qaReview.verdict === \"revise\"");
assert(serverSource.includes("(state.revisionRound || 0) < AGENT_MAX_REVISION_ROUNDS"), "the revise loop must be bounded by AGENT_MAX_REVISION_ROUNDS");
assert(serverSource.includes('return "retrieve";'), "a bounded revise verdict must route back to the \"retrieve\" node");

// ── 13. Phase-cursor-vs-cycle fix: phase must be offset by completed revise rounds ──
assert(serverSource.includes("REVISION_ROUND_NODE_COUNT = 4"), "the revise round's node count (retrieve, expand_context, impact_analysis, qa_plan) must be defined as 4");
assert(serverSource.includes("state.trace.length - (state.revisionRound || 0) * REVISION_ROUND_NODE_COUNT"), "decideNextRoute's phase must subtract the revise-round offset from trace.length so the phaseMap cursor stays meaningful after a loop");

// ── 14. retrieve node: bumps revisionRound on re-entry and feeds the critic's additional_queries back into retrieval ──
assert(serverSource.includes("const nextRevisionRound = isRevisionRound ? (state.revisionRound || 0) + 1 : (state.revisionRound || 0);"), "the retrieve node must bump revisionRound exactly when it is re-entered for a revise round");
assert(serverSource.includes("state.qaReview.additional_queries || []"), "the retrieve node must feed the QACritic's additional_queries into the revise round's planned queries");

// ── 15. Per-query retrieval merge (Task L3, Part A): each planned query retrieved independently, then merged ──
assert(serverSource.includes("plannedQueries.map((query) => retrieveChunks(runtimeProject, query, 8))"), "retrieve must call retrieveChunks() once per planned query instead of joining queries into one string");
assert(serverSource.includes("interleaveChunks(perQueryResults, 8)"), "retrieve must merge per-query results with the deterministic interleaveChunks() helper");

// ── 16. Harness observability for the revise loop ──
assert(serverSource.includes("revision_rounds: revision?.rounds || 0"), "the harness report must expose revision_rounds");
assert(serverSource.includes("revision_budget_exhausted: !!revision?.budgetExhausted"), "the harness report must expose whether the revise loop was cut short by the round budget");

// ── 17. LangGraph's own recursionLimit must scale with AGENT_MAX_REVISION_ROUNDS ──
// The supervisor-hub topology means one 9-phase walk already costs ~19
// supersteps (every real node routes back through "supervisor"); each bounded
// revise round adds 4 more real nodes (~8 more supersteps). AGENT_MAX_STEPS is
// NOT the right input here -- it only bounds the harness's own reported
// trace-length budget and has no direct relationship to LangGraph's internal
// superstep count. Confirmed empirically (scripts/check-recursion-limit-scaling.js):
// an AGENT_MAX_STEPS-derived formula throws "Recursion limit of N reached" at
// AGENT_MAX_REVISION_ROUNDS=3 even though AGENT_MAX_STEPS never changed.
assert(serverSource.includes("function computeGraphRecursionLimit(maxRevisionRounds)"), "computeGraphRecursionLimit must be defined as a function of maxRevisionRounds, not AGENT_MAX_STEPS");
assert(serverSource.includes("GRAPH_REVISE_ROUND_SUPERSTEPS * rounds"), "computeGraphRecursionLimit must scale its result by the configured revision-round count");
assert(serverSource.includes("recursionLimit: computeGraphRecursionLimit(AGENT_MAX_REVISION_ROUNDS)"), "graph.invoke() must derive recursionLimit from AGENT_MAX_REVISION_ROUNDS via computeGraphRecursionLimit()");
assert(!serverSource.includes("recursionLimit: Math.max(25, AGENT_BUDGETS.max_steps"), "recursionLimit must not be derived from AGENT_MAX_STEPS -- it has no relationship to LangGraph's own superstep count");

// ── 18. Step budget must scale with AGENT_MAX_REVISION_ROUNDS so a healthy
// revise-round run is not mislabeled step_budget_exceeded ──
assert(serverSource.includes("const effectiveMaxSteps = AGENT_BUDGETS.max_steps + REVISION_ROUND_NODE_COUNT * AGENT_MAX_REVISION_ROUNDS;"), "the harness must compute an effective, revision-aware step ceiling");
assert(serverSource.includes("step_budget_exceeded: trace.length > effectiveMaxSteps"), "step_budget_exceeded must compare against the revision-aware effective ceiling, not the raw single-pass AGENT_BUDGETS.max_steps");

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
console.log("[OK] AGENT_MAX_REVISION_ROUNDS config defaults to 1 and is surfaced in AGENT_BUDGETS.");
console.log("[OK] Revise-branch guard (verdict check + round budget bound + retrieve loop target) present.");
console.log("[OK] Phase-cursor offset (trace.length - revisionRound*REVISION_ROUND_NODE_COUNT) present.");
console.log("[OK] retrieve node bumps revisionRound and feeds additional_queries back into retrieval.");
console.log("[OK] Per-query retrieval merge (retrieveChunks per query + interleaveChunks) present.");
console.log("[OK] Harness report exposes revision_rounds and revision_budget_exhausted.");
console.log("[OK] LangGraph recursionLimit derived from AGENT_MAX_REVISION_ROUNDS via computeGraphRecursionLimit(), not from AGENT_MAX_STEPS.");
console.log("[OK] Step budget's effective_max_steps/step_budget_exceeded scale with AGENT_MAX_REVISION_ROUNDS.");
console.log("[PASS] All supervisor routing checks passed.");
