import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Pins down the relationship between AGENT_MAX_REVISION_ROUNDS and both
// lib/agent-graph.js's computeGraphRecursionLimit() and the effective,
// revision-aware step budget (AGENT_BUDGETS.max_steps + REVISION_ROUND_NODE_COUNT
// * AGENT_MAX_REVISION_ROUNDS) that buildAgentHarnessReport() computes for
// step_budget_exceeded.
//
// Both bugs this guards against were found by an independent review, not by
// the author of the revise loop itself:
//   1. recursionLimit was originally derived from AGENT_MAX_STEPS (a budget
//      that has nothing to do with LangGraph's own internal superstep count),
//      not from AGENT_MAX_REVISION_ROUNDS (the thing that actually grows it).
//      At AGENT_MAX_REVISION_ROUNDS=3 the old formula (Math.max(25,
//      AGENT_BUDGETS.max_steps * 3) = 42) undershot the real requirement (43
//      superstepts: 19 baseline + 8*3 per revise round), and LangGraph threw
//      "Recursion limit of 42 reached" -- the entire multi-agent run was
//      discarded and replaced with the deterministic fallback, silently
//      reporting revision_rounds: 0 instead of 3.
//   2. AGENT_BUDGETS.max_steps (14) does not grow with AGENT_MAX_REVISION_ROUNDS,
//      so a healthy run that used its revise-round budget (e.g. R=2 ->
//      trace_length 17) was mislabeled step_budget_exceeded: true, polluting
//      lib/metrics.js's budgetStatusCounts bucket.
//
// This script proves both are fixed by running the SAME deterministic,
// offline (no API key), perpetually-revising project/question at
// AGENT_MAX_REVISION_ROUNDS = 0, 1, 2, and 3, asserting for each: no
// "Recursion limit" error, revision_rounds exactly matches the configured
// round count, trace_length exactly matches 9 + 4*R, and
// step_budget_exceeded stays false.

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestTo(baseUrl, route, options = {}) {
  const { timeoutMs = 20_000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: { "content-type": "application/json", ...(fetchOptions.headers || {}) },
      ...fetchOptions,
      signal: controller.signal
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`${options.method || "GET"} ${route} failed: ${response.status} ${JSON.stringify(payload)}`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${fetchOptions.method || "GET"} ${route} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return String(port);
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const health = await requestTo(baseUrl, "/api/health");
      if (health.status === "ok") return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server did not become healthy: ${lastError?.message || "timeout"}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

function createZipBase64(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const name = Buffer.from(filePath, "utf8");
    const body = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, end]).toString("base64");
}

// Same "unfixable" project scripts/check-revise-loop.js uses for its own
// termination proof: nothing in it ever matches any query (not the question,
// not the Supervisor's fixed template queries, not the QACritic's fixed
// additional_queries), so the deterministic critic returns verdict="revise"
// forever -- guaranteeing the loop always consumes its ENTIRE configured
// round budget, every time, for a precise trace_length = 9 + 4*R at every R.
const UNFIXABLE_PROJECT_FILES = {
  "docs/weather-notes.txt": "Weather patterns are influenced by ocean currents and atmospheric pressure zones across different seasons"
};
const QUESTION = "As a PM, what should I double check before removing the legacy logging helper?";

async function runAtRoundBudget(rounds) {
  const dataDir = await mkdtemp(path.join(tmpdir(), `ai-pm-recursion-scaling-r${rounds}-`));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "",
      AGENT_MAX_REVISION_ROUNDS: String(rounds)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForServer(baseUrl, child);
    const imported = await requestTo(baseUrl, "/api/import", {
      method: "POST",
      body: JSON.stringify({ zipBase64: createZipBase64(UNFIXABLE_PROJECT_FILES), fileName: `r${rounds}.zip` })
    });
    const projectId = imported.project?.id;
    assert(projectId, `[R=${rounds}] import did not return a project id`);
    const answer = await requestTo(baseUrl, "/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({ projectId, question: QUESTION })
    });
    return answer;
  } catch (error) {
    console.error(`[R=${rounds}] stdout:\n${stdout}`);
    console.error(`[R=${rounds}] stderr:\n${stderr}`);
    throw error;
  } finally {
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const results = [];
  for (const rounds of [0, 1, 2, 3]) {
    console.log(`[progress] running AGENT_MAX_REVISION_ROUNDS=${rounds}...`);
    const answer = await runAtRoundBudget(rounds);
    const harness = answer.payload.harness;
    const errors = harness.errors || [];
    const hasRecursionError = errors.some((message) => /Recursion limit/i.test(message));
    const expectedTraceLength = 9 + 4 * rounds;

    assert(!hasRecursionError, `[R=${rounds}] hit a LangGraph recursion-limit error: ${JSON.stringify(errors)}`);
    assert(harness.revision_rounds === rounds, `[R=${rounds}] expected revision_rounds === ${rounds}, got ${harness.revision_rounds}`);
    assert(answer.payload.trace.length === expectedTraceLength,
      `[R=${rounds}] expected trace length ${expectedTraceLength}, got ${answer.payload.trace.length}`);
    assert(harness.budget_status.step_budget_exceeded === false,
      `[R=${rounds}] a healthy run that used its full configured revise-round budget must not be flagged step_budget_exceeded, got true (steps_executed=${harness.budget_status.steps_executed}, effective_max_steps=${harness.budget_status.effective_max_steps})`);
    assert(answer.payload.critic_review?.verdict === "revise",
      `[R=${rounds}] the unfixable project should never resolve the verdict, got "${answer.payload.critic_review?.verdict}"`);
    assert(harness.revision_budget_exhausted === true,
      `[R=${rounds}] the harness must report the revise loop as budget-exhausted (the critic never approved)`);

    results.push({
      rounds,
      revision_rounds: harness.revision_rounds,
      trace_length: answer.payload.trace.length,
      effective_max_steps: harness.budget_status.effective_max_steps,
      step_budget_exceeded: harness.budget_status.step_budget_exceeded,
      recursion_limit_error: hasRecursionError
    });
    console.log(`[progress] R=${rounds} OK: trace_length=${answer.payload.trace.length}, effective_max_steps=${harness.budget_status.effective_max_steps}, step_budget_exceeded=${harness.budget_status.step_budget_exceeded}`);
  }

  console.log(JSON.stringify({ ok: true, scenario: "recursion-limit-and-step-budget-scale-with-agent-max-revision-rounds", results }, null, 2));
}

await main();
