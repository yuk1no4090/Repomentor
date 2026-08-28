import { readFile } from "node:fs/promises";
import { readServerSource } from "./shared/source-reader.js";

// SLIM-A consolidation note: this file used to also pin the MemorySaver
// import, the langgraph_checkpoints/langgraph_checkpoint_payloads table DDL,
// every persist/serialize/deserialize/load/list/find/summarize function name,
// the GET /api/langgraph-checkpoint, GET /api/langgraph-replay, and POST
// /api/langgraph-resume route strings, and the checkpoint_continuation/
// harness.checkpointing/recent_langgraph_checkpoints/langgraph_checkpoint_count/
// time_travel fields against server source. All of that is now proven --
// more strongly, through the real call path -- by scripts/smoke-test.js and
// check-hitl-resume-behavior.js (behavioral, untouchable): both spawn the
// real server, persist real checkpoints across a real multi-phase run, and
// call all three endpoints for real, asserting the exact real
// checkpointing.enabled/langgraph_checkpoint_count/recent_langgraph_checkpoints
// fields, the real time_travel note, and the real resume.mode values
// including "checkpoint_continuation" -- this file's requiredSmokeSnippets
// section below is a test-gutting guard on that behavioral source, not a
// duplicate of it.
//
// What remains here is what neither proves: (1) the package.json dependency
// declaration; (2) LANGGRAPH_REPLAY_UNAVAILABLE / LANGGRAPH_RESUME_UNAVAILABLE
// and resume_input_json -- no behavioral check ever drives the actual
// unavailable-replay/unavailable-resume failure path (only the healthy path
// is exercised), so these three have no other guard; (3) the
// `.compile({ checkpointer })` wiring shape, an explicit CAREFUL EXCEPTION
// (a unit test of the graph-building code cannot see this compile-time
// shape, and no behavioral check greps for it either -- it can only be
// observed by inspecting the source); (4) doc-sync.

const [packageJsonRaw, serverSource, smokeSource, readme, architectureDoc] = await Promise.all([
  readFile("package.json", "utf8"),
  readServerSource(),
  readFile("scripts/smoke-test.js", "utf8"),
  readFile("README.md", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8")
]);

const packageJson = JSON.parse(packageJsonRaw);

const missingDependencies = ["@langchain/langgraph-checkpoint"].filter((name) => !packageJson.dependencies?.[name]);

const requiredServerSnippets = [
  "resume_input_json",
  "LANGGRAPH_REPLAY_UNAVAILABLE",
  "LANGGRAPH_RESUME_UNAVAILABLE"
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

// Whitespace-tolerant: asserts the graph is compiled with a checkpointer without
// pinning the exact spacing/formatting of the call (e.g. `.compile({checkpointer})`
// and `.compile({ checkpointer })` should both satisfy this).
const compilesWithCheckpointer = /\.compile\(\{\s*checkpointer\s*\}\)/.test(serverSource);

if (
  missingDependencies.length
  || missingServerSnippets.length
  || missingSmokeSnippets.length
  || missingDocSnippets.length
  || !compilesWithCheckpointer
) {
  console.error(JSON.stringify({
    missingDependencies,
    missingServerSnippets,
    missingSmokeSnippets,
    missingDocSnippets,
    compilesWithCheckpointer
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
