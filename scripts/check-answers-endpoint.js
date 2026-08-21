import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Behavioral regression coverage for GET /api/answers -- the read-only replay
// endpoint public/app.js's restoreConversationHistory() calls to rebuild
// state.messages after a page refresh (see the frontend hash-routing +
// history-restore change this ships alongside). scripts/check-api-docs.js
// only confirms the route exists textually and is documented; it cannot
// catch a wrong questionId join, a limit that doesn't actually cap results,
// or one user's answers leaking into another user's project view. This spins
// up a real server (like scripts/check-hitl-resume-behavior.js and
// scripts/auth-boundary-test.js do) with AUTH_REQUIRED enabled throughout, so
// the same run exercises both the endpoint's data shape and its auth/scope
// boundary rather than needing a second server process for just the scope
// case.

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
  const { timeoutMs = 20_000, expectOk = true, token = null, ...fetchOptions } = options;
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

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-answers-endpoint-"));
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
        "token-b": "user-b"
      })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer(child, baseUrl);

    // ── Setup: user-a imports a project and asks a Q&A question, then an
    // impact question, in that order -- store.answers/store.questions are
    // append-only, so GET /api/answers should replay them back in the same
    // chronological order they were asked. ──
    const { payload: imported } = await request(baseUrl, "/api/import", {
      method: "POST",
      token: "token-a",
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project?.id;
    assert(projectId, "sample import did not return a project id");

    const qaQuestion = "What does this repository do?";
    const { payload: qaAnswer } = await request(baseUrl, "/api/chat", {
      method: "POST",
      token: "token-a",
      body: JSON.stringify({ projectId, question: qaQuestion, kind: "qa" })
    });
    assert(qaAnswer.answerId, "qa question did not return an answerId");

    const impactQuestion = "What is the risk of changing the order refund flow?";
    const { payload: impactAnswer } = await request(baseUrl, "/api/chat", {
      method: "POST",
      token: "token-a",
      body: JSON.stringify({ projectId, question: impactQuestion, kind: "impact" })
    });
    assert(impactAnswer.answerId, "impact question did not return an answerId");

    // Give the qa answer feedback before reading history back, so the
    // reconstructed message can be checked for the same
    // message.feedbackGiven wiring sendFeedback()/feedbackBar() rely on in
    // public/app.js to keep the feedback buttons disabled after a restore.
    await request(baseUrl, "/api/feedback", {
      method: "POST",
      token: "token-a",
      body: JSON.stringify({ answerId: qaAnswer.answerId, type: "helpful" })
    });

    // ── 1. Basic shape + chronological order + question/feedback join ──
    const { payload: history } = await request(baseUrl, `/api/answers?projectId=${encodeURIComponent(projectId)}`, {
      token: "token-a"
    });
    assert(history.projectId === projectId, "response did not echo back projectId");
    assert(Array.isArray(history.answers) && history.answers.length === 2,
      `expected exactly 2 answers, got ${history.answers?.length}`);

    const [first, second] = history.answers;
    assert(first.answerId === qaAnswer.answerId, "first answer should be the qa question (chronological order)");
    assert(first.kind === "qa", `first answer kind should be "qa", got ${first.kind}`);
    assert(first.question === qaQuestion, "first answer's joined question text did not match what was asked");
    assert(first.questionId, "first answer is missing questionId");
    assert(first.feedbackGiven === "helpful", `first answer should report the recorded feedback, got ${first.feedbackGiven}`);
    assert(typeof first.createdAt === "string" && first.createdAt.length > 0, "first answer is missing createdAt");
    assert(first.payload && typeof first.payload === "object", "first answer is missing its payload");
    assert(typeof first.payload.answer === "string", "qa answer payload should carry the deterministic `answer` text");

    assert(second.answerId === impactAnswer.answerId, "second answer should be the impact question");
    assert(second.kind === "impact", `second answer kind should be "impact", got ${second.kind}`);
    assert(second.question === impactQuestion, "second answer's joined question text did not match what was asked");
    assert(second.feedbackGiven === null, "second answer should report no feedback (none was ever submitted)");

    // ── 2. `limit` actually caps the result set to the most recent N ──
    const { payload: limited } = await request(baseUrl, `/api/answers?projectId=${encodeURIComponent(projectId)}&limit=1`, {
      token: "token-a"
    });
    assert(limited.limit === 1, `expected limit to echo back as 1, got ${limited.limit}`);
    assert(limited.answers.length === 1, `limit=1 should return exactly 1 answer, got ${limited.answers.length}`);
    assert(limited.answers[0].answerId === impactAnswer.answerId, "limit=1 should return the most recent answer, not the oldest");

    // A limit above the documented cap (200) must be clamped, not honored
    // verbatim -- otherwise this "protect against abuse" cap in the route
    // (README.md's "capped at 200") is just a comment, not real behavior.
    const { payload: overLimit } = await request(baseUrl, `/api/answers?projectId=${encodeURIComponent(projectId)}&limit=99999`, {
      token: "token-a"
    });
    assert(overLimit.limit === 200, `limit should clamp to 200, got ${overLimit.limit}`);

    // ── 3. Unknown projectId is a real 404, not an empty list ──
    const missingProject = await request(baseUrl, "/api/answers?projectId=does-not-exist", {
      token: "token-a",
      expectOk: false
    });
    assert(missingProject.status === 404, `unknown projectId should return 404, got ${missingProject.status}`);
    assert(missingProject.payload.code === "PROJECT_NOT_FOUND", `unknown projectId should return PROJECT_NOT_FOUND, got ${missingProject.payload.code}`);

    // ── 4. AUTH_REQUIRED scope boundary: no token at all ──
    const noToken = await request(baseUrl, `/api/answers?projectId=${encodeURIComponent(projectId)}`, {
      expectOk: false
    });
    assert(noToken.status === 401, `missing token should return 401, got ${noToken.status}`);
    assert(noToken.payload.code === "AUTH_REQUIRED", `missing token should return AUTH_REQUIRED, got ${noToken.payload.code}`);

    // ── 5. Cross-user isolation: projects are owner-scoped once
    // AUTH_REQUIRED (findProject()'s visibleTo() check, the same one
    // /api/evaluation and /api/harness-run already rely on) -- since
    // store.answers/store.questions carry no userId of their own, this is
    // the only boundary standing between user-b and user-a's answer history.
    // A second user with their own project must not be able to read user-a's
    // answers by projectId, and must not be able to see them by omitting
    // projectId either (the "latest project" fallback must stay scoped to
    // projects *that user* owns). ──
    const crossUserRead = await request(baseUrl, `/api/answers?projectId=${encodeURIComponent(projectId)}`, {
      token: "token-b",
      expectOk: false
    });
    assert(crossUserRead.status === 404, `user-b reading user-a's project answers should 404, got ${crossUserRead.status}`);
    assert(crossUserRead.payload.code === "PROJECT_NOT_FOUND", `cross-user read should return PROJECT_NOT_FOUND, got ${crossUserRead.payload.code}`);

    const { payload: userBImport } = await request(baseUrl, "/api/import", {
      method: "POST",
      token: "token-b",
      body: JSON.stringify({ sample: true })
    });
    const userBProjectId = userBImport.project?.id;
    const { payload: userBHistory } = await request(baseUrl, "/api/answers", { token: "token-b" });
    assert(userBHistory.projectId === userBProjectId, "user-b's projectId-less request should fall back to user-b's own latest project");
    assert(userBHistory.answers.length === 0, "user-b's own project should have no answers yet, and must not see user-a's");

    console.log(JSON.stringify({
      ok: true,
      scenario: "get-api-answers-history-replay",
      projectId,
      answerCount: history.answers.length,
      limitedCount: limited.answers.length,
      clampedLimit: overLimit.limit
    }, null, 2));
  } catch (error) {
    console.error(stdout);
    console.error(stderr);
    throw error;
  } finally {
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
