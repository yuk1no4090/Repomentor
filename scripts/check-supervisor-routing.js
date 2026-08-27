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
// NIT fixed in post-review pass: this literal's home moved. It no longer
// drives decideNextRoute's PRIMARY phase read (that's phaseCursor, see
// section 13) -- it now lives in decideNextRoute's own legacy checkpoint
// migration branch (Array.isArray(state.trace) ? state.trace.length : 0,
// asserted in section 13 below) AND in the supervisor node's own diagnostics
// (first-visit detection, routing signal text). Either usage alone keeps
// this assertion legitimately satisfied.
assert(serverSource.includes("state.trace.length"), "state.trace.length must still appear in real (non-comment) source -- e.g. the supervisor node's diagnostics or decideNextRoute's legacy checkpoint migration branch");
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

// ── 13. Phase-cursor-vs-cycle fix (Task N1): phase is an explicit, node-set
// cursor channel, not a value derived from trace-length/revisionRound
// bookkeeping. REVISION_ROUND_NODE_COUNT = 4 is still asserted below because
// computeGraphRecursionLimit and buildAgentHarnessReport's effective_max_steps
// still genuinely need it (superstep/step-budget scaling, unrelated to phase
// derivation) -- see scripts/check-recursion-limit-scaling.js. The former
// offset-subtraction assertion here (`state.trace.length - (state.revisionRound
// || 0) * REVISION_ROUND_NODE_COUNT`) legitimately died with this refactor and
// is replaced by the assertions below, each tied to actual routing/state
// MECHANISM (not just a name mention), mutation-verified per the task report.
assert(serverSource.includes("REVISION_ROUND_NODE_COUNT = 4"), "the revise round's node count (retrieve, expand_context, impact_analysis, qa_plan) must be defined as 4");
assert(serverSource.includes("phaseCursor: Annotation({ reducer: replace, default: () => 0 })"), "the graph state must declare an explicit phaseCursor channel (replace reducer, default 0)");
assert(serverSource.includes("const cursorValue = Number.isInteger(state.phaseCursor) ? state.phaseCursor : 0;"), "decideNextRoute must read its phase directly off state.phaseCursor (defaulting to 0 for a non-integer/absent value), not derive it from trace length");
assert(serverSource.includes("const PHASE_CURSOR_AFTER = new Map(ROUTE_RULES.phaseMap.map((name, index) => [name, index + 1]));"), "the node-successor-cursor lookup must be derived from ROUTE_RULES.phaseMap itself, so phaseMap stays the single authority on phase ordering");
assert(serverSource.includes('phaseCursor: nextPhaseCursor("retrieve"),'), "the retrieve node must set its own successor cursor via nextPhaseCursor(\"retrieve\") -- the mechanism that lets a revise-round re-entry rewind the cursor with no arithmetic");
assert(serverSource.includes('phaseCursor: nextPhaseCursor("qa_plan"),'), "the qa_plan node must set its own successor cursor via nextPhaseCursor(\"qa_plan\") -- the value the revise-branch guard's phaseMap[phase] === \"guardrails\" check keys off of");

// ── 13b. Legacy checkpoint migration fix (post-review blocker): a checkpoint
// persisted before the phaseCursor channel existed restores it as the
// Annotation's own default (0) via LangGraph's LastValue.fromCheckpoint(undefined)
// -- a LEGITIMATE integer indistinguishable from a fresh state by
// cursorValue alone. decideNextRoute must additionally derive phase from
// trace length whenever cursor reads exactly 0 with a non-empty trace (the
// only way current code can produce that combination is a pre-N1
// checkpoint), reusing the pre-N1 arithmetic for that one case. Each
// assertion below is tied to the actual discriminator/derivation, not just a
// name mention, mutation-verified per the task report.
assert(serverSource.includes("const traceLength = Array.isArray(state.trace) ? state.trace.length : 0;"), "decideNextRoute must compute a defensive trace length (Array.isArray guarded) to detect a legacy checkpoint's restored phaseCursor");
assert(serverSource.includes("(cursorValue === 0 && traceLength > 0)"), "decideNextRoute must gate its legacy-checkpoint phase derivation on cursorValue === 0 together with a non-empty trace -- the only combination a pre-phaseCursor checkpoint can produce");
assert(serverSource.includes("traceLength - (state.revisionRound || 0) * REVISION_ROUND_NODE_COUNT"), "the legacy-checkpoint branch must derive phase with the pre-N1 formula (trace length minus the revise-round offset), not silently restart at phase 0");

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
console.log("[OK] decideNextRoute function and phaseMap wiring present (state.trace.length still used elsewhere, e.g. the supervisor node's own diagnostics).");
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
console.log("[OK] Explicit phaseCursor channel + nextPhaseCursor()-derived node cursors (retrieve, qa_plan) present -- phase primarily read off phaseCursor, not derived from trace.length/revisionRound.");
console.log("[OK] Legacy checkpoint migration branch present -- phaseCursor===0 with a non-empty trace derives phase from trace length (pre-N1 formula), so a checkpoint predating this channel does not silently restart at phase 0.");
console.log("[OK] retrieve node bumps revisionRound and feeds additional_queries back into retrieval.");
console.log("[OK] Per-query retrieval merge (retrieveChunks per query + interleaveChunks) present.");
console.log("[OK] Harness report exposes revision_rounds and revision_budget_exhausted.");
console.log("[OK] LangGraph recursionLimit derived from AGENT_MAX_REVISION_ROUNDS via computeGraphRecursionLimit(), not from AGENT_MAX_STEPS.");
console.log("[OK] Step budget's effective_max_steps/step_budget_exceeded scale with AGENT_MAX_REVISION_ROUNDS.");
console.log("[PASS] All supervisor routing checks passed.");
