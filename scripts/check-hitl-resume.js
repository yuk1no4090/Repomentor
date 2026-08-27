import { ok as assert } from "node:assert/strict";
import { readServerSource, readServerSourceStripped } from "./shared/source-reader.js";

const serverSource = await readServerSource();
// Comment-free view of the same source, used by section 7 below. A snippet
// asserted only against `serverSource` can be satisfied by a comment/docstring
// that merely *mentions* the snippet — see stripComments()'s doc comment in
// scripts/shared/source-reader.js for why that turns an assertion into a
// tautology that can never fail regardless of what the real implementation
// does. `codeOnlySource` closes that gap for the assertions where it matters.
//
// Uses readServerSourceStripped() (strips each file independently, THEN
// joins) rather than stripComments(serverSource) (which would strip the
// already-concatenated 14-file blob in one pass): stripComments() is a
// heuristic scanner, not a full parser, and if it ever misjudges some
// construct in one file badly enough to desync, that desync must not bleed
// into whichever file happens to be concatenated right after it.
const codeOnlySource = await readServerSourceStripped();

// ── 1. HITL env var ──
assert(serverSource.includes("AGENT_HITL_ENABLED"), "AGENT_HITL_ENABLED env var not referenced");
assert(serverSource.includes('AGENT_HITL_ENABLED = String(process.env.AGENT_HITL_ENABLED'), "AGENT_HITL_ENABLED not properly initialized");

// ── 2. human_review node ──
assert(serverSource.includes('addNode("human_review"'), "human_review node must exist");
assert(serverSource.includes('hitlRequest: { node: "human_review"'), "human_review must set hitlRequest");
assert(serverSource.includes('status: "hitl_paused"'), "human_review trace must report hitl_paused");

// ── 3. Routing: all model agents + guardrails → human_review → synthesize ──
// Task N2: the gate now runs on hitlReviewRequired(state) (riskLevel="high"
// OR the Supervisor's own require_human_review flag), not riskLevel alone --
// see section 3b below for assertions pinning that predicate's own two
// signals against comment-stripped source.
assert(serverSource.includes('nextNode === "synthesize" && hitlReviewRequired(state) && AGENT_HITL_ENABLED'), "HITL routing gate must run after QACritic and guardrails, gated on hitlReviewRequired(state)");
assert(serverSource.includes("state.qaReview") || serverSource.includes("qaReview"), "QACritic review state must exist before HITL routing");
assert(serverSource.includes('state.hitlRequest?.node === "human_review"'), "Post-human_review routing check must exist");

// ── 3b. Task N2: hitlReviewRequired(state) must be a real two-signal OR
// predicate (riskLevel="high" OR supervisorPlan.require_human_review===true,
// strict boolean check), not riskLevel alone renamed, and not silently
// reduced back to one signal. Asserted against `codeOnlySource` (comments
// stripped) with the exact literal lines from lib/agent-graph.js's
// hitlReviewTriggers()/hitlReviewRequired() so a mutation to either signal's
// condition, or to the strict `=== true` boolean check, or to
// hitlReviewRequired's own "OR" (`.length > 0`) fails these assertions --
// see the report for this card's out-of-repo mutation-verification evidence
// for each one.
assert(codeOnlySource.includes("function hitlReviewTriggers(state)"),
  "hitlReviewTriggers(state) must exist as the single source of truth for which HITL signal(s) fired");
assert(codeOnlySource.includes('if (state.riskLevel === "high") triggers.push("high_risk");'),
  "hitlReviewTriggers must still treat riskLevel===\"high\" as the (still primary) high_risk trigger");
assert(codeOnlySource.includes('if (state.supervisorPlan?.require_human_review === true) triggers.push("supervisor_flag");'),
  "hitlReviewTriggers must treat supervisorPlan.require_human_review===true (strict boolean, not truthiness) as a second, independent supervisor_flag trigger");
assert(codeOnlySource.includes("function hitlReviewRequired(state)") && codeOnlySource.includes("return hitlReviewTriggers(state).length > 0;"),
  "hitlReviewRequired must be defined as hitlReviewTriggers(state).length > 0 -- one OR'd source of truth, not a second independently-maintained condition");

// ── 4. synthesize HITL logic ──
assert(serverSource.includes("hitl:"), "synthesize must include hitl field in finalPayload");
assert(serverSource.includes("paused:"), "hitl field must include paused status");
assert(serverSource.includes("approved:"), "hitl field must include approved status");
assert(serverSource.includes("rejected:"), "hitl field must include rejected status");
assert(serverSource.includes("[HITL PAUSED"), "synthesize must produce paused summary message");
assert(serverSource.includes("[HITL APPROVED]"), "synthesize must produce approved summary message");
assert(serverSource.includes("[HITL REJECTED]"), "synthesize must produce rejected summary message");

