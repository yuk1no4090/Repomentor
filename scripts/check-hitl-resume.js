import { ok as assert } from "node:assert/strict";
import { readServerSourceStripped } from "./shared/source-reader.js";

// SLIM-A consolidation note: this file used to pin ~40 assertions about the
// HITL env var, human_review's state fields, the routing gate, the
// hitl.{paused,approved,rejected} payload shape, the paused/approved/rejected
// summary markers, the resume API, describeHitlReason()'s reason text, and
// every hitlReviewTriggers() signal condition (N2 supervisor_flag, N3 safety
// flags, N4 critic_flag). All of that is now proven -- more strongly, because
// it exercises the REAL call path instead of matching source text -- by:
//   - test/routing.test.js: calls the real exported decideNextRoute(),
//     hitlReviewTriggers(), hitlReviewRequired() directly and exhaustively
//     covers every signal (high_risk, supervisor_flag, input_safety_flag,
//     retrieved_safety_flag, critic_flag), strict-boolean/strict-string edge
//     cases, ordering, and the AGENT_HITL_ENABLED-gated reroute itself (via a
//     child process with the env var actually set).
//   - check-hitl-resume-behavior.js, check-hitl-safety-trigger.js,
//     check-hitl-supervisor-trigger.js, check-revise-hitl-cross.js (all
//     behavioral/spawn-based, untouchable): spawn the real server and drive a
//     real graph run through a real pause + /api/langgraph-resume call,
//     asserting the exact real payload.hitl.{paused,approved,rejected,reason,
//     triggers} shape, the exact "[HITL PAUSED"/"[HITL APPROVED]"/
//     "[HITL REJECTED]" summary markers, and (critically) harness.resume.mode
//     === "native_interrupt_resume" together with a trace-length delta that
//     proves the resume did NOT silently re-run already-completed phases --
//     the exact regression this file's env-var/routing/payload-shape pins
//     used to guard, now proven end-to-end instead of via source text.
//
// What's left below is the one thing none of that can see: whether
// human_review's node BODY still genuinely calls LangGraph's native
// interrupt()/Command primitives, as opposed to some other mechanism that
// happens to produce the same observable mode string and trace-length delta.
// Comment-stripped source is used deliberately (see stripComments()'s own doc
// comment) so a comment merely mentioning these call shapes cannot satisfy
// the assertion -- only real, executable code can.
const codeOnlySource = await readServerSourceStripped();

assert(codeOnlySource.includes("interrupt(reviewRequest)"),
  "human_review must call interrupt(reviewRequest) in real code to genuinely pause graph execution");
assert(codeOnlySource.includes("new Command({ resume: pausedDecision })"),
  "decision resume must invoke the graph with new Command({ resume: pausedDecision }) in real code to continue the paused execution via LangGraph's Command/resume contract");
assert(codeOnlySource.includes("isInterrupted(state)"),
  "workflow must call isInterrupted(state) in real code to detect the graph's __interrupt__ signal (a bare import or a comment mentioning the helper is not enough)");

console.log("[OK] human_review uses native interrupt()/Command resume (interrupt()/Command/isInterrupted call shapes present in real code).");
console.log("[PASS] All HITL checks passed.");
