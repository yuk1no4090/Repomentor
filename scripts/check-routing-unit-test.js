import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { decideNextRoute, ROUTE_RULES } from "../lib/agent-graph.js";

/**
 * decideNextRoute() used to have no real unit test: server.js exported nothing,
 * so this script carried its own hand-maintained copy of the routing logic
 * (simulateRoute(), "mirrored from server.js") just to have something to
 * assert against -- it tested a copy, not the real function.
 *
 * lib/agent-graph.js now exports the real decideNextRoute and ROUTE_RULES, and
 * the 13 original scenarios (plus new boundary cases) live as real node:test
 * cases in test/routing.test.js, which is executed for real via
 * scripts/check-unit-tests.js (part of `npm test`). Re-running those same 13
 * cases here too would just be duplicate execution of the same real function
 * against the same inputs, so this script instead does two cheap, non-mirrored
 * checks:
 *   1. The real wiring exists: lib/agent-graph.js exports a decideNextRoute
 *      function and a ROUTE_RULES.phaseMap with the correct 9 phases, checked
 *      by importing and asserting on the actual exported values (no source
 *      text parsing, no simulateRoute copy).
 *   2. test/routing.test.js has not silently lost coverage of the original 13
 *      ported scenarios (a text-presence regression guard, not a logic copy).
 */

assert.equal(typeof decideNextRoute, "function", "lib/agent-graph.js must export a decideNextRoute function");

assert.deepEqual(ROUTE_RULES.phaseMap, [
  "input_safety",
  "memory",
  "classify",
  "retrieve",
  "expand_context",
  "impact_analysis",
  "qa_plan",
  "guardrails",
  "synthesize"
], "ROUTE_RULES.phaseMap must have the 9 expected phases in order");

console.log("[OK] lib/agent-graph.js exports decideNextRoute and a 9-phase ROUTE_RULES.phaseMap.");

const routingTestSource = await readFile("test/routing.test.js", "utf8");

const requiredScenarios = [
  "phase 0 -> input_safety",
  "phase 1 -> memory",
  "phase 2 -> classify",
  "phase 5 -> impact_analysis",
  "phase 6 -> qa_plan (low risk)",
  "phase 8 -> synthesize",
  "phase 9 -> END (__end__)",
  "phase 6 + high risk + HITL enabled -> human_review",
  "phase 6 + high risk + HITL disabled (default) -> qa_plan",
  "post-human_review (high risk) -> synthesize",
  "phase 6 + HITL approve -> synthesize",
  "phase 6 + HITL reject -> synthesize",
  "finalPayload set -> END (__end__), prevents infinite loop"
];

const missingScenarios = requiredScenarios.filter((name) => !routingTestSource.includes(name));
if (missingScenarios.length) {
  console.error(JSON.stringify({ missingScenarios }, null, 2));
  throw new Error("test/routing.test.js is missing coverage for routing scenarios that check-routing-unit-test.js used to test directly via simulateRoute().");
}

console.log(`[OK] test/routing.test.js covers all ${requiredScenarios.length} ported routing scenarios.`);

console.log(JSON.stringify({
  ok: true,
  phaseCount: ROUTE_RULES.phaseMap.length,
  portedScenarios: requiredScenarios.length
}, null, 2));
