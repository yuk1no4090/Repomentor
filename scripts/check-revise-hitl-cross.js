import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Cross-feature regression coverage for Task L3's bounded QACritic revise loop
// interacting with the L1 native-interrupt HITL gate. Both features share the
// SAME routing function (decideNextRoute) and the SAME persisted graph state,
// which makes their intersection exactly the kind of thing a future change to
// either one could silently break without either feature's own isolated tests
// noticing.
//
// Why this needs a FAKE LLM instead of the deterministic (no-API-key) path:
// the deterministic critic (createDeterministicQaCriticReview) can only return
// verdict="revise" when `impact.impact_areas` is completely EMPTY (see
// scripts/check-revise-loop.js's own header comment) -- and the deterministic
// impact generator (generateImpactAnswer) never creates a HIGH-RISK area
// without also citing files for it. So "revise" and "riskLevel=high" are
// mutually exclusive on the pure deterministic path: an empty impact_areas
// array can never carry a high-risk area, and a non-empty impact_areas array
// (required for riskLevel=high) is never citation-empty. Forcing the two to
// co-occur would require changing decideNextRoute's or the deterministic
// generators' actual decision logic just to make a test pass -- exactly what
// the task instructions say not to do. A fake OpenAI-compatible endpoint (the
// same technique scripts/smoke-test.js already uses for its own schema/budget
// fixtures) sidesteps this cleanly: it exercises the REAL model_result.payload
// code path in the qa_plan/impact_analysis nodes with a payload we control,
// so QACritic can legitimately return verdict="revise" on round 1 (citing a
// REAL project file, so constrainQaCriticEvidence never has to strip
// anything) while ImpactAnalyst still reports a genuine high-risk area.
//
// Scenario: high-risk change -> QACritic asks for revision (round 1) -> the
// revise round re-runs retrieve..qa_plan -> QACritic now approves (round 1
// resolved) -> guardrails -> riskLevel=high + AGENT_HITL_ENABLED=true routes
// to human_review -> interrupt() genuinely pauses the run -> resume with a
// decision -> correct synthesis.
//
// This also exercises the property scripts/check-hitl-resume-behavior.js's
// reviewer flagged as load-bearing: after resume, human_review's own trace
// step pushes trace.length to 13 while revisionRound stays 1, so
// decideNextRoute's phase-offset arithmetic computes phase = 13 - 1*4 = 9 --
// OUT OF RANGE for ROUTE_RULES.phaseMap (length 9) on its own, which would
// incorrectly fall through to END. The post-human_review HITL guard
// (`hitlRequest.node === "human_review" && riskLevel === "high"`) is
// evaluated BEFORE that phase arithmetic and does not depend on it at all, so
// it still correctly routes to "synthesize" regardless. A correct, non-paused
// resumed answer below is the proof that guard's independence still holds
// with the revise loop's phase offset in play.

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

