import { readFile } from "node:fs/promises";
import { readServerSource } from "./shared/source-reader.js";

const [serverSource, architectureDoc, readme] = await Promise.all([
  readServerSource(),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8"),
  readFile("README.md", "utf8")
]);

const registryMatch = serverSource.match(/const AGENT_TOOL_REGISTRY = \[([\s\S]*?)\n\];/);
const policyMatch = serverSource.match(/const AGENT_TOOL_POLICY = \{([\s\S]*?)\n\};/);

if (!registryMatch || !policyMatch) {
  throw new Error("Could not locate agent tool registry or policy in server.js.");
}

const registryEntries = [...registryMatch[1].matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);

if (!registryEntries.length) {
  throw new Error("Agent tool registry is empty.");
}

const unsafeRegistryEntries = registryEntries
  .map((entry, index) => ({ entry, index }))
  .filter(({ entry }) => {
    return !entry.includes('access: "read-only"') || !entry.includes("external_network: false");
  });

const requiredPolicySnippets = [
  'mode: "read-only"',
  "allow_external_network: false",
  "allow_repository_writes: false",
  "allow_shell_execution: false"
];

const missingPolicySnippets = requiredPolicySnippets.filter((snippet) => !policyMatch[1].includes(snippet));

const combinedDocs = `${architectureDoc}\n${readme}`;
const requiredDocSnippets = [
  "read-only tool registry",
  "allow_external_network",
  "allow_repository_writes",
  "allow_shell_execution"
];
const missingDocSnippets = requiredDocSnippets.filter((snippet) => !combinedDocs.includes(snippet));

if (unsafeRegistryEntries.length || missingPolicySnippets.length || missingDocSnippets.length) {
  console.error(JSON.stringify({
    unsafeRegistryEntries,
    missingPolicySnippets,
    missingDocSnippets
  }, null, 2));
  throw new Error("Agent tool policy is incomplete or under-documented.");
}

console.log(JSON.stringify({
  ok: true,
  registryEntries: registryEntries.length,
  policyChecks: requiredPolicySnippets.length,
  docChecks: requiredDocSnippets.length
}, null, 2));
