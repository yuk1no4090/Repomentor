import { readFile } from "node:fs/promises";

const [operations, readme] = await Promise.all([
  readFile("docs/OPERATIONS.md", "utf8"),
  readFile("README.md", "utf8")
]);

const requiredSections = [
  "## Runtime Profile",
  "## Required Setup",
  "## Environment Variables",
  "## Authentication Operations",
  "## Memory Operations",
  "## Vector Memory Operations",
  "## LangGraph And Harness Operations",
  "## Safety Operations",
  "## Upgrade Checklist",
  "## Incident Checklist",
  "## Verification Commands"
];

const requiredTerms = [
  "Node.js 24",
  "data/store.json",
  "data/memory.sqlite",
  "AI_PM_AUTH_REQUIRED",
  "AI_PM_USER_TOKENS",
  "POST /api/auth/users",
  "POST /api/auth/users/disable",
  "SHA-256 hashes",
  "GET /api/memory/status",
  "POST /api/memory/backup",
  "POST /api/memory/restore",
  "confirm: \"RESTORE_MEMORY_DATABASE\"",
  "MEMORY_VECTOR_INDEX_PROVIDER",
  "qdrant",
  "pinecone",
  "langgraph_checkpoints",
  "langgraph_checkpoint_payloads",
  "checkpoint_continuation",
  "input_snapshot_reexecution",
  "Runtime `store` is kept out of graph state",
  "Repository content is treated as untrusted evidence",
  "npm test"
];

const missingSections = requiredSections.filter((section) => !operations.includes(section));
const missingTerms = requiredTerms.filter((term) => !operations.includes(term));
const missingReadmeLink = readme.includes("docs/OPERATIONS.md") ? [] : ["README link to docs/OPERATIONS.md"];

if (missingSections.length || missingTerms.length || missingReadmeLink.length) {
  console.error(JSON.stringify({
    missingSections,
    missingTerms,
    missingReadmeLink
  }, null, 2));
  throw new Error("Operations documentation contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  sections: requiredSections.length,
  terms: requiredTerms.length
}, null, 2));