// ── 5. Resume API ──
assert(serverSource.includes("decision: body.decision"), "/api/langgraph-resume must accept decision parameter");
assert(serverSource.includes("pausedDecision: decision"), "resume handler must pass decision to workflow");
assert(serverSource.includes("pausedDecision = resumeMetadata?.pausedDecision"), "runAgenticImpactWorkflow must extract pausedDecision");
assert(serverSource.includes("baseInput.hitlRequest"), "resume must inject hitlRequest into graph input");

// ── 6. State fields ──
assert(serverSource.includes("hitlRequest: Annotation"), "State annotation must include hitlRequest");

// ── 7. Native LangGraph interrupt()/Command resume (P4 upgrade) ──
// human_review must genuinely pause the graph via interrupt() instead of just
// flagging a "paused" state and letting the graph continue to synthesize in the
// same invoke() call. Resuming a decision must use LangGraph's own Command(resume)
// contract against the persisted checkpoint, not only a fresh re-executed baseInput.
//
// These assert against `codeOnlySource` (comments stripped) and pin the exact
// *call shape* used by lib/agent-graph.js, not just a bare identifier or a
// loosely-matched fragment — both `serverSource` and a bare-symbol match would
// stay green even if the real call were deleted, as long as some comment
// (including this file's own docstrings, or a dead `import { isInterrupted }`
// with no call site) still mentioned the name. Matching the full call shape on
// comment-free source means the assertion can only pass if that exact call is
// still present in executable code.
assert(codeOnlySource.includes("interrupt(reviewRequest)"),
  "human_review must call interrupt(reviewRequest) in real code to genuinely pause graph execution");
assert(codeOnlySource.includes("new Command({ resume: pausedDecision })"),
  "decision resume must invoke the graph with new Command({ resume: pausedDecision }) in real code to continue the paused execution via LangGraph's Command/resume contract");
assert(codeOnlySource.includes("isInterrupted(state)"),
  "workflow must call isInterrupted(state) in real code to detect the graph's __interrupt__ signal (a bare import or a comment mentioning the helper is not enough)");
assert(codeOnlySource.includes('"native_interrupt_resume"'),
  "decision resume with a persisted checkpoint payload must report harness.resume.mode=native_interrupt_resume in real code");

// ── 8. Task N2 observability: the paused payload must name WHICH signal(s)
// triggered the pause, not just that a pause happened. `describeHitlReason`
// builds `hitl.reason` from `hitlReviewTriggers()`'s own trigger list, and
// `hitl.triggers`/the interrupt() reviewRequest's own `triggers` field carry
// that list itself (additive-only -- see lib/agent-graph.js's own comments on
// each site for why this cannot regress hitl's existing paused/approved/
// rejected/reason/decision fields, which are still asserted unchanged in
// section 4 above).
//
// describeHitlReason's own signature grew a second `state` parameter under
// Task N3 (see section 9 below for why: the two new safety triggers need
// state.inputSafety/retrievedSafety.risk_types, not just the trigger name,
// to build their reason text) -- both the function-definition pin and the
// human_review call-site pin below are updated to that real two-parameter
// shape, not weakened; they still fail if either is reverted to the old
// single-parameter shape or hardcoded back to a literal string.
assert(codeOnlySource.includes("function describeHitlReason(triggers, state = {})"),
  "describeHitlReason(triggers, state) must exist to build the operator-facing hitl.reason text from whichever HITL signal(s) fired");
assert(codeOnlySource.includes('high_risk: "high risk change requires human review"') && codeOnlySource.includes('supervisor_flag: "supervisor requested human review"'),
  "the HITL trigger reason text must name both signals distinctly (high-risk change vs supervisor-requested review)");
assert(codeOnlySource.includes("const triggers = hitlReviewTriggers(state);") && codeOnlySource.includes("reason: describeHitlReason(triggers, state),"),
  "human_review's interrupt() reviewRequest must compute its reason from hitlReviewTriggers(state)/describeHitlReason(triggers, state), not a hardcoded string");
assert(serverSource.includes("triggers: Array.isArray(state.hitlRequest.triggers) ? state.hitlRequest.triggers : []"),
  "the finalPayload's hitl object must additively expose which trigger(s) fired as hitl.triggers");

// ── 9. Task N3: the deterministic safety layer (lib/safety.js) becomes a
// third, independently OR'd HITL trigger source -- a flagged input question
// OR flagged retrieved repository content now requests a pause exactly like
// riskLevel="high" or the Supervisor's require_human_review flag already do.
// Asserted against `codeOnlySource` (comments stripped) with the exact
// literal lines from hitlReviewTriggers() so a mutation to either condition
// (e.g. loosening `=== "needs_review"` to truthiness, or reading the wrong
// channel) fails these assertions -- see the report for this card's
// out-of-repo mutation-verification evidence for each one.
assert(codeOnlySource.includes('if (state.inputSafety?.status === "needs_review") triggers.push("input_safety_flag");'),
  "hitlReviewTriggers must treat a flagged input safety scan (state.inputSafety.status === \"needs_review\", strict string compare) as the input_safety_flag trigger");
