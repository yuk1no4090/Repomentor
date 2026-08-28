import { readFile } from "node:fs/promises";

// SLIM-A consolidation note: this file used to also pin the SAFETY_POLICY
// object, safetyPolicySummary()/matchesSafetyPolicy() function names, the
// health.safety_policy wiring line, and SAFETY_POLICY.input/repository path
// literals against server source. All of that is now proven -- more
// strongly, through the real call path -- by scripts/safety-redteam.js
// itself (this file's own behavioral companion, part of `npm test` via
// test:safety): it spawns the real server, asserts the real /api/health
// response's health.safety_policy.version/input_rules.prompt_injection/
// output.require_citations fields, then drives real prompt-injection,
// secret-request, tool-escalation, and malicious-repository-import cases
// through /api/agent-impact and asserts the resulting real risk_types
// classifications and redaction behavior end-to-end. A mutation to any of
// SAFETY_POLICY's structure, safetyPolicySummary()'s wiring, or
// matchesSafetyPolicy()'s classification logic would fail one of those real
// HTTP assertions, not just this file's source-text pins.
//
// What remains here is what scripts/safety-redteam.js's own real assertions
// cannot guard: (1) package.json wiring -- nothing else notices a silently
// removed test:safety script entry (npm test would just stop running the
// suite, exit 0, and nobody would know); (2) a test-gutting guard on
// scripts/safety-redteam.js's OWN source, so a case silently deleted from
// REDTEAM_CASES (which would leave `npm test` green with reduced coverage,
// since fewer assertions still all pass) is caught; (3) doc-sync, which
// nothing else enforces for these specific terms.

const [packageJsonRaw, redteamSource, readme, architectureDoc] = await Promise.all([
  readFile("package.json", "utf8"),
  readFile("scripts/safety-redteam.js", "utf8"),
  readFile("README.md", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8")
]);

const packageJson = JSON.parse(packageJsonRaw);

const requiredPackageScripts = {
  "test:safety": "node scripts/safety-redteam.js"
};

const missingPackageScripts = Object.entries(requiredPackageScripts)
  .filter(([name, value]) => packageJson.scripts?.[name] !== value)
  .map(([name]) => name);

if (!String(packageJson.scripts?.test || "").includes("npm run test:safety")) {
  missingPackageScripts.push("test");
}

const requiredRedteamSnippets = [
  "REDTEAM_CASES",
  "prompt injection and secret request",
  "tool permission escalation",
  "health.safety_policy",
  "/api/agent-impact",
  "retrieved_prompt_injection",
  "retrieved_sensitive_content",
  "sk-redteam1234567890"
];

const combinedDocs = `${readme}\n${architectureDoc}`;
const requiredDocSnippets = [
  "safety policy",
  "red-team",
  "npm run test:safety",
  "safety_policy"
];

const missingRedteamSnippets = requiredRedteamSnippets.filter((snippet) => !redteamSource.includes(snippet));
const missingDocSnippets = requiredDocSnippets.filter((snippet) => !combinedDocs.includes(snippet));

if (missingPackageScripts.length || missingRedteamSnippets.length || missingDocSnippets.length) {
  console.error(JSON.stringify({
    missingPackageScripts,
    missingRedteamSnippets,
    missingDocSnippets
  }, null, 2));
  throw new Error("Safety red-team contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  packageScripts: Object.keys(requiredPackageScripts).length,
  redteamSnippets: requiredRedteamSnippets.length,
  docSnippets: requiredDocSnippets.length
}, null, 2));
