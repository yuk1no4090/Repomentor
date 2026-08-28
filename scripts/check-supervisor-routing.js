import { ok as assert } from "node:assert/strict";
import { readServerSourceStripped } from "./shared/source-reader.js";

// readServerSourceStripped() (not readServerSource()) so every assertion below
// can only be satisfied by real, executable code. A comment that happens to
// mention the same literal (e.g. a docstring quoting `state.trace.length`) is
// stripped out first and can no longer make an assertion pass vacuously.
const serverSource = await readServerSourceStripped();

// SLIM-A consolidation note: this file used to also pin ROUTE_RULES's
// structure, decideNextRoute's existence/phaseMap lookup, the HITL gate, the
// supervisor node's addNode/decideNextRoute call site, addConditionalEdges,
// the 9 phase node names, the revise-branch guard (verdict/budget/target),
// the phaseCursor Annotation channel + nextPhaseCursor() call sites, the
// legacy-checkpoint migration formula, the retrieve node's revisionRound bump
// + additional_queries feed, the per-query retrieval merge, and the harness's
// revision_rounds/revision_budget_exhausted fields. All of that is now proven
// -- more strongly, through the real call path -- by:
//   - test/routing.test.js: calls the real exported ROUTE_RULES,
//     decideNextRoute(), nextPhaseCursor() directly, including a dedicated
//     "legacy checkpoint migration" describe block (phaseCursor===0 with a
//     non-empty trace) and a "QACritic revise loop" describe block (verdict
//     check + AGENT_MAX_REVISION_ROUNDS budget + retrieve loop target).
//   - check-hitl-resume-behavior.js's real "phase-cursor-migration-regression"
//     probe: strips phaseCursor from an actual persisted checkpoint and
//     proves resuming it does not silently re-run already-completed phases.
//   - check-revise-loop.js, check-recursion-limit-scaling.js,
//     check-hitl-safety-trigger.js, check-hitl-supervisor-trigger.js,
//     check-revise-hitl-cross.js, check-agent-impact-stream.js (all
//     behavioral/spawn-based, untouchable): run the real 9-phase graph
//     end-to-end -- including multi-round revise loops with real
//     additional_queries feeding real retrieval, and real harness reports
//     exposing revision_rounds/revision_budget_exhausted -- across dozens of
//     scenarios. None of that can happen unless the supervisor node's
//     decideNextRoute() call site, addConditionalEdges wiring, the
//     phaseCursor channel, and the retrieve/qa_plan node cursor call sites
//     are all correctly wired end-to-end.
//   - test/retrieval.test.js: calls the real retrieveChunks() directly.
//
// What's left below are the assertions no unit test or behavioral run
// currently proves: AGENT_GRAPH_MODE=linear's own graph-building branch
// (no behavioral check ever actually RUNS a workflow in linear mode --
// check-linear-mode-startup-warning.js only inspects the startup warning
// text, never calls /api/agent-impact under AGENT_GRAPH_MODE=linear), the
// exact numeric defaults for AGENT_MAX_STEPS (14) and AGENT_BUDGETS'
// max_revision_rounds surfacing (nothing reads these fields for an exact-value
// comparison, only `>=` bounds), and computeGraphRecursionLimit's
// recursionLimit actually being PASSED to graph.invoke() (a unit test of the
// formula in isolation cannot prove the real invoke() call uses it).

// ── AGENT_GRAPH_MODE / linear-mode fallback (no behavioral coverage exists
// for actually running a workflow in linear mode -- see note above) ──
assert(serverSource.includes("AGENT_GRAPH_MODE"), "AGENT_GRAPH_MODE env var not referenced");
assert(serverSource.includes('AGENT_GRAPH_MODE === "linear"'), "linear mode edge branch must exist");
assert(serverSource.includes('addEdge("input_safety", "memory")'), "linear mode must preserve input_safety → memory edge");
assert(serverSource.includes('addEdge("synthesize", END)'), "linear mode must preserve synthesize → END edge");

// ── Exact numeric defaults nothing asserts with equality elsewhere (only
// `>=` bounds in behavioral checks, which would also pass for a larger
// default) ──
assert(serverSource.includes("AGENT_MAX_STEPS"), "AGENT_MAX_STEPS env var not referenced");
assert(serverSource.includes("parsePositiveIntegerEnv(\"AGENT_MAX_STEPS\", 14)"), "AGENT_MAX_STEPS default must be 14");
assert(serverSource.includes("max_revision_rounds: AGENT_MAX_REVISION_ROUNDS"), "AGENT_BUDGETS must surface max_revision_rounds alongside max_steps (no behavioral check reads this field)");

// ── Revise-round node-count constant, still needed by the two sections below
// (superstep/step-budget scaling) even though the phaseCursor mechanism
// itself is now proven via routing.test.js + the behavioral revise-loop
// checks ──
assert(serverSource.includes("REVISION_ROUND_NODE_COUNT = 4"), "the revise round's node count (retrieve, expand_context, impact_analysis, qa_plan) must be defined as 4");

// ── LangGraph's own recursionLimit must scale with AGENT_MAX_REVISION_ROUNDS
// -- CAREFUL EXCEPTION: a unit test of computeGraphRecursionLimit() in
// isolation cannot prove graph.invoke() actually uses its return value. ──
assert(serverSource.includes("function computeGraphRecursionLimit(maxRevisionRounds)"), "computeGraphRecursionLimit must be defined as a function of maxRevisionRounds, not AGENT_MAX_STEPS");
assert(serverSource.includes("GRAPH_REVISE_ROUND_SUPERSTEPS * rounds"), "computeGraphRecursionLimit must scale its result by the configured revision-round count");
assert(serverSource.includes("recursionLimit: computeGraphRecursionLimit(AGENT_MAX_REVISION_ROUNDS)"), "graph.invoke() must derive recursionLimit from AGENT_MAX_REVISION_ROUNDS via computeGraphRecursionLimit()");
assert(!serverSource.includes("recursionLimit: Math.max(25, AGENT_BUDGETS.max_steps"), "recursionLimit must not be derived from AGENT_MAX_STEPS -- it has no relationship to LangGraph's own superstep count");

// ── Step budget must scale with AGENT_MAX_REVISION_ROUNDS -- no behavioral
// check asserts the exact effectiveMaxSteps formula (only that a healthy run
// is not flagged step_budget_exceeded, which a more generous formula would
// also satisfy) ──
assert(serverSource.includes("const effectiveMaxSteps = AGENT_BUDGETS.max_steps + REVISION_ROUND_NODE_COUNT * AGENT_MAX_REVISION_ROUNDS;"), "the harness must compute a revision-aware step ceiling");
assert(serverSource.includes("step_budget_exceeded: trace.length > effectiveMaxSteps"), "step_budget_exceeded must compare against the revision-aware effective ceiling, not the raw single-pass AGENT_BUDGETS.max_steps");

console.log("[OK] AGENT_GRAPH_MODE linear-mode fallback graph wiring present (no behavioral run exercises linear mode).");
console.log("[OK] AGENT_MAX_STEPS default (14) and AGENT_BUDGETS.max_revision_rounds surfacing present (no behavioral check reads these with exact-value equality).");
console.log("[OK] LangGraph recursionLimit derived from AGENT_MAX_REVISION_ROUNDS via computeGraphRecursionLimit(), not from AGENT_MAX_STEPS.");
console.log("[OK] Step budget's effective_max_steps/step_budget_exceeded formula scales with AGENT_MAX_REVISION_ROUNDS.");
console.log("[PASS] All supervisor routing checks passed.");
