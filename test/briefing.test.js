import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildImpactBriefing,
  isValidBriefingShape,
  applyPreferencesToImpact,
  validateImpactPayload
} from "../lib/answers.js";

// Unit tests for the deterministic PM/QA "briefing" builder in lib/answers.js.
// Expected values below were captured by running the real buildImpactBriefing()
// (and friends) first, not guessed from reading the source - see AGENTS.md's
// "unit test" convention.

describe("buildImpactBriefing: normal input", () => {
  const areas = [
    { area: "Data Model", risk_level: "high", reason: "r1", files: ["src/models/order.ts"] },
    { area: "Business Logic", risk_level: "high", reason: "r2", files: ["src/services/authService.ts"] },
    { area: "UI / Presentation", risk_level: "medium", reason: "r3", files: ["src/components/ProductPage.tsx"] }
  ];
  const briefing = buildImpactBriefing(areas);

  test("has all four required keys with the right shapes", () => {
    assert.equal(typeof briefing.summary, "string");
    assert.ok(Array.isArray(briefing.affected_flows));
    assert.ok(Array.isArray(briefing.testing_focus));
    assert.equal(typeof briefing.risk_note, "string");
  });

  test("summary is a 2-4 sentence narrative naming the affected flows, without function names or line numbers", () => {
    assert.equal(
      briefing.summary,
      "This change mainly affects Orders & transactions, Login & permissions, Products & inventory. 3 areas of the codebase look relevant based on the files retrieved. The risk sits on the higher side, mainly because it reaches core business logic or the data model, so a careful review before merging is worth the time."
    );
    const sentenceCount = briefing.summary.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    assert.ok(sentenceCount >= 2 && sentenceCount <= 4, `expected 2-4 sentences, got ${sentenceCount}`);
    assert.ok(!/\bfunction\s+\w+\(/.test(briefing.summary), "summary should not mention function signatures");
    assert.ok(!/:\d+/.test(briefing.summary), "summary should not mention line numbers");
  });

  test("infers a distinct business flow per file, using camelCase-aware substring matching (not word-boundary regex)", () => {
    // authService.ts must resolve to "Login & permissions" even though "auth" has
    // no word boundary before the following capital S - this is the exact bug
    // fixed by switching BUSINESS_FLOW_RULES from \b-anchored regex to substring
    // matching (see the comment above BUSINESS_FLOW_RULES in lib/answers.js).
    assert.deepEqual(briefing.affected_flows, [
      {
        flow: "Orders & transactions",
        why: "Touches Data Model code with a high risk rating, so this flow may behave differently after the change. Likely files: src/models/order.ts."
      },
      {
        flow: "Login & permissions",
        why: "Touches Business Logic code with a high risk rating, so this flow may behave differently after the change. Likely files: src/services/authService.ts."
      },
      {
        flow: "Products & inventory",
        why: "Touches UI / Presentation code with a medium risk rating, so this flow may behave differently after the change. Likely files: src/components/ProductPage.tsx."
      }
    ]);
  });

  test("testing_focus translates each technical area into a plain-language behavior to verify", () => {
    assert.deepEqual(briefing.testing_focus, [
      "Confirm old and new data stay compatible - existing records should not break when the shape changes.",
      "Walk through the core business rule with edge cases such as boundary values, missing input, or concurrent changes.",
      "Verify the screen, filters, and empty or error states render correctly for the changed data."
    ]);
  });

  test("risk_note recommends human review for high-risk changes", () => {
    assert.equal(
      briefing.risk_note,
      "High risk: recommend a human review before merging, plus a regression pass over the flows listed above."
    );
  });

  test("output passes isValidBriefingShape", () => {
    assert.equal(isValidBriefingShape(briefing), true);
  });
});

describe("buildImpactBriefing: empty impact_areas", () => {
  const briefing = buildImpactBriefing([]);

  test("affected_flows is empty and testing_focus falls back to a generic tip", () => {
    assert.deepEqual(briefing.affected_flows, []);
    assert.deepEqual(briefing.testing_focus, [
      "Confirm the happy path works, then check at least one failure or edge case before considering this done."
    ]);
  });

  test("summary and risk_note both explain that evidence is insufficient rather than asserting a risk level", () => {
    assert.equal(
      briefing.summary,
      "There is not enough repository evidence yet to describe which capability this change touches. Import more of the codebase or narrow the request before treating any risk call as final."
    );
    assert.equal(
      briefing.risk_note,
      "Risk level is unclear because there is not enough repository evidence yet. Recommendation: clarify the request or import more of the codebase before making a go/no-go call."
    );
  });

  test("still a valid shape (no LLM/legacy caller can crash on an empty impact_areas list)", () => {
    assert.equal(isValidBriefingShape(briefing), true);
  });

  test("also called via the default parameter (buildImpactBriefing())", () => {
    assert.deepEqual(buildImpactBriefing(), briefing);
  });
});

describe("buildImpactBriefing: risk-level narrative differs by risk level", () => {
  test("low risk", () => {
    const briefing = buildImpactBriefing([
      { area: "Tests", risk_level: "low", reason: "r", files: ["test/foo.test.js"] }
    ]);
    assert.equal(
      briefing.summary,
      "This change mainly affects Test coverage & quality. 1 area of the codebase looks relevant based on the files retrieved. The risk looks low based on the evidence retrieved, though that is partly because only limited context was available."
    );
    assert.equal(
      briefing.risk_note,
      "Low risk: normal code review plus the existing automated tests should be enough to catch regressions."
    );
  });

  test("medium risk", () => {
    const briefing = buildImpactBriefing([
      { area: "Persistence", risk_level: "medium", reason: "r", files: ["src/db/migration.sql"] }
    ]);
    assert.equal(
      briefing.summary,
      "This change mainly affects Data structure & storage. 1 area of the codebase looks relevant based on the files retrieved. The risk is moderate: nothing looks structurally dangerous, but a couple of areas still deserve a second look before shipping."
    );
    assert.equal(
      briefing.risk_note,
      "Medium risk: recommend at least targeted unit tests for the changed files and a quick smoke test before release."
    );
  });

  test("high risk", () => {
    const briefing = buildImpactBriefing([
      { area: "Data Model", risk_level: "high", reason: "r", files: ["src/models/order.ts"] }
    ]);
    assert.match(briefing.summary, /risk sits on the higher side/);
    assert.match(briefing.risk_note, /^High risk: recommend a human review/);
  });

  test("high/medium/low risk_note strings are all distinct", () => {
    const low = buildImpactBriefing([{ area: "Tests", risk_level: "low", reason: "r", files: ["a.test.js"] }]).risk_note;
    const medium = buildImpactBriefing([{ area: "Persistence", risk_level: "medium", reason: "r", files: ["a.sql"] }]).risk_note;
    const high = buildImpactBriefing([{ area: "Data Model", risk_level: "high", reason: "r", files: ["a.ts"] }]).risk_note;
    assert.equal(new Set([low, medium, high]).size, 3);
  });
});

describe("isValidBriefingShape: malformed input is rejected", () => {
  test("undefined/null is invalid", () => {
    assert.equal(isValidBriefingShape(undefined), false);
    assert.equal(isValidBriefingShape(null), false);
  });

  test("missing risk_note is invalid", () => {
    assert.equal(isValidBriefingShape({ summary: "x", affected_flows: [], testing_focus: [] }), false);
  });

  test("affected_flows entries that are bare strings (not {flow, why} objects) are invalid", () => {
    // This mirrors the exact DeepSeek failure mode fixed in bd73106 for
    // related_files (bare path strings instead of {file_path, reason} objects).
    assert.equal(
      isValidBriefingShape({ summary: "x", affected_flows: ["Login & permissions"], testing_focus: [], risk_note: "x" }),
      false
    );
  });

  test("a well-formed briefing passes", () => {
    assert.equal(
      isValidBriefingShape({
        summary: "x",
        affected_flows: [{ flow: "Orders & transactions", why: "because" }],
        testing_focus: ["verify something"],
        risk_note: "Low risk."
      }),
      true
    );
  });
});

describe("validateImpactPayload: briefing is optional but validated when present", () => {
  const basePayload = {
    summary: "x",
    impact_areas: [{ area: "API Routes", risk_level: "medium", reason: "r", files: ["a.ts"] }],
    testing_suggestions: [],
    open_questions: []
  };

  test("a legacy payload with no briefing at all is still valid (backward compatibility)", () => {
    const result = validateImpactPayload(basePayload);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test("a payload with a well-formed briefing is valid", () => {
    const result = validateImpactPayload({ ...basePayload, briefing: buildImpactBriefing(basePayload.impact_areas) });
    assert.equal(result.valid, true);
  });

  test("a payload with a malformed briefing is rejected with a briefing-specific error", () => {
    const result = validateImpactPayload({
      ...basePayload,
      briefing: { summary: "x", affected_flows: ["bad"], testing_focus: [], risk_note: "x" }
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("briefing")));
  });
});

describe("applyPreferencesToImpact: legacy payload compatibility", () => {
  const legacyImpact = {
    summary: "x",
    impact_areas: [{ area: "API Routes", risk_level: "medium", reason: "r", files: ["a.ts"] }],
    testing_suggestions: [],
    open_questions: []
  };

  test("does not throw when the input impact has no briefing field at all", () => {
    assert.doesNotThrow(() => applyPreferencesToImpact(legacyImpact, {}));
  });

  test("backfills a valid deterministic briefing built from the final impact_areas", () => {
    const result = applyPreferencesToImpact(legacyImpact, {});
    assert.equal(isValidBriefingShape(result.briefing), true);
    assert.deepEqual(result.briefing, buildImpactBriefing(legacyImpact.impact_areas));
  });

  test("keeps an already-valid briefing (e.g. supplied by the LLM) untouched instead of rebuilding it", () => {
    const llmBriefing = buildImpactBriefing(legacyImpact.impact_areas);
    const result = applyPreferencesToImpact({ ...legacyImpact, briefing: llmBriefing }, {});
    assert.equal(result.briefing, llmBriefing);
  });

  test("replaces a malformed briefing with a deterministic rebuild instead of passing it through", () => {
    const malformed = { summary: "x", affected_flows: ["bad"], testing_focus: [], risk_note: "x" };
    const result = applyPreferencesToImpact({ ...legacyImpact, briefing: malformed }, {});
    assert.notEqual(result.briefing, malformed);
    assert.equal(isValidBriefingShape(result.briefing), true);
  });
});
