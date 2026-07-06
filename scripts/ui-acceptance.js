import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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
  await closeServer(server);
  return String(port);
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

async function request(baseUrl, route, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, expectJson = true, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: {
        "content-type": "application/json",
        ...(fetchOptions.headers || {})
      },
      ...fetchOptions,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${fetchOptions.method || "GET"} ${route} failed: ${response.status} ${text}`);
    }
    return expectJson ? JSON.parse(text) : { text, headers: response.headers };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${fetchOptions.method || "GET"} ${route} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer(child, baseUrl) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const health = await request(baseUrl, "/api/health");
      if (health.status === "ok") return health;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server did not become healthy: ${lastError?.message || "timeout"}`);
}

function assertServedFrontend({ html, appSource, stylesSource }) {
  assert(html.includes('<div id="app"></div>'), "served HTML is missing app mount");
  assert(html.includes('src="/app.js"'), "served HTML is missing app.js module script");
  assert(appSource.includes("function renderRuntimeStatus"), "served app is missing runtime status renderer");
  assert(appSource.includes("function renderMemoryManager"), "served app is missing memory manager renderer");
  assert(appSource.includes("Long-term memory"), "served app is missing long-term memory UI copy");
  assert(appSource.includes("data-memory-action=\"confirm\""), "served app is missing memory confirmation action");
  assert(appSource.includes("data-harness-run"), "served app is missing harness audit action");
  assert(stylesSource.includes(".runtime-status"), "served styles are missing runtime status styling");
  assert(stylesSource.includes(".memory-manager"), "served styles are missing memory manager styling");
}

function assertUiDataContract({ project, agent, memory, evaluation, harnessAudit }) {
  assert(project?.id, "sample import did not return a project id");
  assert(project.summary?.safetyReview, "project summary did not include import safety review for overview UI");

  const payload = agent.payload || {};
  assert(Array.isArray(payload.trace) && payload.trace.length >= 8, "agent payload does not include renderable trace");
  assert(payload.harness?.runtime === "LangGraph StateGraph", "agent payload does not include LangGraph harness status");
  assert(payload.harness?.run_id, "agent payload does not include harness run id");
  assert(payload.memory_used && typeof payload.memory_used.summary === "string", "agent payload does not include memory status");
  assert(Array.isArray(payload.memory_suggestions), "agent payload does not include memory suggestions");
  assert(payload.safety?.status, "agent payload does not include safety status");
  assert(Array.isArray(payload.guardrails), "agent payload does not include guardrails");

  assert(memory?.preferences, "memory API does not include preferences for inspector UI");
  assert(Array.isArray(memory.suggestions), "memory API does not include suggestions for inspector UI");
  assert(Array.isArray(memory.events), "memory API does not include audit events for inspector UI");
  assert(Array.isArray(memory.long_term_memories), "memory API does not include long-term memories for inspector UI");

  assert(Number.isFinite(evaluation?.metrics?.agent_runs), "evaluation API does not include dashboard agent run count");
  assert(Array.isArray(evaluation.metrics.recent_harness_runs), "evaluation API does not include recent harness runs");
  assert(Array.isArray(evaluation.metrics.recent_safety_events), "evaluation API does not include recent safety events");

  assert(harnessAudit?.run?.run_id === payload.harness.run_id, "harness audit API did not return the requested run");
  assert(Array.isArray(harnessAudit.answer?.trace), "harness audit API does not include answer trace for dashboard panel");
}

async function run() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-ui-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OPENAI_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const health = await waitForServer(child, baseUrl);
    assert(health.node.startsWith("v24."), "UI acceptance must run on the Node 24 runtime declared by the project");

    const html = await request(baseUrl, "/", { expectJson: false });
    const app = await request(baseUrl, "/app.js", { expectJson: false });
    const styles = await request(baseUrl, "/styles.css", { expectJson: false });
    assertServedFrontend({
      html: html.text,
      appSource: app.text,
      stylesSource: styles.text
    });

    const imported = await request(baseUrl, "/api/import", {
      method: "POST",
      body: JSON.stringify({ sample: true })
    });
    const project = imported.project;

    const agent = await request(baseUrl, "/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        question: "As a product manager, use concise Chinese and analyze the impact of adding partially_refunded order status."
      })
    });

    const pending = agent.payload.memory_suggestions.find((item) => item.status === "pending");
    if (pending) {
      await request(baseUrl, "/api/memory/confirm", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id, suggestionId: pending.id })
      });
    }

    const memory = await request(baseUrl, `/api/memory?projectId=${encodeURIComponent(project.id)}`);
    const evaluation = await request(baseUrl, `/api/evaluation?projectId=${encodeURIComponent(project.id)}`);
    const harnessAudit = await request(
      baseUrl,
      `/api/harness-run?projectId=${encodeURIComponent(project.id)}&runId=${encodeURIComponent(agent.payload.harness.run_id)}`
    );

    assertUiDataContract({
      project,
      agent,
      memory,
      evaluation,
      harnessAudit
    });

    console.log(JSON.stringify({
      ok: true,
      projectId: project.id,
      servedAssets: ["index.html", "app.js", "styles.css"],
      agentRunId: agent.payload.harness.run_id,
      traceSteps: agent.payload.trace.length,
      memorySuggestions: agent.payload.memory_suggestions.length,
      longTermMemories: memory.long_term_memories.length,
      dashboardRuns: evaluation.metrics.agent_runs
    }, null, 2));
  } catch (error) {
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

await run();
