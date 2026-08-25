import { ok as assert } from "node:assert/strict";
import { readServerSource } from "./shared/source-reader.js";

const serverSource = await readServerSource();

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
assert(serverSource.includes("interrupt("), "human_review must call interrupt() to genuinely pause graph execution");
assert(serverSource.includes("new Command({ resume"), "decision resume must invoke the graph with new Command({ resume: ... }) to continue the paused execution");
assert(serverSource.includes("__interrupt__"), "workflow must inspect the graph's __interrupt__ signal to detect a genuine pause (not just a state flag)");
assert(serverSource.includes('"native_interrupt_resume"'), "decision resume with a persisted checkpoint payload must report harness.resume.mode=native_interrupt_resume");
assert(serverSource.includes("isInterrupted"), "workflow must use LangGraph's isInterrupted() helper (or equivalent) to detect the interrupted result");

console.log("[OK] AGENT_HITL_ENABLED env var properly initialized.");
console.log("[OK] human_review node sets hitlRequest and reports hitl_paused.");
console.log("[OK] Routing: QACritic + guardrails → high-risk human_review → synthesize.");
console.log("[OK] synthesize produces hitl field (paused/approved/rejected).");
console.log("[OK] /api/langgraph-resume accepts decision parameter.");
console.log("[OK] Resume handler injects hitlRequest into workflow state.");
console.log("[OK] human_review uses native interrupt()/Command resume (native_interrupt_resume mode present).");
console.log("[PASS] All HITL checks passed.");
