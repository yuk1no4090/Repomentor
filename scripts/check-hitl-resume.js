import { ok as assert } from "node:assert/strict";
import { readServerSource, stripComments } from "./shared/source-reader.js";

const serverSource = await readServerSource();
// Comment-free view of the same source, used by section 7 below. A snippet
// asserted only against `serverSource` can be satisfied by a comment/docstring
// that merely *mentions* the snippet — see stripComments()'s doc comment in
// scripts/shared/source-reader.js for why that turns an assertion into a
// tautology that can never fail regardless of what the real implementation
// does. `codeOnlySource` closes that gap for the assertions where it matters.
const codeOnlySource = stripComments(serverSource);

// ── 1. HITL env var ──
assert(serverSource.includes("AGENT_HITL_ENABLED"), "AGENT_HITL_ENABLED env var not referenced");
assert(serverSource.includes('AGENT_HITL_ENABLED = String(process.env.AGENT_HITL_ENABLED'), "AGENT_HITL_ENABLED not properly initialized");

// ── 2. human_review node ──
assert(serverSource.includes('addNode("human_review"'), "human_review node must exist");
assert(serverSource.includes('hitlRequest: { node: "human_review"'), "human_review must set hitlRequest");
assert(serverSource.includes('status: "hitl_paused"'), "human_review trace must report hitl_paused");

// ── 3. Routing: all model agents + guardrails → human_review → synthesize ──
assert(serverSource.includes('nextNode === "synthesize" && state.riskLevel === "high" && AGENT_HITL_ENABLED'), "HITL routing gate must run after QACritic and guardrails");
assert(serverSource.includes("state.qaReview") || serverSource.includes("qaReview"), "QACritic review state must exist before HITL routing");
assert(serverSource.includes('state.hitlRequest?.node === "human_review"'), "Post-human_review routing check must exist");

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

console.log("[OK] AGENT_HITL_ENABLED env var properly initialized.");
console.log("[OK] human_review node sets hitlRequest and reports hitl_paused.");
console.log("[OK] Routing: QACritic + guardrails → high-risk human_review → synthesize.");
console.log("[OK] synthesize produces hitl field (paused/approved/rejected).");
console.log("[OK] /api/langgraph-resume accepts decision parameter.");
console.log("[OK] Resume handler injects hitlRequest into workflow state.");
console.log("[OK] human_review uses native interrupt()/Command resume (native_interrupt_resume mode present).");
console.log("[PASS] All HITL checks passed.");
