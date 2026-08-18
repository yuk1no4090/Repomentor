import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Manual-only concurrency regression check for the lock-granularity refactor
// in server.js (see loadStoreWithAuthGate()/isHeavyMutationRoute() there).
// This is deliberately NOT named `check-*.js`: scripts/static-checks.js
// auto-discovers every scripts/check-*.js file and wires it into
// `npm run test:static` (and therefore `npm test` / CI), and this script
// takes several real wall-clock seconds by design (it has to actually hold a
// slow LLM call open to prove other requests aren't blocked behind it), which
// would slow down every CI run for a property that doesn't need to be
// re-checked on every commit.
//
// Run manually after touching server.js's request locking:
//   node scripts/concurrency-smoke.js
//
// What it proves: before this refactor, handleApi() wrapped the ENTIRE
// request — including the 30s-class LLM/LangGraph call inside
// POST /api/agent-impact, /api/chat, /api/onboarding, /api/langgraph-resume —
// in a single global withWriteLock(). That meant one slow agent-impact
// request serialized every other POST (and, once AUTH_REQUIRED, every GET)
// behind it for the full duration of the LLM call. After the refactor, only
// short store read-modify-write critical sections are locked, so a slow
// agent-impact request in flight must not block a concurrent lightweight
// GET/POST for anywhere close to its own duration.

const REQUEST_TIMEOUT_MS = 15_000;
const SLOW_LLM_DELAY_MS = 3_000;
// How long a lightweight request is allowed to take while the slow request
// is still in flight. Old (fully-serialized) behavior would make the
// lightweight request wait out most of SLOW_LLM_DELAY_MS before even
// starting its own (near-instant) work; new behavior should resolve it in a
// handful of milliseconds. This threshold sits comfortably between the two.
const LIGHT_REQUEST_THRESHOLD_MS = 1_500;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestTo(baseUrl, requestPath, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${requestPath}`, {
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
      throw new Error(`${options.method || "GET"} ${requestPath} failed: ${response.status} ${JSON.stringify(payload)}`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${fetchOptions.method || "GET"} ${requestPath} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function timed(label, fn) {
  const started = Date.now();
  const payload = await fn();
  return { label, payload, durationMs: Date.now() - started };
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

async function waitForServer(child, baseUrl) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const health = await requestTo(baseUrl, "/api/health", { timeoutMs: 2_000 });
      if (health.status === "ok") return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server did not become healthy: ${lastError?.message || "timeout"}`);
}

// A fake OpenAI-compatible chat-completions endpoint that deliberately holds
// every request open for SLOW_LLM_DELAY_MS before responding — standing in
// for a slow real-world LLM call so the smoke test doesn't need a live API
// key or a real 30s wait.
function startSlowFakeLlmServer(delayMs) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    for await (const _chunk of req) {
      // drain the request body; content doesn't matter for this smoke test
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "Slow fake LLM response for the concurrency smoke test.",
            impact_areas: [{
              area: "Orders",
              risk_level: "low",
              reason: "Synthetic response used to hold the request open for the configured delay.",
              files: ["src/models/order.ts"]
            }],
            testing_suggestions: ["n/a"],
            open_questions: []
          })
        }
      }]
    }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function main() {
  const fakeLlm = await startSlowFakeLlmServer(SLOW_LLM_DELAY_MS);
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-concurrency-smoke-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "fake-concurrency-smoke-key",
      OPENAI_BASE_URL: fakeLlm.baseUrl,
      OPENAI_MODEL: "fake-slow-model",
      // Comfortably larger than SLOW_LLM_DELAY_MS so the fake LLM's own delay
      // doesn't trip runModelAdapter's internal per-call timeout — we want
      // the slow *response*, not a timeout/fallback, so the request stays
      // "in flight" for the full delay.
      LLM_REQUEST_TIMEOUT_MS: String(SLOW_LLM_DELAY_MS + 10_000)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(child, baseUrl);
    const imported = await requestTo(baseUrl, "/api/import", {
      method: "POST",
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project?.id;
    assert(projectId, "sample import did not return a project id");

    const slow = timed("slow_agent_impact", () => requestTo(baseUrl, "/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        question: "What is the impact of changing order status transitions?"
      }),
      timeoutMs: REQUEST_TIMEOUT_MS
    }));

    // Give the slow request a brief head start so the "light" requests below
    // are genuinely fired while its LLM call is in flight, not before the
    // slow request has even reached the lock/compute phase.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const lightGet = timed("light_get_projects", () => requestTo(baseUrl, "/api/projects", {
      timeoutMs: REQUEST_TIMEOUT_MS
    }));
    const lightPost = timed("light_post_onboarding", () => requestTo(baseUrl, "/api/onboarding", {
      method: "POST",
      body: JSON.stringify({ projectId, role: "Backend Engineer", duration: "3 days" }),
      timeoutMs: REQUEST_TIMEOUT_MS
    }));

    const [slowResult, lightGetResult, lightPostResult] = await Promise.all([slow, lightGet, lightPost]);

    assert(slowResult.payload.payload.harness.model_adapter.llm_used === true, "slow agent-impact request should have used the fake LLM response");
    assert(slowResult.durationMs >= SLOW_LLM_DELAY_MS, `slow request should take at least ${SLOW_LLM_DELAY_MS}ms (took ${slowResult.durationMs}ms) — otherwise the fake LLM delay isn't actually being exercised`);
    assert(lightGetResult.durationMs < LIGHT_REQUEST_THRESHOLD_MS, `GET /api/projects should not be blocked behind the slow agent-impact request (took ${lightGetResult.durationMs}ms, threshold ${LIGHT_REQUEST_THRESHOLD_MS}ms)`);
    assert(lightPostResult.durationMs < LIGHT_REQUEST_THRESHOLD_MS, `POST /api/onboarding should not be blocked behind the slow agent-impact request (took ${lightPostResult.durationMs}ms, threshold ${LIGHT_REQUEST_THRESHOLD_MS}ms)`);

    const summary = {
      ok: true,
      slow_llm_delay_ms: SLOW_LLM_DELAY_MS,
      light_request_threshold_ms: LIGHT_REQUEST_THRESHOLD_MS,
      slow_agent_impact_ms: slowResult.durationMs,
      light_get_projects_ms: lightGetResult.durationMs,
      light_post_onboarding_ms: lightPostResult.durationMs
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(stdout);
    console.error(stderr);
    throw error;
  } finally {
    await stopChild(child);
    await closeServer(fakeLlm.server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
