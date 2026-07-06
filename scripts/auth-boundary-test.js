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
  const { timeoutMs = REQUEST_TIMEOUT_MS, expectOk = true, token = null, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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

async function run() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-auth-"));
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
      AI_PM_AUTH_REQUIRED: "true",
      AI_PM_USER_TOKENS: JSON.stringify({
        "token-a": "user-a",
        "token-b": "user-b",
        "viewer-token": {
          userId: "viewer",
          role: "viewer",
          scopes: ["project:read"]
        }
      })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(child, baseUrl);
    const { payload: health } = await request(baseUrl, "/api/health");
    assert(health.auth?.required === true, "health did not report auth required");
    assert(health.auth?.token_count === 3, "health did not report configured auth tokens");
    assert(health.auth?.scopes_enabled === true, "health did not report auth scopes enabled");

    const missingAuth = await request(baseUrl, "/api/projects", { expectOk: false });
    assert(missingAuth.status === 401, "missing auth should return 401");
    assert(missingAuth.payload.code === "AUTH_REQUIRED", "missing auth did not return AUTH_REQUIRED");

    const invalidAuth = await request(baseUrl, "/api/projects", { token: "bad-token", expectOk: false });
    assert(invalidAuth.status === 401, "invalid auth should return 401");
    assert(invalidAuth.payload.code === "AUTH_INVALID", "invalid auth did not return AUTH_INVALID");

    const viewerRead = await request(baseUrl, "/api/projects", { token: "viewer-token" });
    assert(Array.isArray(viewerRead.payload.projects), "viewer token should be allowed to read projects");

    const viewerWrite = await request(baseUrl, "/api/import", {
      method: "POST",
      token: "viewer-token",
      expectOk: false,
      body: JSON.stringify({ sample: true })
    });
    assert(viewerWrite.status === 403, "viewer token should not import projects");
    assert(viewerWrite.payload.code === "AUTH_SCOPE_FORBIDDEN", "viewer write did not return AUTH_SCOPE_FORBIDDEN");
    assert(viewerWrite.payload.required_scope === "project:write", "viewer write did not report required project:write scope");
    assert(viewerWrite.payload.auth?.role === "viewer", "viewer write did not report auth role");

    const { payload: imported } = await request(baseUrl, "/api/import", {
      method: "POST",
      token: "token-a",
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project.id;

    const impersonation = await request(baseUrl, "/api/agent-impact", {
      method: "POST",
      token: "token-a",
      expectOk: false,
      body: JSON.stringify({
        userId: "user-b",
        projectId,
        question: "As a product manager, use concise risk analysis."
      })
    });
    assert(impersonation.status === 403, "authenticated user mismatch should return 403");
    assert(impersonation.payload.code === "AUTH_USER_MISMATCH", "impersonation did not return AUTH_USER_MISMATCH");

    const { payload: userARun } = await request(baseUrl, "/api/agent-impact", {
      method: "POST",
      token: "token-a",
      body: JSON.stringify({
        projectId,
        question: "As a product manager, use concise answers for release risk analysis."
      })
    });
    const suggestion = userARun.payload.memory_suggestions.find((item) => item.key === "role" && item.value === "Product Manager");
    assert(suggestion?.userId === "user-a", "authenticated user suggestion was not bound to token user");

    const crossUserConfirm = await request(baseUrl, "/api/memory/confirm", {
      method: "POST",
      token: "token-b",
      expectOk: false,
      body: JSON.stringify({ projectId, suggestionId: suggestion.id })
    });
    assert(crossUserConfirm.status === 409, "cross-user confirm should return 409");
    assert(crossUserConfirm.payload.code === "MEMORY_USER_MISMATCH", "cross-user confirm did not return MEMORY_USER_MISMATCH");

    const viewerBackup = await request(baseUrl, "/api/memory/backup", {
      method: "POST",
      token: "viewer-token",
      expectOk: false
    });
    assert(viewerBackup.status === 403, "viewer token should not be allowed to create memory backups");
    assert(viewerBackup.payload.code === "AUTH_SCOPE_FORBIDDEN", "viewer backup did not return AUTH_SCOPE_FORBIDDEN");
    assert(viewerBackup.payload.required_scope === "memory:write", "viewer backup required wrong scope");

    const { payload: confirmed } = await request(baseUrl, "/api/memory/confirm", {
      method: "POST",
      token: "token-a",
      body: JSON.stringify({ projectId, suggestionId: suggestion.id })
    });
    assert(confirmed.user_id === "user-a", "confirmed memory was not attributed to user-a");
    assert(confirmed.preferences.role === "Product Manager", "confirmed preference missing for authenticated user");

    console.log(JSON.stringify({
      ok: true,
      projectId,
      authRequired: health.auth.required,
      user: confirmed.user_id
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
