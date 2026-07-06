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
  const { timeoutMs = REQUEST_TIMEOUT_MS, expectOk = true, ...fetchOptions } = options;
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
    if (expectOk && !response.ok) {
      throw new Error(`${fetchOptions.method || "GET"} ${route} failed: ${response.status} ${JSON.stringify(payload)}`);
    }
    return { status: response.status, payload };
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
      const { payload } = await request(baseUrl, "/api/health");
      if (payload.status === "ok") return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server did not become healthy: ${lastError?.message || "timeout"}`);
}

async function confirmSuggestion(baseUrl, projectId, suggestion, userId, expectOk = true) {
  return request(baseUrl, "/api/memory/confirm", {
    method: "POST",
    headers: { "X-User-Id": userId },
    expectOk,
    body: JSON.stringify({ projectId, suggestionId: suggestion.id })
  });
}

async function run() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-user-memory-"));
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
    const { payload: imported } = await request(baseUrl, "/api/import", {
      method: "POST",
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project.id;

    const { payload: userARun } = await request(baseUrl, "/api/agent-impact", {
      method: "POST",
      headers: { "X-User-Id": "user-a" },
      body: JSON.stringify({
        projectId,
        question: "As a product manager, use concise Chinese answers for release risk analysis."
      })
    });
    const userARole = userARun.payload.memory_suggestions.find((item) => item.key === "role" && item.value === "Product Manager");
    assert(userARole?.userId === "user-a", "user A role suggestion was not scoped to user-a");

    const mismatch = await confirmSuggestion(baseUrl, projectId, userARole, "user-b", false);
    assert(mismatch.status === 409, "cross-user memory confirmation should be rejected");
    assert(mismatch.payload.code === "MEMORY_USER_MISMATCH", "cross-user confirmation did not return MEMORY_USER_MISMATCH");

    await confirmSuggestion(baseUrl, projectId, userARole, "user-a");

    const { payload: userBMemoryBefore } = await request(baseUrl, `/api/memory?projectId=${encodeURIComponent(projectId)}`, {
      headers: { "X-User-Id": "user-b" }
    });
    assert(userBMemoryBefore.preferences.role === null, "user B inherited user A role preference");
    assert(!userBMemoryBefore.long_term_memories.some((item) => item.value === "Product Manager"), "user B saw user A long-term memory");

    const { payload: userBRun } = await request(baseUrl, "/api/chat", {
      method: "POST",
      headers: { "X-User-Id": "user-b" },
      body: JSON.stringify({
        projectId,
        kind: "qa",
        question: "As QA, I prefer detailed testing-focused answers for checkout risk reviews."
      })
    });
    const userBRole = userBRun.payload.memory_suggestions.find((item) => item.key === "role" && item.value === "QA");
    assert(userBRole?.userId === "user-b", "user B role suggestion was not scoped to user-b");
    await confirmSuggestion(baseUrl, projectId, userBRole, "user-b");

    const { payload: userAMemory } = await request(baseUrl, `/api/memory?projectId=${encodeURIComponent(projectId)}&status=active&q=${encodeURIComponent("Product Manager QA")}`, {
      headers: { "X-User-Id": "user-a" }
    });
    const { payload: userBMemory } = await request(baseUrl, `/api/memory?projectId=${encodeURIComponent(projectId)}&status=active&q=${encodeURIComponent("Product Manager QA")}`, {
      headers: { "X-User-Id": "user-b" }
    });

    assert(userAMemory.preferences.role === "Product Manager", "user A role preference was not retained");
    assert(userBMemory.preferences.role === "QA", "user B role preference was not retained");
    assert(userAMemory.long_term_memories.some((item) => item.value === "Product Manager"), "user A long-term role memory missing");
    assert(!userAMemory.long_term_memories.some((item) => item.value === "QA"), "user A saw user B long-term memory");
    assert(userBMemory.long_term_memories.some((item) => item.value === "QA"), "user B long-term role memory missing");
    assert(!userBMemory.long_term_memories.some((item) => item.value === "Product Manager"), "user B saw user A long-term memory");

    console.log(JSON.stringify({
      ok: true,
      projectId,
      userA: {
        role: userAMemory.preferences.role,
        memories: userAMemory.long_term_memories.length
      },
      userB: {
        role: userBMemory.preferences.role,
        memories: userBMemory.long_term_memories.length
      }
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