// Minimal fake OpenAI-compatible /v1/chat/completions endpoint. Distinguishes
// Supervisor/ImpactAnalyst/QACritic by the "You are the <Role> agent." system
// prompt line lib/llm.js's runAgentModelAdapter() always includes (the same
// technique scripts/smoke-test.js's startFakeLlmServer() uses).
function startFakeLlmServer() {
  let qaCriticCallCount = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk.toString();
    const requestBody = rawBody ? JSON.parse(rawBody) : {};
    const systemContent = requestBody.messages?.find((message) => message.role === "system")?.content || "";

    const supervisorPayload = {
      intent: "impact_analysis",
      risk_hypothesis: "high",
      required_agents: ["ImpactAnalyst", "QACritic"],
      retrieval_queries: ["order status model schema service"],
      require_human_review: true,
      rationale: "This change touches order status, a high-risk data-model/business-logic path."
    };
    const impactAnalystPayload = {
      summary: "Adding a new order status value changes the order data model and the order service's status transitions.",
      impact_areas: [{
        area: "Data Model",
        risk_level: "high",
        reason: "The order status enum/type changes shape and must stay backward compatible with persisted rows.",
        files: ["src/models/order.ts"]
      }],
      testing_suggestions: ["Add a regression test for every existing order status transition plus the new one."],
      open_questions: ["Are there downstream consumers of the order status enum that also need updating?"],
      briefing: {
        summary: "This change adds a new order status value, which touches how orders are modeled and displayed.",
        affected_flows: [{ flow: "Order lifecycle", why: "The status field gains a new valid value." }],
        testing_focus: ["Verify every existing order status transition still behaves the same."],
        risk_note: "High risk: recommend a human review before merging."
      }
    };
    // First QACritic call asks for revision (citing a REAL project file, so
    // constrainQaCriticEvidence never has to strip anything and force revise
    // itself -- the "revise" here is the model's own verdict, not a
    // side-effect of evidence stripping). The revise round's retrieve node
    // feeds this additional_queries entry into the next retrieval pass. The
    // second QACritic call (after the revise round) approves, so the run
    // reaches guardrails/human_review with a RESOLVED verdict, isolating the
    // HITL-pause assertions below from the revise loop's own success/failure.
    //
    // qaCriticCallCount is only incremented inside the QACritic branch below
    // (NOT once per incoming request) -- Supervisor and ImpactAnalyst are each
    // called once per round too, so incrementing unconditionally would have
    // this counter reach 1 on the Supervisor call and already be past 1 by
    // the time the real first QACritic request arrives, serving "approve"
    // immediately and silently skipping the revise round entirely.
    const isSupervisorRequest = systemContent.includes("You are the Supervisor agent");
    const isQaCriticRequest = systemContent.includes("You are the QACritic agent");
    let responsePayload;
    if (isSupervisorRequest) {
      responsePayload = supervisorPayload;
    } else if (isQaCriticRequest) {
      qaCriticCallCount += 1;
      responsePayload = qaCriticCallCount === 1
        ? {
            verdict: "revise",
            summary: "The order status transition table is not fully covered by evidence yet.",
            findings: [{
              severity: "high",
              finding: "No evidence was found for how existing order status transitions are validated before this change.",
              evidence_files: ["src/models/order.ts"]
            }],
            testing_suggestions: ["Confirm the order status transition table is exhaustively tested."],
            open_questions: ["Which file validates allowed order status transitions today?"],
            additional_queries: ["order status transition validation guard"]
          }
        : {
            verdict: "approve",
            summary: "The revise round's additional evidence is sufficient for this high-risk change.",
            findings: [{
              severity: "medium",
              finding: "High-risk areas require explicit rollback and regression coverage before implementation.",
              evidence_files: ["src/models/order.ts"]
            }],
            testing_suggestions: ["Exercise every existing order status transition plus the new one, including failure paths."],
            open_questions: [],
            additional_queries: []
          };
    } else {
      responsePayload = impactAnalystPayload;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responsePayload) } }] }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, getQaCriticCallCount: () => qaCriticCallCount });
    });
  });
}

function countRetrieveTraceSteps(trace) {
  return (trace || []).filter((step) => step.tool === "retriever_agent.retrieve_repository_chunks");
}

