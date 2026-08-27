import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decideNextRoute, ROUTE_RULES, nextPhaseCursor, hitlReviewRequired, hitlReviewTriggers } from "../lib/agent-graph.js";

// Unit tests for the *real* decideNextRoute() exported by lib/agent-graph.js.
// These replace scripts/check-routing-unit-test.js's old simulateRoute(), a
// hand-maintained copy of the routing logic that was needed only because
// server.js used to export nothing. Now that lib/agent-graph.js exports the
// actual function, we import and call it directly instead of re-implementing it.

// Task N1: decideNextRoute now reads its phase off an explicit `phaseCursor`
// state channel (set by each ROUTE_RULES.phaseMap node itself, via the
// exported nextPhaseCursor() helper) instead of deriving it from
// `state.trace.length - (state.revisionRound || 0) * REVISION_ROUND_NODE_COUNT`.
// Every fixture below that used to express "phase N" as a trace array of
// length N now expresses it directly as `phaseCursor: N` -- the same value
// the real graph nodes themselves would have set. See the "cursor vs trace
// disagree" test near the bottom for the assertion that proves routing no
// longer depends on trace length at all.

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

// ── nextPhaseCursor(): the single helper every phaseMap node calls with its
// own name to set its own successor cursor. Its correctness is what makes the
// "phaseMap remains the single authority on ordering" design claim true --
// if this helper's index math ever drifted from ROUTE_RULES.phaseMap itself,
// every node-set cursor value would be wrong in lockstep. ──
describe("nextPhaseCursor (node-sets-cursor helper correctness)", () => {
  test("returns each phaseMap node's own index + 1, for every node in order", () => {
    ROUTE_RULES.phaseMap.forEach((name, index) => {
      assert.equal(nextPhaseCursor(name), index + 1, `nextPhaseCursor("${name}") should be ${index + 1}`);
    });
  });

  test("the last phaseMap node's cursor (synthesize -> 9) is out of phaseMap's own range", () => {
    // This is intentional: 9 is not a valid phaseMap index (length 9, so valid
    // indices are 0-8). decideNextRoute's finalPayload guard, not the
    // phaseMap lookup, is what actually catches this state on the next
    // supervisor visit — see the "finalPayload set -> END" scenario below.
    assert.equal(nextPhaseCursor("synthesize"), ROUTE_RULES.phaseMap.length);
  });

  test("throws for a node name that is not in ROUTE_RULES.phaseMap", () => {
    // human_review and supervisor are real graph nodes but deliberately
    // OUTSIDE phaseMap (see lib/agent-graph.js's comment above
    // PHASE_CURSOR_AFTER) -- they must never call this helper.
    assert.throws(() => nextPhaseCursor("human_review"), /is not a ROUTE_RULES\.phaseMap node/);
    assert.throws(() => nextPhaseCursor("supervisor"), /is not a ROUTE_RULES\.phaseMap node/);
    assert.throws(() => nextPhaseCursor("not_a_real_node"), /is not a ROUTE_RULES\.phaseMap node/);
  });
});

