import { readFile } from "node:fs/promises";
import { readServerSource } from "./shared/source-reader.js";

const [packageJsonRaw, packageLockRaw, serverSource, readme, nvmrc] = await Promise.all([
  readFile("package.json", "utf8"),
  readFile("package-lock.json", "utf8"),
  readServerSource(),
  readFile("README.md", "utf8"),
  readFile(".nvmrc", "utf8")
]);

const packageJson = JSON.parse(packageJsonRaw);
const packageLock = JSON.parse(packageLockRaw);

const requiredDependencies = [
  "@langchain/core",
  "@langchain/langgraph",
  "@langchain/langgraph-checkpoint"
];

const missingPackageDeps = requiredDependencies.filter((name) => {
  return !packageJson.dependencies?.[name];
});

const rootLockDeps = packageLock.packages?.[""]?.dependencies || {};
const missingLockDeps = requiredDependencies.filter((name) => {
  return !rootLockDeps[name];
});

const runtimeContract = {
  packageEngine: packageJson.engines?.node,
  lockEngine: packageLock.packages?.[""]?.engines?.node,
  nvmrc: nvmrc.trim()
};

const runtimeMismatches = [];
if (runtimeContract.packageEngine !== ">=24") runtimeMismatches.push("package.json engines.node must be >=24");
if (runtimeContract.lockEngine !== ">=24") runtimeMismatches.push("package-lock root engines.node must be >=24");
if (runtimeContract.nvmrc !== "24") runtimeMismatches.push(".nvmrc must target Node 24");

const requiredSourceSnippets = [
  'import { DatabaseSync } from "node:sqlite"',
  'from "@langchain/langgraph"',
  'from "@langchain/langgraph-checkpoint"',
  "new StateGraph",
  "Annotation.Root"
];

const missingSourceSnippets = requiredSourceSnippets.filter((snippet) => {
  return !serverSource.includes(snippet);
});

const requiredReadmeSnippets = [
  "LangGraph",
  "npm install",
  "Node.js 24",
  "node:sqlite",
  "OpenAI-compatible",
  "modelAdapter",
  "agentHarness"
];

const missingReadmeSnippets = requiredReadmeSnippets.filter((snippet) => {
  return !readme.includes(snippet);
});

if (
  missingPackageDeps.length
  || missingLockDeps.length
  || runtimeMismatches.length
  || missingSourceSnippets.length
  || missingReadmeSnippets.length
) {
  console.error(JSON.stringify({
    missingPackageDeps,
    missingLockDeps,
    runtimeContract,
    runtimeMismatches,
    missingSourceSnippets,
    missingReadmeSnippets
  }, null, 2));
  throw new Error("Runtime dependency contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  dependencies: requiredDependencies,
  runtimeContract,
  sourceSnippets: requiredSourceSnippets.length,
  readmeSnippets: requiredReadmeSnippets.length
}, null, 2));
