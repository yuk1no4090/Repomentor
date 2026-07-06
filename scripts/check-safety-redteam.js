import { readFile } from "node:fs/promises";

const [packageJsonRaw, serverSource, redteamSource, readme, architectureDoc] = await Promise.all([
  readFile("package.json", "utf8"),
  readFile("server.js", "utf8"),
  readFile("scripts/safety-redteam.js", "utf8"),
  readFile("README.md", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8")
]);

const packageJson = JSON.parse(packageJsonRaw);

const requiredPackageScripts = {
  "test:safety": "node scripts/safety-redteam.js",
  test: "npm run test:static && npm run test:smoke && npm run test:ui && npm run test:safety && npm run test:memory && npm run test:user-memory && npm run test:auth && npm run test:embedding"
};

const missingPackageScripts = Object.entries(requiredPackageScripts)
  .filter(([name, value]) => packageJson.scripts?.[name] !== value)
  .map(([name]) => name);

const requiredServerSnippets = [
  "const SAFETY_POLICY",
  "version: \"2026-07-06.redteam-v1\"",
  "function safetyPolicySummary",
  "function matchesSafetyPolicy",
  "safety_policy: safetyPolicySummary()",
  "SAFETY_POLICY.input.prompt_injection",
  "SAFETY_POLICY.repository.prompt_injection"
];

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

const missingServerSnippets = requiredServerSnippets.filter((snippet) => !serverSource.includes(snippet));
const missingRedteamSnippets = requiredRedteamSnippets.filter((snippet) => !redteamSource.includes(snippet));
const missingDocSnippets = requiredDocSnippets.filter((snippet) => !combinedDocs.includes(snippet));

if (missingPackageScripts.length || missingServerSnippets.length || missingRedteamSnippets.length || missingDocSnippets.length) {
  console.error(JSON.stringify({
    missingPackageScripts,
    missingServerSnippets,
    missingRedteamSnippets,
    missingDocSnippets
  }, null, 2));
  throw new Error("Safety red-team contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  packageScripts: Object.keys(requiredPackageScripts).length,
  serverSnippets: requiredServerSnippets.length,
  redteamSnippets: requiredRedteamSnippets.length,
  docSnippets: requiredDocSnippets.length
}, null, 2));
