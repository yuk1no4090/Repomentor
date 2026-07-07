import { readFile } from "node:fs/promises";

const [packageJsonRaw, serverSource, smokeSource, readme, architectureDoc] = await Promise.all([
  readFile("package.json", "utf8"),
  readFile("server.js", "utf8"),
  readFile("scripts/smoke-test.js", "utf8"),
  readFile("README.md", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8")
]);

const packageJson = JSON.parse(packageJsonRaw);

const missingDependencies = ["@langchain/langgraph-checkpoint"].filter((name) => !packageJson.dependencies?.[name]);

const requiredServerSnippets = [
  "import { MemorySaver } from \"@langchain/langgraph-checkpoint\"",
  "CREATE TABLE IF NOT EXISTS langgraph_checkpoints",
  "CREATE TABLE IF NOT EXISTS langgraph_checkpoint_payloads",
  "function persistLangGraphCheckpoints",
  "function serializeMemorySaverSnapshot",
  "function deserializeMemorySaverSnapshot",
  "function persistLangGraphCheckpointPayload",
  "function loadLangGraphCheckpointPayload",
  "function listLangGraphCheckpoints",
  "function findLangGraphCheckpoint",
  "function summarizeCheckpointTuple",
  ".compile({ checkpointer })",
  "new MemorySaver()",
  "thread_id: runId",
  "harness.checkpointing",
  "recent_langgraph_checkpoints",
  "langgraph_checkpoint_count",
  "GET\" && pathname === \"/api/langgraph-checkpoint\"",
  "GET\" && pathname === \"/api/langgraph-replay\"",
  "POST\" && pathname === \"/api/langgraph-resume\"",
  "function buildLangGraphReplay",
  "function runLangGraphResumeFromCheckpoint",
  "resume_input_json",
  "checkpoint_continuation",
  "LANGGRAPH_REPLAY_UNAVAILABLE",
  "LANGGRAPH_RESUME_UNAVAILABLE",
  "time_travel"
];

const requiredSmokeSnippets = [
  "checkpointing?.enabled === true",
  "MemorySaver",
  "agentRunAudit.checkpoints",
  "langgraphCheckpoint.time_travel",
  "langgraphReplay.replay",
  "resumedAgent.payload.harness",
  "checkpoint_continuation",
  "langgraph_checkpoint_count",
  "recent_langgraph_checkpoints"
];

const combinedDocs = `${readme}\n${architectureDoc}`;
const requiredDocSnippets = [
  "MemorySaver",
  "langgraph_checkpoints",
  "checkpointing",
  "langgraph_checkpoint_payloads",
  "recent_langgraph_checkpoints",
  "/api/langgraph-checkpoint",
  "/api/langgraph-replay",
  "/api/langgraph-resume",
  "checkpoint summary replay",
  "checkpoint_continuation",
  "input_snapshot_reexecution",
  "read-only time-travel"
];

const missingServerSnippets = requiredServerSnippets.filter((snippet) => !serverSource.includes(snippet));
const missingSmokeSnippets = requiredSmokeSnippets.filter((snippet) => !smokeSource.includes(snippet));
const missingDocSnippets = requiredDocSnippets.filter((snippet) => !combinedDocs.includes(snippet));

if (missingDependencies.length || missingServerSnippets.length || missingSmokeSnippets.length || missingDocSnippets.length) {
  console.error(JSON.stringify({
    missingDependencies,
    missingServerSnippets,
    missingSmokeSnippets,
    missingDocSnippets
  }, null, 2));
  throw new Error("LangGraph checkpoint contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  dependencies: 1,
  serverSnippets: requiredServerSnippets.length,
  smokeSnippets: requiredSmokeSnippets.length,
  docSnippets: requiredDocSnippets.length
}, null, 2));
