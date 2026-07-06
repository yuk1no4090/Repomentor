import { readFile } from "node:fs/promises";

const [packageJsonRaw, benchmarkSource, readme, architectureDoc] = await Promise.all([
  readFile("package.json", "utf8"),
  readFile("scripts/agent-benchmark.js", "utf8"),
  readFile("README.md", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8")
]);

const packageJson = JSON.parse(packageJsonRaw);

const requiredBenchmarkSnippets = [
  "BENCHMARK_VERSION",
  "BENCHMARK_CASES",
  "agent-safe-impact",
  "agent-prompt-injection",
  "chat-safe-qa",
  "chat-tool-escalation",
  "scorePayload",
  "pass_rate",
  "schema_valid_runs",
  "safety_needs_review",
  "trace_tool_counts",
  "recent_harness_runs"
];

const requiredDocSnippets = [
  "test:benchmark",
  "agent benchmark",
  "pass rate",
  "safety, trace, harness, citation, and memory"
];

const missingBenchmarkSnippets = requiredBenchmarkSnippets.filter((snippet) => !benchmarkSource.includes(snippet));
const combinedDocs = `${readme}\n${architectureDoc}`;
const missingDocSnippets = requiredDocSnippets.filter((snippet) => !combinedDocs.includes(snippet));

if (packageJson.scripts["test:benchmark"] !== "node scripts/agent-benchmark.js") {
  throw new Error("package.json is missing test:benchmark script.");
}

if (!String(packageJson.scripts.test || "").includes("npm run test:benchmark")) {
  throw new Error("npm test does not include test:benchmark.");
}

if (missingBenchmarkSnippets.length || missingDocSnippets.length) {
  console.error(JSON.stringify({
    missingBenchmarkSnippets,
    missingDocSnippets
  }, null, 2));
  throw new Error("Agent benchmark contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  benchmarkSnippets: requiredBenchmarkSnippets.length,
  docSnippets: requiredDocSnippets.length
}, null, 2));