// ── Ported 1:1 from scripts/check-routing-unit-test.js's 13 simulateRoute() cases ──
// Titles are pinned verbatim by scripts/check-routing-unit-test.js's own
// requiredScenarios grep; only the state fixtures below changed (trace-length
// arrays -> phaseCursor values) to match the new mechanism. Every fixture
// carries the SAME phaseCursor value a real graph node would have set for the
// equivalent "phase N" the old trace-length fixture represented.
describe("decideNextRoute (ported from check-routing-unit-test.js)", () => {
  test("phase 0 -> input_safety", () => {
    assert.equal(decideNextRoute({ phaseCursor: 0, riskLevel: "low" }), "input_safety");
  });

  test("phase 1 -> memory", () => {
    assert.equal(decideNextRoute({ phaseCursor: 1, riskLevel: "low" }), "memory");
  });

  test("phase 2 -> classify", () => {
    assert.equal(decideNextRoute({ phaseCursor: 2, riskLevel: "low" }), "classify");
  });

  test("phase 5 -> impact_analysis", () => {
    assert.equal(decideNextRoute({ phaseCursor: 5, riskLevel: "low" }), "impact_analysis");
  });

  test("phase 6 -> qa_plan (low risk)", () => {
    assert.equal(decideNextRoute({ phaseCursor: 6, riskLevel: "low" }), "qa_plan");
  });

  test("phase 8 -> synthesize", () => {
    assert.equal(decideNextRoute({ phaseCursor: 8, riskLevel: "low" }), "synthesize");
  });

  test("phase 9 -> END (__end__)", () => {
    assert.equal(decideNextRoute({ phaseCursor: 9, riskLevel: "low" }), "__end__");
  });

  test("phase 8 + high risk + HITL enabled -> human_review after critic and guardrails", () => {
    // Exercises the real AGENT_HITL_ENABLED=true branch via a child process (see
    // decideNextRouteWithHitlEnabled() above for why this can't run in-process).
    const result = decideNextRouteWithHitlEnabled({ phaseCursor: 8, riskLevel: "high" });
    assert.equal(result, "human_review");
  });

  test("phase 6 + high risk + HITL disabled (default) -> qa_plan", () => {
    // AGENT_HITL_ENABLED defaults to false when unset, which is the case for this
    // process, so calling the real function directly already covers "disabled".
    assert.equal(decideNextRoute({ phaseCursor: 6, riskLevel: "high" }), "qa_plan");
  });

  test("post-human_review (high risk) -> synthesize", () => {
    // phaseCursor 8 is what guardrails actually leaves behind (its own
    // nextPhaseCursor("guardrails")) — the value that persists unchanged
    // through human_review's run, since human_review never sets phaseCursor
    // itself. The guard this test exercises is checked BEFORE phase is even
    // read, so this value is realistic, not load-bearing for the assertion.
    const state = {
      phaseCursor: 8,
      riskLevel: "high",
      hitlRequest: { node: "human_review", decision: null }
    };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("phase 8 + HITL approve -> synthesize", () => {
    const state = { phaseCursor: 8, riskLevel: "high", hitlRequest: { decision: "approve" } };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("phase 8 + HITL reject -> synthesize", () => {
    const state = { phaseCursor: 8, riskLevel: "high", hitlRequest: { decision: "reject" } };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("finalPayload set -> END (__end__), prevents infinite loop", () => {
    const state = {
      phaseCursor: 8,
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
    const state = { phaseCursor: 20, riskLevel: "low" };
    assert.equal(decideNextRoute(state), "__end__");
  });

  // ── Contract change (Task N1): the old `state.trace.length` read was the
  // very first statement in decideNextRoute, unconditionally, ahead of even
  // the finalPayload check — so a state without a `trace` array threw a
  // TypeError, even when finalPayload was already set. That was never a
  // deliberate design goal; it was a side effect of computing `phase` eagerly
  // from a field (`trace`) that could be `undefined`.
  //
  // The new phase derivation — `Number.isInteger(state.phaseCursor) ?
  // state.phaseCursor : 0` — cannot throw: a missing/non-integer phaseCursor
  // simply defaults to phase 0, the same default the live Annotation channel
  // itself uses. There is no invariant left to protect by throwing: a
  // hand-built state missing `phaseCursor` is not evidence of a bug the way a
  // missing `trace` array used to be (every real trace-appending node MUST
  // run before decideNextRoute could ever see meaningful phase data under the
  // old mechanism; under the new one, phaseCursor is simply state, with its
  // own independent default). This is a deliberate, documented behavior
  // change, not an oversight — see the task's final report for the full
  // reasoning this comment summarizes.
  test("state without phaseCursor (or trace) no longer throws — defaults to phase 0 instead (contract change from the old state.trace.length read)", () => {
    assert.equal(decideNextRoute({}), "input_safety");
    assert.doesNotThrow(() => decideNextRoute({}));
  });

  test("state without phaseCursor still honors the finalPayload guard (previously unreachable for such a minimal state, since the old trace.length read threw first)", () => {
    assert.equal(decideNextRoute({ finalPayload: {} }), "__end__");
  });

  test("hitlRequest.node === 'human_review' with riskLevel != 'high' does not short-circuit to synthesize", () => {
    const state = {
      phaseCursor: 7,
      riskLevel: "low",
      hitlRequest: { node: "human_review", decision: null }
    };
    // Falls through to the normal phaseMap lookup for phase 7 instead.
    assert.equal(decideNextRoute(state), "guardrails");
  });

  test("hitlRequest.decision does not skip unfinished specialist phases", () => {
    // A resume decision only bypasses the final HITL gate. Earlier classifier,
    // retrieval, analyst, and critic work still runs to rebuild current evidence.
    const state = { phaseCursor: 2, riskLevel: "high", hitlRequest: { decision: "approve" } };
    assert.equal(decideNextRoute(state), "classify");
  });

  test("missing riskLevel at the qa_plan phase behaves like a non-high risk level", () => {
    const state = { phaseCursor: 6 };
    assert.equal(decideNextRoute(state), "qa_plan");
  });
});

// ── Bounded QACritic revise cycle (Task L3, Part B) ──
// After qa_plan (phase 6) runs, the supervisor would normally hand off to
// "guardrails" (phase 7). A verdict="revise" loops back to "retrieve" instead,
// bounded by AGENT_MAX_REVISION_ROUNDS (default 1, unset in this process so the
// default applies) and state.revisionRound (bumped by the "retrieve" node
// itself on re-entry, never by decideNextRoute).
//
// Task N1 rewrite: these 7 scenarios used to express "phase after N trace
// steps, offset by completed revise rounds" via hand-built trace arrays whose
// LENGTH encoded the phase. They now set `phaseCursor` directly to whatever
// value the real qa_plan/retrieve node would have set via nextPhaseCursor() —
// the same value regardless of how many times that node has already run,
// which is precisely the "no arithmetic, cursor rewinds itself" property this
// card's refactor introduces.
describe("decideNextRoute QACritic revise loop", () => {
  test("verdict=revise at the qa_plan->guardrails transition loops back to retrieve", () => {
    const state = {
      phaseCursor: nextPhaseCursor("qa_plan"), // 7 -> would normally be "guardrails"
      riskLevel: "low",
      qaReview: { verdict: "revise", additional_queries: ["dependency callers tests"] }
    };
    assert.equal(decideNextRoute(state), "retrieve");
  });

  test("verdict=revise is ignored once the round budget is exhausted (revisionRound >= AGENT_MAX_REVISION_ROUNDS)", () => {
    // Default AGENT_MAX_REVISION_ROUNDS is 1 in this process (unset env), so a
    // state that already recorded 1 completed round must not loop again, even
    // though the critic is still asking for revision -- this is what proves the
    // loop terminates instead of looping forever. Note that qa_plan's own
    // nextPhaseCursor("qa_plan") value (7) is IDENTICAL whether this is the
    // first pass or a post-revise-round second pass -- there is no offset to
    // recompute, unlike the old trace.length-based derivation.
    const state = {
      phaseCursor: nextPhaseCursor("qa_plan"), // still 7, even on the second pass
      riskLevel: "low",
      qaReview: { verdict: "revise", additional_queries: ["dependency callers tests"] },
      revisionRound: 1
    };
    assert.equal(decideNextRoute(state), "guardrails");
  });

  test("verdict=revise cannot preempt the finalPayload -> END guard", () => {
    const state = {
      phaseCursor: nextPhaseCursor("qa_plan"),
      riskLevel: "low",
      qaReview: { verdict: "revise", additional_queries: [] },
      finalPayload: {}
    };
    assert.equal(decideNextRoute(state), "__end__");
  });

  test("verdict=revise cannot preempt the post-human_review HITL gate (HITL guard independence from cursor)", () => {
    // Same qa_plan-successor cursor (7) and the same revisable qaReview as the
    // first test above, but hitlRequest.node/riskLevel also satisfy the HITL
    // post-review check, which sits earlier in decideNextRoute and must win
    // regardless of what phaseCursor says.
    const state = {
      phaseCursor: nextPhaseCursor("qa_plan"),
      riskLevel: "high",
      hitlRequest: { node: "human_review", decision: null },
      qaReview: { verdict: "revise", additional_queries: ["dependency callers tests"] }
    };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("phase cursor stays correct immediately after the revise round's retrieve re-entry (loopback rewinds cursor)", () => {
    // "retrieve" itself sets phaseCursor to nextPhaseCursor("retrieve") (4) as
    // part of the SAME state update that appends its own trace entry and bumps
    // revisionRound to 1 -- the exact same value it always sets, whether this
    // is the initial pass or a revise-round re-entry. No arithmetic: the
    // cursor "rewinds" simply because retrieve always declares "my successor
    // is expand_context."
    const state = {
      phaseCursor: nextPhaseCursor("retrieve"), // 4
      riskLevel: "low",
      qaReview: { verdict: "revise", additional_queries: [] },
      revisionRound: 1
    };
    assert.equal(decideNextRoute(state), "expand_context");
  });

  test("phase cursor is correct at the end of a completed revise round when the critic now approves (cursor correctness after a loop)", () => {
    const state = {
      phaseCursor: nextPhaseCursor("qa_plan"), // 7, same value regardless of round count
      riskLevel: "low",
      qaReview: { verdict: "approve" },
      revisionRound: 1
    };
    assert.equal(decideNextRoute(state), "guardrails");
  });

  test("no qaReview at all at the qa_plan->guardrails transition does not trigger the loop", () => {
    // Same phase position (qa_plan's successor cursor, 7) as the loopback test
    // above, but qaReview is still the Annotation default (null) -- confirms
    // the revise-branch guard (`state.qaReview?.verdict === "revise"`) never
    // misfires on an absent qaReview, it only fires on an explicit "revise"
    // verdict.
    const state = { phaseCursor: nextPhaseCursor("qa_plan"), riskLevel: "low" };
    assert.equal(decideNextRoute(state), "guardrails");
  });
});

// ── The decoupling proof (Task N1): whenever phaseCursor is a genuine,
// non-zero value, phase routing depends ONLY on phaseCursor, never on
// trace.length, even when the two wildly disagree. A state built by hand (or,
// hypothetically, produced by some future buggy node that appends extra
// trace steps without touching phaseCursor) with a long trace but a small
// phaseCursor must still route by the CURSOR. Under the OLD
// trace-length-derived mechanism, a trace this long (20, with revisionRound
// 0) would have computed phase=20 and routed to END -- completely wrong for a
// workflow that is actually only 3 phases in.
//
// NOTE (post-review blocker fix): this is deliberately qualified to "whenever
// phaseCursor is non-zero." decideNextRoute also has one narrow, intentional
// exception -- the legacy checkpoint migration branch a few tests down, which
// DOES derive phase from trace.length, but ONLY when phaseCursor reads
// exactly 0 with a non-empty trace (a state a checkpoint predating the
// phaseCursor channel produces on restore, never a state current code
// produces mid-run). Both tests below use a non-zero cursor specifically so
// the migration branch never engages, keeping this as a clean proof that a
// non-zero cursor is never overridden by trace length. ──
describe("decideNextRoute phaseCursor/trace decoupling", () => {
  test("a state where trace.length (20) and phaseCursor (3) wildly disagree routes by CURSOR, not trace length", () => {
    const state = {
      phaseCursor: 3,
      trace: new Array(20).fill({}),
      riskLevel: "low"
    };
    assert.equal(decideNextRoute(state), "retrieve"); // phaseMap[3], NOT "__end__"
  });

  test("the inverse: a short trace with a large phaseCursor also routes by CURSOR", () => {
    const state = {
      phaseCursor: 9,
      trace: [{}], // trace.length 1 -- would have been phase 1 ("memory") under the old mechanism
      riskLevel: "low"
    };
    assert.equal(decideNextRoute(state), "__end__");
  });
});

// ── Legacy checkpoint migration (post-review blocker fix): a checkpoint
// persisted BEFORE the phaseCursor channel existed has no `phaseCursor` key
// in its serialized channel_values at all. LangGraph's LastValue channel does
// not restore a missing key as `undefined` -- it seeds from the Annotation's
// own default (0), a LEGITIMATE integer indistinguishable, by value alone,
// from a genuinely fresh state (verified against
// node_modules/@langchain/langgraph/dist/channels/last_value.js and
// reproduced end-to-end in scripts/check-hitl-resume-behavior.js's
// phase-cursor migration step: resuming a real mid-graph checkpoint with
// phaseCursor stripped silently re-ran input_safety/memory/classify/retrieve
// a second time before self-healing). decideNextRoute's fix: cursor === 0
// together with a NON-empty trace can only happen for such a legacy
// checkpoint (every phaseMap node sets cursor >= 1 in the same update that
// appends its own trace step, so cursor === 0 in a state produced by current
// code implies trace is empty) -- derive phase with the pre-N1 formula in
// that one case only. ──
describe("decideNextRoute legacy checkpoint migration (phaseCursor missing from a pre-Task-N1 checkpoint)", () => {
  test("phaseCursor 0 with a 4-entry trace derives phase 4 via the legacy arithmetic -> expand_context", () => {
    const state = {
      phaseCursor: 0,
      trace: [{}, {}, {}, {}],
      revisionRound: 0,
      riskLevel: "low"
    };
    assert.equal(decideNextRoute(state), "expand_context");
  });

  test("phaseCursor 0 with a 12-entry trace and revisionRound 1 derives phase 8 via the round-offset legacy arithmetic -> synthesize", () => {
    // 12 - 1*4 = 8 -> phaseMap[8] = "synthesize"
    const state = {
      phaseCursor: 0,
      trace: new Array(12).fill({}),
      revisionRound: 1,
      riskLevel: "low"
    };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("phaseCursor 0 with an EMPTY trace is a genuinely fresh state, unaffected by the migration branch -> input_safety", () => {
    const state = { phaseCursor: 0, trace: [], riskLevel: "low" };
    assert.equal(decideNextRoute(state), "input_safety");
  });

  test("a non-zero phaseCursor is never overridden by the migration branch, even with a long trace (re-affirms the decoupling proof above)", () => {
    const state = { phaseCursor: 3, trace: new Array(20).fill({}), riskLevel: "low" };
    assert.equal(decideNextRoute(state), "retrieve");
  });
});

// ── Task N2: the Supervisor's require_human_review becomes a second, OR'd
// HITL trigger alongside riskLevel="high" -- see hitlReviewTriggers()/
// hitlReviewRequired() in lib/agent-graph.js for the policy these tests pin.
// hitlReviewRequired()/hitlReviewTriggers() are pure functions of `state`
// (no AGENT_HITL_ENABLED dependency), so they can be exercised directly,
// in-process, unlike decideNextRoute's own HITL-enabled routing branch
// (which still needs decideNextRouteWithHitlEnabled()'s child-process trick
// -- see its own comment above for why).
describe("hitlReviewTriggers / hitlReviewRequired (Task N2 two-signal predicate)", () => {
  test("riskLevel high alone -> triggers ['high_risk'], required", () => {
    const state = { riskLevel: "high" };
    assert.deepEqual(hitlReviewTriggers(state), ["high_risk"]);
    assert.equal(hitlReviewRequired(state), true);
  });

  test("supervisorPlan.require_human_review === true alone (riskLevel medium) -> triggers ['supervisor_flag'], required", () => {
    const state = { riskLevel: "medium", supervisorPlan: { require_human_review: true } };
    assert.deepEqual(hitlReviewTriggers(state), ["supervisor_flag"]);
    assert.equal(hitlReviewRequired(state), true);
  });

  test("both signals -> triggers ['high_risk', 'supervisor_flag'] in that order, required", () => {
    const state = { riskLevel: "high", supervisorPlan: { require_human_review: true } };
    assert.deepEqual(hitlReviewTriggers(state), ["high_risk", "supervisor_flag"]);
    assert.equal(hitlReviewRequired(state), true);
  });

  test("neither signal (low risk, no supervisorPlan) -> no triggers, not required", () => {
    const state = { riskLevel: "low" };
    assert.deepEqual(hitlReviewTriggers(state), []);
    assert.equal(hitlReviewRequired(state), false);
  });

  test("supervisorPlan.require_human_review === 'true' (string, not boolean) does not trigger -- strict === true, not truthiness", () => {
    const state = { riskLevel: "medium", supervisorPlan: { require_human_review: "true" } };
    assert.deepEqual(hitlReviewTriggers(state), []);
    assert.equal(hitlReviewRequired(state), false);
  });

  test("supervisorPlan.require_human_review === 'false' (string, truthy in JS) does not trigger -- guards the exact foreign-value risk the strict check exists for", () => {
    const state = { riskLevel: "medium", supervisorPlan: { require_human_review: "false" } };
    assert.deepEqual(hitlReviewTriggers(state), []);
    assert.equal(hitlReviewRequired(state), false);
  });

  test("missing supervisorPlan entirely does not throw and does not trigger", () => {
    const state = { riskLevel: "medium" };
    assert.doesNotThrow(() => hitlReviewRequired(state));
    assert.equal(hitlReviewRequired(state), false);
  });
});

// ── Task N2: decideNextRoute's phase-lookup reroute, extended to
// hitlReviewRequired(state) (riskLevel="high" OR supervisorPlan
// .require_human_review === true). Every scenario below sits at
// phaseCursor 8 (guardrails' own successor cursor -- the phase-lookup
// resolves nextNode="synthesize" there), the same phase the pre-existing
// "phase 8 + high risk + HITL enabled -> human_review..." case above uses.
describe("decideNextRoute HITL: supervisor require_human_review as a second trigger (Task N2)", () => {
  test("flag true + riskLevel medium + HITL enabled -> reroute to human_review at cursor 8 (the case riskLevel alone could never trigger)", () => {
    const result = decideNextRouteWithHitlEnabled({
      phaseCursor: 8,
      riskLevel: "medium",
      supervisorPlan: { require_human_review: true }
    });
    assert.equal(result, "human_review");
  });

  test("flag true + riskLevel medium + HITL disabled (default) -> synthesize (AGENT_HITL_ENABLED still gates the reroute)", () => {
    const state = { phaseCursor: 8, riskLevel: "medium", supervisorPlan: { require_human_review: true } };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  test("flag true + riskLevel medium + a decision already recorded -> no re-pause, straight to synthesize", () => {
    // Exercises the real HITL-enabled branch to prove `!state.hitlRequest?.decision`
    // (not just AGENT_HITL_ENABLED) is what suppresses the reroute once resumed --
    // if this were still `false` for decision-bearing state, this would loop back
    // to human_review a second time instead of finishing the run.
    const result = decideNextRouteWithHitlEnabled({
      phaseCursor: 8,
      riskLevel: "medium",
      supervisorPlan: { require_human_review: true },
      hitlRequest: { node: "human_review", decision: "approve" }
    });
    assert.equal(result, "synthesize");
  });

  test("flag false + riskLevel medium + HITL enabled -> no pause, synthesize", () => {
    const result = decideNextRouteWithHitlEnabled({
      phaseCursor: 8,
      riskLevel: "medium",
      supervisorPlan: { require_human_review: false }
    });
    assert.equal(result, "synthesize");
  });

  test("supervisorPlan absent + riskLevel medium + HITL enabled -> no pause, synthesize", () => {
    const result = decideNextRouteWithHitlEnabled({ phaseCursor: 8, riskLevel: "medium" });
    assert.equal(result, "synthesize");
  });

  test("flag as string 'true' (not boolean) + riskLevel medium + HITL enabled -> no pause (strict === true, not truthiness) -- proves the routing gate itself, not just the helper in isolation", () => {
    const result = decideNextRouteWithHitlEnabled({
      phaseCursor: 8,
      riskLevel: "medium",
      supervisorPlan: { require_human_review: "true" }
    });
    assert.equal(result, "synthesize");
  });

  // ── Post-resume routing for a supervisor-triggered (non-high-risk) pause ──
  // Proves the analysis behind the decision to leave decideNextRoute's
  // post-human_review short-circuit (`hitlRequest.node === "human_review" &&
  // riskLevel === "high"`) UNEXTENDED (see its own comment in
  // lib/agent-graph.js for the full reasoning): a supervisor-triggered pause
  // with riskLevel="medium" does NOT satisfy that short-circuit's own
  // condition (riskLevel is not "high"), so this state falls through past it
  // to the revise-branch check (skipped: phaseMap[8] is "synthesize", not
  // "guardrails") and then the ordinary phase-lookup. There, nextNode is
  // "synthesize" and `!state.hitlRequest?.decision` is false (a decision IS
  // present), so the HITL-reroute condition is false regardless of
  // hitlReviewRequired(state) -- the lookup just falls through to
  // `return nextNode`, landing on "synthesize" via the phase map alone, not
  // the short-circuit. This does not require AGENT_HITL_ENABLED at all
  // (the reroute condition it is disproving needs an active decision to even
  // be relevant), so it runs in-process like the rest of this describe block.
  test("post-resume routing for a supervisor-triggered (medium-risk) pause reaches synthesize via the phase lookup, not the (riskLevel-only) post-review short-circuit", () => {
    const state = {
      phaseCursor: 8,
      riskLevel: "medium",
      supervisorPlan: { require_human_review: true },
      hitlRequest: { node: "human_review", reason: "resumed with decision", decision: "approve", triggers: ["supervisor_flag"] }
    };
    assert.equal(decideNextRoute(state), "synthesize");
  });

  // ── Precedence: the revise branch is checked (and, when it matches, taken)
  // strictly BEFORE the phase-lookup's HITL reroute is ever consulted. At
  // phaseCursor 7 (qa_plan's own successor), phaseMap[7] is "guardrails", not
  // "synthesize" -- the HITL-reroute condition requires nextNode ===
  // "synthesize", so it is structurally unreachable at this phase regardless
  // of hitlReviewRequired(state). This state sets the supervisor flag AND
  // riskLevel="high" (both signals) specifically to prove neither one can
  // preempt an in-flight revise round -- the revise loop always completes
  // before the HITL gate is even reachable, since the gate only ever fires
  // at the "-> synthesize" transition (phase 8), one phase past where the
  // revise loop re-enters at "retrieve".
  test("flag true (plus riskLevel high) does not preempt the revise branch at cursor 7 -- revise loop resolves before the HITL gate is even reachable", () => {
    const state = {
      phaseCursor: nextPhaseCursor("qa_plan"), // 7 -> would normally be "guardrails"
      riskLevel: "high",
      supervisorPlan: { require_human_review: true },
      qaReview: { verdict: "revise", additional_queries: ["dependency callers tests"] }
    };
    assert.equal(decideNextRoute(state), "retrieve");
  });
});
