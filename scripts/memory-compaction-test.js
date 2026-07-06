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
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
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
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`${fetchOptions.method || "GET"} ${route} failed: ${response.status} ${JSON.stringify(payload)}`);
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

async function waitForServer(child, baseUrl) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const health = await request(baseUrl, "/api/health");
      if (health.status === "ok") return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server did not become healthy: ${lastError?.message || "timeout"}`);
}

async function confirmSuggestion(baseUrl, projectId, suggestion) {
  return request(baseUrl, "/api/memory/confirm", {
    method: "POST",
    body: JSON.stringify({ projectId, suggestionId: suggestion.id })
  });
}

async function run() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-memory-"));
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
    await waitForServer(child, baseUrl);
    const imported = await request(baseUrl, "/api/import", {
      method: "POST",
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project.id;

    const pmRun = await request(baseUrl, "/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        question: "As a product manager, I prefer concise answers for order status impact analysis."
      })
    });
    const pmRole = pmRun.payload.memory_suggestions.find((item) => item.key === "role" && item.value === "Product Manager");
    assert(pmRole, "PM role suggestion was not generated");
    await confirmSuggestion(baseUrl, projectId, pmRole);

    const qaRun = await request(baseUrl, "/api/chat", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        kind: "qa",
        question: "As QA, I prefer detailed testing-focused answers for checkout risk reviews."
      })
    });
    const qaRole = qaRun.payload.memory_suggestions.find((item) => item.key === "role" && item.value === "QA");
    assert(qaRole, "QA role suggestion was not generated");
    await confirmSuggestion(baseUrl, projectId, qaRole);

    const active = await request(baseUrl, `/api/memory?projectId=${encodeURIComponent(projectId)}&status=active&q=${encodeURIComponent("QA Product Manager profile")}&limit=10`);
    const superseded = await request(baseUrl, `/api/memory?projectId=${encodeURIComponent(projectId)}&status=superseded&q=${encodeURIComponent("Product Manager")}&limit=10`);
    const all = await request(baseUrl, `/api/memory?projectId=${encodeURIComponent(projectId)}&status=all&q=${encodeURIComponent("profile")}&limit=10`);

    assert(active.long_term_memories.some((item) => item.key === "role" && item.value === "QA" && item.status === "active"), "active QA role memory missing");
    assert(!active.long_term_memories.some((item) => item.key === "role" && item.value === "Product Manager" && item.status === "active"), "old PM role memory remained active");
    assert(active.long_term_memory_query.embedding_model === "local-hash-v1", "memory query did not expose embedding model");
    assert(active.long_term_memory_query.vector_search === true, "memory query did not report vector search");
    assert(active.long_term_memories.every((item) => item.embedding?.available === true), "active long-term memories missing embedding metadata");
    assert(superseded.long_term_memory_query.status === "superseded", "superseded memory query did not report superseded status");
    assert(superseded.long_term_memories.some((item) => item.key === "role" && item.value === "Product Manager" && item.status === "superseded"), "old PM role memory was not superseded");
    assert(all.long_term_memories.some((item) => item.type === "preference_summary" && item.source === "memory_compaction" && item.value.includes("role=QA")), "compressed preference summary missing active QA role");

    console.log(JSON.stringify({
      ok: true,
      projectId,
      activeMemories: active.long_term_memories.length,
      supersededMemories: superseded.long_term_memories.length,
      summaryMemories: all.long_term_memories.filter((item) => item.type === "preference_summary").length
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
