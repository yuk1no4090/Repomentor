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

// ── Bounded QACritic revise cycle (Task L3, Part B) ──
// After qa_plan (phase 6) runs, the supervisor would normally hand off to
// "guardrails" (phase 7). A verdict="revise" loops back to "retrieve" instead,
// bounded by AGENT_MAX_REVISION_ROUNDS (default 1, unset in this process so the
// default applies) and state.revisionRound (bumped by the "retrieve" node
// itself on re-entry, never by decideNextRoute).
describe("decideNextRoute QACritic revise loop", () => {
  test("verdict=revise at the qa_plan->guardrails transition loops back to retrieve", () => {
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}], // trace.length 7 -> phase 7 -> would be "guardrails"
      riskLevel: "low",
      qaReview: { verdict: "revise", additional_queries: ["dependency callers tests"] }
    };
    assert.equal(decideNextRoute(state), "retrieve");
  });

  test("verdict=revise is ignored once the round budget is exhausted (revisionRound >= AGENT_MAX_REVISION_ROUNDS)", () => {
    // Default AGENT_MAX_REVISION_ROUNDS is 1 in this process (unset env), so a
    // state that already recorded 1 completed round must not loop again, even
    // though the critic is still asking for revision -- this is what proves the
    // loop terminates instead of looping forever.
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}], // trace.length 11, revisionRound 1 -> phase 11-4=7
      riskLevel: "low",
      qaReview: { verdict: "revise", additional_queries: ["dependency callers tests"] },
      revisionRound: 1
    };
    assert.equal(decideNextRoute(state), "guardrails");
  });

  test("verdict=revise cannot preempt the finalPayload -> END guard", () => {
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}],
      riskLevel: "low",
      qaReview: { verdict: "revise", additional_queries: [] },
      finalPayload: {}
    };
    assert.equal(decideNextRoute(state), "__end__");
  });

  test("verdict=revise cannot preempt the post-human_review HITL gate", () => {
    // Same phase position (7) and the same revisable qaReview as the first test
    // above, but hitlRequest.node/riskLevel also satisfy the HITL post-review
    // check, which sits earlier in decideNextRoute and must win.
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}],
      riskLevel: "high",
      hitlRequest: { node: "human_review", decision: null },
      qaReview: { verdict: "revise", additional_queries: ["dependency callers tests"] }
    };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("phase cursor stays correct immediately after the revise round's retrieve re-entry", () => {
    // "retrieve" itself bumps revisionRound to 1 as part of the SAME state
    // update that appends its own trace entry, so by the time supervisor asks
    // for the next route, trace.length (8) and revisionRound (1) already agree:
    // phase = 8 - 1*4 = 4 -> phaseMap[4] = "expand_context", not the raw,
    // un-offset phaseMap[8] = "synthesize".
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}, {}], // trace.length 8
      riskLevel: "low",
      qaReview: { verdict: "revise", additional_queries: [] },
      revisionRound: 1
    };
    assert.equal(decideNextRoute(state), "expand_context");
  });

  test("phase cursor is correct at the end of a completed revise round when the critic now approves", () => {
    const state = {
      trace: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}], // trace.length 11, revisionRound 1 -> phase 7
      riskLevel: "low",
      qaReview: { verdict: "approve" },
      revisionRound: 1
    };
    assert.equal(decideNextRoute(state), "guardrails");
  });

  test("no qaReview at all at the qa_plan->guardrails transition does not trigger the loop", () => {
    // Same phase position (7) as the loopback test above, but qaReview is still
    // the Annotation default (null) -- confirms the revise-branch guard
    // (`state.qaReview?.verdict === "revise"`) never misfires on an absent
    // qaReview, it only fires on an explicit "revise" verdict.
    const state = { trace: [{}, {}, {}, {}, {}, {}, {}], riskLevel: "low" };
    assert.equal(decideNextRoute(state), "guardrails");
  });
});
