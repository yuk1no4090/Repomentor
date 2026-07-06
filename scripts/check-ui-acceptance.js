import { readFile } from "node:fs/promises";

const [packageJsonRaw, readme, uiAcceptanceSource] = await Promise.all([
  readFile("package.json", "utf8"),
  readFile("README.md", "utf8"),
  readFile("scripts/ui-acceptance.js", "utf8")
]);

const packageJson = JSON.parse(packageJsonRaw);

const requiredPackageScripts = {
  "test:ui": "node scripts/ui-acceptance.js",
  test: "npm run test:static && npm run test:smoke && npm run test:ui && npm run test:safety && npm run test:memory && npm run test:user-memory"
};

const missingPackageScripts = Object.entries(requiredPackageScripts)
  .filter(([name, value]) => packageJson.scripts?.[name] !== value)
  .map(([name]) => name);

const requiredReadmeSnippets = [
  "npm run test:ui",
  "UI acceptance test",
  "served frontend assets",
  "harness audit panel"
];

const requiredUiSnippets = [
  "assertServedFrontend",
  "assertUiDataContract",
  "data-memory-action=\\\"confirm\\\"",
  "data-harness-run",
  "/api/agent-impact",
  "/api/memory/confirm",
  "/api/harness-run",
  "long_term_memories",
  "Node 24 runtime"
];

const missingReadmeSnippets = requiredReadmeSnippets.filter((snippet) => !readme.includes(snippet));
const missingUiSnippets = requiredUiSnippets.filter((snippet) => !uiAcceptanceSource.includes(snippet));

if (missingPackageScripts.length || missingReadmeSnippets.length || missingUiSnippets.length) {
  console.error(JSON.stringify({
    missingPackageScripts,
    missingReadmeSnippets,
    missingUiSnippets
  }, null, 2));
  throw new Error("UI acceptance test contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  packageScripts: Object.keys(requiredPackageScripts).length,
  readmeSnippets: requiredReadmeSnippets.length,
  uiSnippets: requiredUiSnippets.length
}, null, 2));
