import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// N7 Item 1: AGENT_GRAPH_MODE=linear compiles a hardwired node chain with NO
// supervisor routing, NO QACritic revise loop, and NO human_review node --
// every HITL trigger signal is structurally inert in that mode regardless of
// AGENT_HITL_ENABLED. server.js's server.listen() callback now emits a
// one-time console.warn (stderr) naming exactly what is disabled when the
// effective mode is linear, and stays silent in supervisor mode (the
// default) so the happy path has zero extra noise.
//
// This script proves that behaviorally by spawning the real server.js
// process (same pattern as scripts/check-recursion-limit-scaling.js) under
// three configurations and inspecting its actual stderr output:
//   1. AGENT_GRAPH_MODE=linear                        -> warning present
//   2. AGENT_GRAPH_MODE=linear, AGENT_HITL_ENABLED=true -> warning present
//      AND the stronger "has no effect" sentence is present
//   3. AGENT_GRAPH_MODE unset (default supervisor)     -> warning absent

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function requestTo(baseUrl, route, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, { signal: controller.signal });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
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

async function runServer(label, extraEnv) {
  const dataDir = await mkdtemp(path.join(tmpdir(), `ai-pm-linear-warn-${label}-`));
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
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForServer(baseUrl, child);
    return { stdout, stderr };
  } catch (error) {
    console.error(`[${label}] stdout:\n${stdout}`);
    console.error(`[${label}] stderr:\n${stderr}`);
    throw error;
  } finally {
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("[progress] spawning server with AGENT_GRAPH_MODE=linear...");
  const linear = await runServer("linear", { AGENT_GRAPH_MODE: "linear" });
  assert(/AGENT_GRAPH_MODE=linear/.test(linear.stderr),
    `linear-mode stderr must contain the startup warning, got:\n${linear.stderr}`);
  assert(/supervisor routing/.test(linear.stderr) && /revise loop/.test(linear.stderr) && /human_review/.test(linear.stderr),
    `linear-mode warning must name supervisor routing, the revise loop, and human_review, got:\n${linear.stderr}`);
  assert(!/has no effect in linear mode/.test(linear.stderr),
    `linear-mode-without-HITL stderr must NOT contain the stronger AGENT_HITL_ENABLED sentence, got:\n${linear.stderr}`);
  console.log("[progress] linear mode: warning present and correctly worded. OK");

  console.log("[progress] spawning server with AGENT_GRAPH_MODE=linear + AGENT_HITL_ENABLED=true...");
  const linearHitl = await runServer("linear-hitl", { AGENT_GRAPH_MODE: "linear", AGENT_HITL_ENABLED: "true" });
  assert(/AGENT_GRAPH_MODE=linear/.test(linearHitl.stderr),
    `linear+HITL stderr must contain the startup warning, got:\n${linearHitl.stderr}`);
  assert(/AGENT_HITL_ENABLED=true has no effect in linear mode/.test(linearHitl.stderr),
    `linear+HITL stderr must contain the stronger "has no effect" sentence, got:\n${linearHitl.stderr}`);
  console.log("[progress] linear + AGENT_HITL_ENABLED=true: stronger warning present. OK");

  console.log("[progress] spawning server with default (supervisor) mode...");
  const supervisor = await runServer("supervisor", {});
  assert(!/AGENT_GRAPH_MODE=linear/.test(supervisor.stderr),
    `supervisor-mode (default) stderr must NOT contain the linear-mode warning, got:\n${supervisor.stderr}`);
  console.log("[progress] supervisor mode (default): zero warning noise. OK");

  console.log(JSON.stringify({
    ok: true,
    scenario: "linear-mode-startup-warning-present-in-linear-absent-in-supervisor",
    linear_warning_present: true,
    linear_hitl_stronger_warning_present: true,
    supervisor_warning_absent: true
  }, null, 2));
}

await main();
