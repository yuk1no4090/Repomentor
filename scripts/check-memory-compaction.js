import { readFile } from "node:fs/promises";
import { readServerSource } from "./shared/source-reader.js";

const [packageJsonRaw, serverSource, testSource, readme, architectureDoc] = await Promise.all([
  readFile("package.json", "utf8"),
  readServerSource(),
  readFile("scripts/memory-compaction-test.js", "utf8"),
  readFile("README.md", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8")
]);

const packageJson = JSON.parse(packageJsonRaw);

const requiredPackageScripts = {
  "test:memory": "node scripts/memory-compaction-test.js"
};

const missingPackageScripts = Object.entries(requiredPackageScripts)
  .filter(([name, value]) => packageJson.scripts?.[name] !== value)
  .map(([name]) => name);

if (!String(packageJson.scripts?.test || "").includes("npm run test:memory")) {
  missingPackageScripts.push("test");
}

const requiredServerSnippets = [
  "function compactLongTermPreferenceMemories",
  "function refreshLongTermMemorySummary",
  "status = 'superseded'",
  "preference_summary",
  "memory_compaction"
];

const requiredTestSnippets = [
  "ai-pm-memory-",
  "status=superseded",
  "Product Manager",
  "role=QA",
  "preference_summary",
  "memory_compaction"
];

const combinedDocs = `${readme}\n${architectureDoc}`;
const requiredDocSnippets = [
  "superseded",
  "preference_summary",
  "memory_compaction",
  "npm run test:memory"
];

const missingServerSnippets = requiredServerSnippets.filter((snippet) => !serverSource.includes(snippet));
const missingTestSnippets = requiredTestSnippets.filter((snippet) => !testSource.includes(snippet));
const missingDocSnippets = requiredDocSnippets.filter((snippet) => !combinedDocs.includes(snippet));

if (missingPackageScripts.length || missingServerSnippets.length || missingTestSnippets.length || missingDocSnippets.length) {
  console.error(JSON.stringify({
    missingPackageScripts,
    missingServerSnippets,
    missingTestSnippets,
    missingDocSnippets
  }, null, 2));
  throw new Error("Memory compaction contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  packageScripts: Object.keys(requiredPackageScripts).length,
  serverSnippets: requiredServerSnippets.length,
  testSnippets: requiredTestSnippets.length,
  docSnippets: requiredDocSnippets.length
}, null, 2));
