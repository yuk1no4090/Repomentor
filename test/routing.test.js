import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decideNextRoute, ROUTE_RULES } from "../lib/agent-graph.js";

// Unit tests for the *real* decideNextRoute() exported by lib/agent-graph.js.
// These replace scripts/check-routing-unit-test.js's old simulateRoute(), a
// hand-maintained copy of the routing logic that was needed only because
// server.js used to export nothing. Now that lib/agent-graph.js exports the
// actual function, we import and call it directly instead of re-implementing it.

// decideNextRoute() reads the module-level AGENT_HITL_ENABLED constant from
// lib/config.js, which is computed once (from process.env) the first time the
// module graph is loaded in this process. That happens above, when this file's
// top-level `import` runs — before any test body executes and before we could
// mutate process.env. The "HITL enabled" branch therefore cannot be observed by
// calling the already-imported decideNextRoute in-process. To still exercise the
// real function (not a re-implementation) for that branch, we spawn a short-lived
// child Node process with AGENT_HITL_ENABLED=true set *before* it imports
// lib/agent-graph.js, and read back decideNextRoute()'s real return value.
function decideNextRouteWithHitlEnabled(state) {
  const agentGraphUrl = pathToFileURL(path.resolve("lib/agent-graph.js")).href;
  const script = [
    `import("${agentGraphUrl}").then(({ decideNextRoute }) => {`,
    `  console.log(JSON.stringify({ result: decideNextRoute(${JSON.stringify(state)}) }));`,
    `});`
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, AGENT_HITL_ENABLED: "true" }
  });
  return JSON.parse(output.trim().split(/\r?\n/).at(-1)).result;
}

describe("ROUTE_RULES.phaseMap", () => {
  test("has the 9 expected phases in order", () => {
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
    ]);
  });
});

// ── Ported 1:1 from scripts/check-routing-unit-test.js's 13 simulateRoute() cases ──
describe("decideNextRoute (ported from check-routing-unit-test.js)", () => {
  test("phase 0 -> input_safety", () => {
    assert.equal(decideNextRoute({ trace: [], riskLevel: "low" }), "input_safety");
  });

  test("phase 1 -> memory", () => {
    assert.equal(decideNextRoute({ trace: [{}], riskLevel: "low" }), "memory");
  });

  test("phase 2 -> classify", () => {
    assert.equal(decideNextRoute({ trace: [{}, {}], riskLevel: "low" }), "classify");
  });

  test("phase 5 -> impact_analysis", () => {
    assert.equal(decideNextRoute({ trace: [{}, {}, {}, {}, {}], riskLevel: "low" }), "impact_analysis");
  });

  test("phase 6 -> qa_plan (low risk)", () => {
    assert.equal(decideNextRoute({ trace: [{}, {}, {}, {}, {}, {}], riskLevel: "low" }), "qa_plan");
  });

  test("phase 8 -> synthesize", () => {
    assert.equal(decideNextRoute({ trace: [{}, {}, {}, {}, {}, {}, {}, {}], riskLevel: "low" }), "synthesize");
  });

  test("phase 9 -> END (__end__)", () => {
    assert.equal(decideNextRoute({ trace: [{}, {}, {}, {}, {}, {}, {}, {}, {}], riskLevel: "low" }), "__end__");
  });

  test("phase 8 + high risk + HITL enabled -> human_review after critic and guardrails", () => {
    // Exercises the real AGENT_HITL_ENABLED=true branch via a child process (see
    // decideNextRouteWithHitlEnabled() above for why this can't run in-process).
    const result = decideNextRouteWithHitlEnabled({ trace: [{}, {}, {}, {}, {}, {}, {}, {}], riskLevel: "high" });
    assert.equal(result, "human_review");
  });

  test("phase 6 + high risk + HITL disabled (default) -> qa_plan", () => {
    // AGENT_HITL_ENABLED defaults to false when unset, which is the case for this
    // process, so calling the real function directly already covers "disabled".
    assert.equal(decideNextRoute({ trace: [{}, {}, {}, {}, {}, {}], riskLevel: "high" }), "qa_plan");
  });

  test("post-human_review (high risk) -> synthesize", () => {
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}],
      riskLevel: "high",
      hitlRequest: { node: "human_review", decision: null }
    };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("phase 8 + HITL approve -> synthesize", () => {
    const state = { trace: [{}, {}, {}, {}, {}, {}, {}, {}], riskLevel: "high", hitlRequest: { decision: "approve" } };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("phase 8 + HITL reject -> synthesize", () => {
    const state = { trace: [{}, {}, {}, {}, {}, {}, {}, {}], riskLevel: "high", hitlRequest: { decision: "reject" } };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("finalPayload set -> END (__end__), prevents infinite loop", () => {
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}, {}],
      riskLevel: "high",
      hitlRequest: { node: "human_review" },
      finalPayload: {}
    };
    assert.equal(decideNextRoute(state), "__end__");
  });
});

// ── Additional boundary cases, based on the real function's observed behavior ──
describe("decideNextRoute boundary cases", () => {
  test("phase far beyond phaseMap length -> END (__end__)", () => {
    const state = { trace: new Array(20).fill({}), riskLevel: "low" };
    assert.equal(decideNextRoute(state), "__end__");
  });

  test("state without a trace array throws (trace.length is read unconditionally, before the finalPayload check)", () => {
    // decideNextRoute computes `state.trace.length` as its very first statement,
    // ahead of the state.finalPayload terminal check, so a state without `trace`
    // throws even when finalPayload is already set.
    assert.throws(() => decideNextRoute({ finalPayload: {} }), TypeError);
    assert.throws(() => decideNextRoute({}), TypeError);
  });

  test("hitlRequest.node === 'human_review' with riskLevel != 'high' does not short-circuit to synthesize", () => {
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}],
      riskLevel: "low",
      hitlRequest: { node: "human_review", decision: null }
    };
    // Falls through to the normal phaseMap lookup for phase 7 instead.
    assert.equal(decideNextRoute(state), "guardrails");
  });

  test("hitlRequest.decision does not skip unfinished specialist phases", () => {
    // A resume decision only bypasses the final HITL gate. Earlier classifier,
    // retrieval, analyst, and critic work still runs to rebuild current evidence.
    const state = { trace: [{}, {}], riskLevel: "high", hitlRequest: { decision: "approve" } };
    assert.equal(decideNextRoute(state), "classify");
  });

  test("missing riskLevel at the qa_plan phase behaves like a non-high risk level", () => {
    const state = { trace: [{}, {}, {}, {}, {}, {}] };
    assert.equal(decideNextRoute(state), "qa_plan");
  });
});
