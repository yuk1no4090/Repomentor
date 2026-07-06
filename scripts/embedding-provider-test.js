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

function createEmbedding(input) {
  const text = String(input || "").toLowerCase();
  const vector = Array.from({ length: 64 }, (_, index) => {
    const charCode = text.charCodeAt(index % Math.max(text.length, 1)) || 0;
    return ((charCode + index) % 17) / 17;
  });
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

async function startFakeEmbeddingServer() {
  let requestCount = 0;
  const seenModels = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    requestCount += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    seenModels.push(body.model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: createEmbedding(body.input) }],
      model: body.model
    }));
  });
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    getRequestCount: () => requestCount,
    getSeenModels: () => seenModels
  };
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

async function run() {
  const fakeEmbedding = await startFakeEmbeddingServer();
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-embedding-"));
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
      MEMORY_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDING_API_KEY: "fake-embedding-key",
      OPENAI_EMBEDDING_BASE_URL: fakeEmbedding.baseUrl,
      OPENAI_EMBEDDING_MODEL: "fake-embedding-model"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const health = await waitForServer(child, baseUrl);
    assert(health.memory_embedding.provider === "openai-compatible", "health did not report external embedding provider");
    assert(health.memory_embedding.model === "fake-embedding-model", "health did not report fake embedding model");

    const imported = await request(baseUrl, "/api/import", {
      method: "POST",
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project.id;
    const agent = await request(baseUrl, "/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        question: "As QA, I prefer detailed testing-focused answers for checkout risk reviews."
      })
    });
    const qaRole = agent.payload.memory_suggestions.find((item) => item.key === "role" && item.value === "QA");
    assert(qaRole, "QA role suggestion was not generated");
    const confirmed = await request(baseUrl, "/api/memory/confirm", {
      method: "POST",
      body: JSON.stringify({ projectId, suggestionId: qaRole.id })
    });
    assert(confirmed.long_term_memory.embedding.model === "fake-embedding-model", "confirmed memory did not use external embedding model");
    assert(confirmed.long_term_memory.embedding.dims === 64, "confirmed memory embedding dims were not preserved");

    const memory = await request(baseUrl, `/api/memory?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent("testing QA checkout")}`);
    assert(memory.long_term_memory_query.embedding_provider === "openai-compatible", "memory query did not report external embedding provider");
    assert(memory.long_term_memory_query.embedding_model === "fake-embedding-model", "memory query did not report external embedding model");
    assert(memory.long_term_memories.some((item) => item.embedding?.model === "fake-embedding-model"), "external embedding memory was not retrieved");
    assert(fakeEmbedding.getRequestCount() >= 3, "fake embedding server was not called for write and query paths");
    assert(fakeEmbedding.getSeenModels().every((model) => model === "fake-embedding-model"), "fake embedding server received wrong model");

    console.log(JSON.stringify({
      ok: true,
      projectId,
      embeddingRequests: fakeEmbedding.getRequestCount(),
      embeddingModel: memory.long_term_memory_query.embedding_model
    }, null, 2));
  } catch (error) {
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    await stopChild(child);
    await closeServer(fakeEmbedding.server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

await run();
