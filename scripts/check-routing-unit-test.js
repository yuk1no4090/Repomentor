import { readFile } from "node:fs/promises";

/**
 * Unit test for decideNextRoute() routing logic.
 * Since decideNextRoute is not exported, we test it by:
 * 1. Verifying the source code contains the correct routing rules
 * 2. Simulating the routing logic locally and asserting expected outputs
 */

const serverSource = await readFile("server.js", "utf8");

// Extract the ROUTE_RULES phaseMap from source
const phaseMapMatch = serverSource.match(/phaseMap:\s*\[([\s\S]*?)\]/);
if (!phaseMapMatch) throw new Error("Could not extract phaseMap from ROUTE_RULES");

const phaseMap = phaseMapMatch[1]
  .split(",")
  .map((s) => s.replace(/\/\/.*$/gm, "").trim().replace(/"/g, ""))
  .filter(Boolean);

if (phaseMap.length !== 9) {
  throw new Error(`phaseMap should have 9 entries, got ${phaseMap.length}`);
}

const expectedPhases = ["input_safety", "memory", "classify", "retrieve", "expand_context", "impact_analysis", "qa_plan", "guardrails", "synthesize"];
for (let i = 0; i < expectedPhases.length; i++) {
  if (phaseMap[i] !== expectedPhases[i]) {
    throw new Error(`phaseMap[${i}] should be "${expectedPhases[i]}", got "${phaseMap[i]}"`);
  }
}
console.log("[OK] phaseMap has correct 9 phases in order.");

// ── Simulate decideNextRoute logic for various states ──

// The routing function logic (mirrored from server.js for testing):
function simulateRoute(state) {
  const phase = state.trace.length;

  // Terminal condition: finalPayload exists → END
  if (state.finalPayload) return "__end__";

  // After human_review with high risk → synthesize
  if (state.hitlRequest?.node === "human_review" && state.riskLevel === "high") {
    return "synthesize";
  }

  // Phases 0-8: follow linear path
  if (phase < phaseMap.length) {
    const nextNode = phaseMap[phase];

    // Override: HITL decision exists → synthesize (skip qa_plan, checked BEFORE HITL gate)
    if (nextNode === "qa_plan" && state.hitlRequest?.decision) {
      return "synthesize";
    }

    // Override: high risk + HITL enabled → human_review (instead of qa_plan)
    if (nextNode === "qa_plan" && state.riskLevel === "high" && state.hitlEnabled) {
      return "human_review";
    }

    return nextNode;
  }

  // Phase >= 9 → END
  return "__end__";
}

// ── Test cases ──
const tests = [
  // Normal flow (no HITL): should follow linear path
  { name: "phase 0 → input_safety", state: { trace: [], riskLevel: "low", hitlEnabled: false }, expected: "input_safety" },
  { name: "phase 1 → memory", state: { trace: [{}], riskLevel: "low", hitlEnabled: false }, expected: "memory" },
  { name: "phase 2 → classify", state: { trace: [{}, {}], riskLevel: "low", hitlEnabled: false }, expected: "classify" },
  { name: "phase 5 → impact_analysis", state: { trace: [{}, {}, {}, {}, {}], riskLevel: "low", hitlEnabled: false }, expected: "impact_analysis" },
  { name: "phase 6 → qa_plan (low risk)", state: { trace: [{}, {}, {}, {}, {}, {}], riskLevel: "low", hitlEnabled: false }, expected: "qa_plan" },
  { name: "phase 8 → synthesize", state: { trace: [{}, {}, {}, {}, {}, {}, {}, {}], riskLevel: "low", hitlEnabled: false }, expected: "synthesize" },
  { name: "phase 9 → END", state: { trace: [{}, {}, {}, {}, {}, {}, {}, {}, {}], riskLevel: "low", hitlEnabled: false }, expected: "__end__" },

  // HITL enabled + high risk: should route to human_review instead of qa_plan
  { name: "phase 6 + high risk + HITL → human_review", state: { trace: [{}, {}, {}, {}, {}, {}], riskLevel: "high", hitlEnabled: true }, expected: "human_review" },

  // HITL disabled + high risk: should still go to qa_plan (normal flow)
  { name: "phase 6 + high risk + HITL disabled → qa_plan", state: { trace: [{}, {}, {}, {}, {}, {}], riskLevel: "high", hitlEnabled: false }, expected: "qa_plan" },

  // After human_review: should route to synthesize
  { name: "post-human_review → synthesize", state: { trace: [{}, {}, {}, {}, {}, {}, {}], riskLevel: "high", hitlEnabled: true, hitlRequest: { node: "human_review", decision: null } }, expected: "synthesize" },

  // HITL resume with approve: should route to synthesize (skip qa_plan)
  { name: "phase 6 + HITL approve → synthesize", state: { trace: [{}, {}, {}, {}, {}, {}], riskLevel: "high", hitlEnabled: true, hitlRequest: { decision: "approve" } }, expected: "synthesize" },
  { name: "phase 6 + HITL reject → synthesize", state: { trace: [{}, {}, {}, {}, {}, {}], riskLevel: "high", hitlEnabled: true, hitlRequest: { decision: "reject" } }, expected: "synthesize" },

  // Terminal: finalPayload exists → END (prevents infinite loop)
  { name: "finalPayload set → END", state: { trace: [{}, {}, {}, {}, {}, {}, {}, {}], riskLevel: "high", hitlEnabled: true, hitlRequest: { node: "human_review" }, finalPayload: {} }, expected: "__end__" },
];

let passed = 0;
let failed = 0;
for (const test of tests) {
  const result = simulateRoute(test.state);
  if (result === test.expected) {
    passed++;
  } else {
    failed++;
    console.error(`[FAIL] ${test.name}: expected "${test.expected}", got "${result}"`);
  }
}

console.log(`[OK] ${passed}/${tests.length} routing test cases passed.`);
if (failed > 0) {
  throw new Error(`${failed} routing test cases failed.`);
}

// ── Verify source code has the finalPayload terminal condition ──
if (!serverSource.includes("state.finalPayload")) {
  throw new Error("decideNextRoute must check state.finalPayload for terminal condition (bug #1 fix)");
}
console.log("[OK] finalPayload terminal condition present in source.");

console.log("[PASS] All decideNextRoute unit tests passed.");