const QUESTION = "I am a PM. Give a concise risk impact analysis for adding order status partially_refunded.";

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-revise-hitl-cross-"));
  const fakeLlm = await startFakeLlmServer();

  let port = await getFreePort();
  let baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";

  function spawnServer() {
    const proc = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: port,
        HOST: "127.0.0.1",
        DATA_DIR: dataDir,
        OPENAI_API_KEY: "fake-revise-hitl-key",
        OPENAI_BASE_URL: fakeLlm.baseUrl,
        OPENAI_MODEL: "fake-revise-hitl-model",
        AGENT_HITL_ENABLED: "true"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    return proc;
  }

  async function restartServer() {
    await stopChild(child);
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawnServer();
    await waitForServer(baseUrl, child);
  }

  let child = spawnServer();

  try {
    await waitForServer(baseUrl, child);

    const imported = await requestTo(baseUrl, "/api/import", {
      method: "POST",
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project?.id;
    assert(projectId, "sample import did not return a project id");

    // ── 1. High-risk change + revise round, then HITL pause ──
    const paused = await requestTo(baseUrl, "/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({ projectId, question: QUESTION })
    });

    assert(paused.payload?.hitl?.paused === true, "expected the run to pause for human review after the revise round resolved");
    assert(paused.payload.hitl.decision === null, "paused answer should not carry a decision yet");
    assert(paused.payload.summary.startsWith("[HITL PAUSED"), "paused summary should carry the HITL paused marker");
    assert(paused.payload.harness?.revision_rounds === 1, `expected exactly 1 revise round before the HITL pause, got ${paused.payload.harness?.revision_rounds}`);
    assert(paused.payload.critic_review?.verdict === "approve",
      `expected the revise round to resolve the critic's verdict to "approve" BEFORE the HITL gate, got "${paused.payload.critic_review?.verdict}"`);
    assert(countRetrieveTraceSteps(paused.payload.trace).length === 2,
      "expected exactly 2 retrieve steps (initial + 1 revise round) in the paused trace");
    assert(fakeLlm.getQaCriticCallCount() === 2, `expected exactly 2 QACritic model calls (revise + approve), got ${fakeLlm.getQaCriticCallCount()}`);
    const runId = paused.payload.harness?.run_id;
    assert(runId, "paused agent-impact answer did not report a harness run id");
    assert(paused.payload.harness.checkpointing?.enabled === true, "paused run should still persist LangGraph checkpoints");
    assert(paused.payload.harness.budget_status.step_budget_exceeded === false,
      "a high-risk run with one resolved revise round must not exceed the (revision-aware) step budget");
    const pausedTraceLength = paused.payload.trace.length;

    // ── 2. Restart the server process before resuming (same convention as
    // scripts/check-hitl-resume-behavior.js: proves the checkpoint survives a
    // real process boundary, not just the original in-memory MemorySaver) ──
    await restartServer();

    // ── 3. Resume with a decision -> correct synthesis ──
    const approved = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId, decision: "approve" })
    });
    assert(approved.payload?.harness?.resume?.mode === "native_interrupt_resume",
      `decision resume with a persisted checkpoint payload must report mode=native_interrupt_resume, got ${approved.payload?.harness?.resume?.mode}`);
    assert(approved.payload.hitl.paused === false,
      "resumed answer must not still report a paused card");
    assert(approved.payload.hitl.approved === true, "resumed answer should mark hitl.approved");
    assert(approved.payload.hitl.decision === "approve", "resumed answer should record the approve decision");
    assert(approved.payload.summary.startsWith("[HITL APPROVED]"), "resumed summary should carry the HITL approved marker");
    // This is the guard-2-independence proof described in the header comment:
    // decideNextRoute's phase-offset arithmetic (13 - revisionRound*4 = 9, out
    // of ROUTE_RULES.phaseMap's range) would incorrectly hit END here if the
    // post-human_review HITL guard depended on that arithmetic at all. It
    // does not, and this assertion is the proof: a real synthesized,
    // non-paused answer, not an END/no-op.
    assert(approved.payload.critic_review?.verdict === "approve", "resumed answer should still report the resolved (approved) critic verdict");
    assert(approved.payload.harness?.revision_rounds === 1, "resumed answer should still report the 1 revise round from before the pause");
    assert(Array.isArray(approved.payload.trace) && approved.payload.trace.length === pausedTraceLength + 1,
      `resume must only re-run human_review + synthesize (trace length +1), got paused=${pausedTraceLength} resumed=${approved.payload.trace.length}`);

    console.log(JSON.stringify({
      ok: true,
      scenario: "qa-critic-revise-loop-crosses-hitl-pause-and-resume",
      pausedRunId: runId,
      pausedTraceLength,
      resumedTraceLength: approved.payload.trace.length,
      revisionRounds: paused.payload.harness.revision_rounds,
      qaCriticCallCount: fakeLlm.getQaCriticCallCount(),
      resumeMode: approved.payload.harness.resume.mode,
      finalVerdict: approved.payload.critic_review.verdict,
      finalHitl: approved.payload.hitl
    }, null, 2));
  } catch (error) {
    console.error(stdout);
    console.error(stderr);
    throw error;
  } finally {
    await stopChild(child);
    fakeLlm.server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