assert(codeOnlySource.includes('if (state.retrievedSafety?.status === "needs_review") triggers.push("retrieved_safety_flag");'),
  "hitlReviewTriggers must treat flagged retrieved-content safety (state.retrievedSafety.status === \"needs_review\", strict string compare) as the retrieved_safety_flag trigger");
// outputSafety is deliberately NOT wired in as a trigger (see lib/agent-graph.js's
// own comment on hitlReviewTriggers for why: it isn't computed until
// buildFinalPayload() runs inside synthesize itself, too late to gate a pause
// before it). Pinning its ABSENCE from the trigger list guards against a
// future edit silently adding a fourth, structurally-too-late trigger here
// instead of wiring a real second HITL checkpoint after synthesize.
assert(!codeOnlySource.includes('state.outputSafety?.status === "needs_review") triggers.push('),
  "outputSafety must NOT be wired into hitlReviewTriggers -- it is computed after the only point in the graph that can still reroute to human_review");
// describeHitlReason must build the reason text for the two safety triggers
// from the SPECIFIC risk_types that fired (e.g. "prompt_injection"), not a
// generic "flagged" label -- pinned as the exact template-literal lines so a
// mutation back to a static string (losing the risk-type detail) fails.
assert(codeOnlySource.includes('return `input flagged: ${riskTypes.join(", ")}`;'),
  "describeHitlReason must build the input_safety_flag reason text from state.inputSafety.risk_types, not a static string");
assert(codeOnlySource.includes('return `retrieved content flagged: ${riskTypes.join(", ")}`;'),
  "describeHitlReason must build the retrieved_safety_flag reason text from state.retrievedSafety.risk_types, not a static string");

// ── 10. Task N4, Item 1: the QACritic's own unresolved "revise" verdict
// becomes a FOURTH, independently OR'd HITL trigger. Asserted against
// `codeOnlySource` (comments stripped) with the exact literal condition from
// hitlReviewTriggers() so a mutation to either half of the AND (loosening the
// verdict check, or the budget-exhausted bound) fails these assertions -- see
// the report for this card's out-of-repo mutation-verification evidence.
// The condition deliberately mirrors (mutation-checked against) the
// pre-existing revise-branch guard's own `< AGENT_MAX_REVISION_ROUNDS` loop
// condition a few lines earlier in the same file: this trigger only fires
// where that guard would NOT loop again, so the two can never both apply to
// the same state.
assert(codeOnlySource.includes('if (state.qaReview?.verdict === "revise" && (state.revisionRound || 0) >= AGENT_MAX_REVISION_ROUNDS) triggers.push("critic_flag");'),
  "hitlReviewTriggers must treat an unresolved QACritic revise verdict (verdict===\"revise\" AND the revision budget exhausted, revisionRound >= AGENT_MAX_REVISION_ROUNDS) as the critic_flag trigger -- not findings severity, and not any revise verdict regardless of budget");
// describeHitlReason must build the critic_flag reason text from the actual
// round count (state.revisionRound), not a static string -- pinned as the
// exact template-literal line so a mutation back to a hardcoded string
// (losing the round-count detail) fails.
assert(codeOnlySource.includes('return `critic still requested revision after ${round} round(s)`;'),
  "describeHitlReason must build the critic_flag reason text from state.revisionRound, not a static string");

console.log("[OK] AGENT_HITL_ENABLED env var properly initialized.");
console.log("[OK] human_review node sets hitlRequest and reports hitl_paused.");
console.log("[OK] Routing: QACritic + guardrails → hitlReviewRequired (high risk, supervisor flag, or safety flag) → human_review → synthesize.");
console.log("[OK] hitlReviewRequired(state) is a real multi-signal OR predicate (riskLevel==\"high\" OR supervisorPlan.require_human_review===true OR inputSafety/retrievedSafety flagged, strict comparisons).");
console.log("[OK] synthesize produces hitl field (paused/approved/rejected).");
console.log("[OK] /api/langgraph-resume accepts decision parameter.");
console.log("[OK] Resume handler injects hitlRequest into workflow state.");
console.log("[OK] human_review uses native interrupt()/Command resume (native_interrupt_resume mode present).");
console.log("[OK] Paused payload names which HITL trigger(s) fired (hitl.reason text + additive hitl.triggers).");
console.log("[OK] Task N3: input/retrieved safety flags are wired into hitlReviewTriggers with risk-type-specific reason text; outputSafety is not.");
console.log("[OK] Task N4: an unresolved QACritic revise verdict (budget exhausted) is wired into hitlReviewTriggers as critic_flag, with round-count-specific reason text.");
console.log("[PASS] All HITL checks passed.");
