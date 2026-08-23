import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSupervisorPlan,
  validateQaCriticPayload,
  createDeterministicSupervisorPlan,
  createDeterministicQaCriticReview,
  mergeQaCriticReview,
  constrainQaCriticEvidence
} from "../lib/agent-contracts.js";

test("deterministic supervisor requires both model agents and proposes retrieval queries", () => {
  const plan = createDeterministicSupervisorPlan("Add a partially_refunded payment status");
  assert.equal(plan.intent, "impact_analysis");
  assert.equal(plan.risk_hypothesis, "high");
  assert.deepEqual(plan.required_agents, ["ImpactAnalyst", "QACritic"]);
  assert.ok(plan.retrieval_queries.length >= 1);
  assert.deepEqual(validateSupervisorPlan(plan), { valid: true, errors: [] });
});

test("supervisor schema rejects plans that omit the independent critic", () => {
  const result = validateSupervisorPlan({
    intent: "impact_analysis",
    risk_hypothesis: "medium",
    required_agents: ["ImpactAnalyst"],
    retrieval_queries: ["orders"],
    require_human_review: false,
    rationale: "Analyze orders."
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("required_agents must include QACritic"));
});

test("deterministic critic requests revision for uncited impact areas", () => {
  const review = createDeterministicQaCriticReview({
    impact_areas: [{ area: "Orders", risk_level: "high", reason: "State changes", files: [] }],
    testing_suggestions: [],
    open_questions: []
  });
  assert.equal(review.verdict, "revise");
  assert.equal(validateQaCriticPayload(review).valid, true);
  assert.ok(review.findings.some((finding) => finding.severity === "high"));
});

test("critic evidence is restricted to imported repository paths", () => {
  const constrained = constrainQaCriticEvidence({
    verdict: "approve",
    summary: "Review complete.",
    findings: [{ severity: "low", finding: "Check order state.", evidence_files: ["src/order.ts", "src/ghost.ts"] }],
    testing_suggestions: [],
    open_questions: [],
    additional_queries: []
  }, ["src/order.ts"]);
  assert.equal(constrained.verdict, "revise");
  assert.deepEqual(constrained.findings[0].evidence_files, ["src/order.ts"]);
  assert.ok(constrained.summary.includes("1 unsupported critic citation"));
});

test("critic suggestions merge without duplicating analyst output", () => {
  const merged = mergeQaCriticReview({
    testing_suggestions: ["Test success path"],
    open_questions: ["Is migration required?"]
  }, {
    testing_suggestions: ["Test success path", "Test rollback"],
    open_questions: ["Is migration required?", "What is the rollout plan?"]
  });
  assert.deepEqual(merged.testing_suggestions, ["Test success path", "Test rollback"]);
  assert.deepEqual(merged.open_questions, ["Is migration required?", "What is the rollout plan?"]);
});
