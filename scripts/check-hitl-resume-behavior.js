import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Behavioral regression coverage for the HITL decision-resume replay bug.
//
// scripts/check-hitl-resume.js (the sibling check) only does static
// String.includes() assertions against server.js source — it can confirm the
// HITL code paths exist textually, but it cannot catch a *runtime* regression
// like the one this file guards against: after a high-risk agent-impact run
// pauses for human review, POST /api/langgraph-resume with a decision
// (approve/reject) used to reconstruct the checkpointer by cloning the paused
// run's full persisted checkpoint history (deserializeMemorySaverSnapshot),
// even though the actual graph input selection (useCheckpointResume) already
// bypassed that checkpoint and re-executed from a fresh baseInput with the
// decision injected. Because LangGraph channel reducers only overwrite a
// channel when the update object supplies that key, the cloned checkpointer's
// restored `finalPayload` channel (already set to the *paused* snapshot by the
// original run) survived untouched into the new invoke() call. decideNextRoute()
// checks `state.finalPayload` before anything else and returns END immediately,
// so the injected decision was never consumed by human_review/synthesize — the
// resume endpoint just handed back the original paused card again, and it could
// be "approved" indefinitely without ever producing a real synthesized result.
//
// This spins up a real server (like scripts/smoke-test.js does), reproduces the
// exact user-facing flow (import -> high-risk agent-impact -> pause -> resume
// with a decision), and asserts on the actually-returned payload rather than on
// source text, so a regression here fails for the right reason.

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

// The bundled sample project (server.js's SAMPLE_FILES) includes
// src/models/order.ts (matches the "Data Model" area rule) and
// src/services/orderService.ts / refundService.ts (matches "Business Logic"),
// and this exact question is already used elsewhere (scripts/agent-benchmark.js)
// as the canonical "safe impact analysis" question — it reliably classifies
// both areas as risk_level "high" under the offline deterministic answer
// generator, which is what tips decideNextRoute() into the human_review branch
// when AGENT_HITL_ENABLED=true.
const HIGH_RISK_QUESTION = "I am a PM. Give a concise risk impact analysis for adding order status partially_refunded.";

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-hitl-resume-behavior-"));
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
      AGENT_HITL_ENABLED: "true"
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
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project?.id;
    assert(projectId, "sample import did not return a project id");

    // ── 1. High-risk question pauses for human review ──
    const paused = await requestTo(baseUrl, "/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({ projectId, question: HIGH_RISK_QUESTION })
    });
    assert(paused.payload?.hitl, "expected a hitl field on a high-risk agent-impact answer with AGENT_HITL_ENABLED=true");
    assert(paused.payload.hitl.paused === true, "high-risk agent-impact should pause for human review");
    assert(paused.payload.hitl.decision === null, "paused answer should not carry a decision yet");
    assert(paused.payload.summary.startsWith("[HITL PAUSED"), "paused summary should carry the HITL paused marker");
    const runId = paused.payload.harness?.run_id;
    assert(runId, "paused agent-impact answer did not report a harness run id");
    assert(paused.payload.harness.checkpointing?.enabled === true, "paused run should still persist LangGraph checkpoints");

    // ── 2. Decision resume (approve) must NOT replay the paused snapshot ──
    // Before the fix: runLangGraphResumeFromCheckpoint's mode is
    // "checkpoint_continuation" for any run with a persisted checkpoint
    // payload, decision or not, and runAgenticImpactWorkflow used that same
    // condition (without excluding pausedDecision) to decide whether to clone
    // the checkpointer from the old run. Cloning the old run's full checkpoint
    // history restored its already-set `finalPayload` channel, and
    // decideNextRoute() short-circuited on it before the injected decision was
    // ever consumed — so this call used to come back with hitl.paused still
    // true and the identical "[HITL PAUSED" summary, byte-for-byte the same as
    // the original paused answer.
    const approved = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId, decision: "approve" })
    });
    assert(approved.payload?.harness?.resume?.mode === "input_snapshot_reexecution",
      `decision resume must report mode=input_snapshot_reexecution (fresh re-execution), got ${approved.payload?.harness?.resume?.mode}`);
    assert(approved.payload.hitl.paused === false,
      "REGRESSION: approve resume still returns a paused card — the old checkpoint's finalPayload leaked into the resumed run");
    assert(approved.payload.hitl.approved === true, "approve resume should mark hitl.approved");
    assert(approved.payload.hitl.decision === "approve", "approve resume should record the approve decision");
    assert(approved.payload.summary.startsWith("[HITL APPROVED]"), "approved summary should carry the HITL approved marker");
    assert(!approved.payload.summary.includes("[HITL PAUSED"), "approved summary must not still be the paused snapshot's summary");
    assert(approved.payload.harness.run_id !== runId, "resume should execute under a new harness run id");

    // Calling resume again with the same source run must not reproduce a
    // second, still-clickable paused card (the "可无限重复触发" symptom from
    // the bug report) — it should deterministically re-synthesize an approved
    // answer again, not replay stale paused state.
    const approvedAgain = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId, decision: "approve" })
    });
    assert(approvedAgain.payload.hitl.paused === false, "repeating the approve resume must not resurrect a paused card");
    assert(approvedAgain.payload.hitl.approved === true, "repeating the approve resume should stay approved");

    // ── 3. Decision resume (reject) follows the same corrected path ──
    const rejected = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId, decision: "reject" })
    });
    assert(rejected.payload?.harness?.resume?.mode === "input_snapshot_reexecution",
      `reject resume must report mode=input_snapshot_reexecution, got ${rejected.payload?.harness?.resume?.mode}`);
    assert(rejected.payload.hitl.paused === false, "REGRESSION: reject resume still returns a paused card");
    assert(rejected.payload.hitl.rejected === true, "reject resume should mark hitl.rejected");
    assert(rejected.payload.hitl.decision === "reject", "reject resume should record the reject decision");
    assert(rejected.payload.summary.startsWith("[HITL REJECTED]"), "rejected summary should carry the HITL rejected marker");

    // ── 4. Plain checkpoint continuation (no decision) is unaffected ──
    // A resume call that carries no decision must keep behaving exactly as
    // before: it replays the persisted checkpoint (mode=checkpoint_continuation)
    // rather than re-executing from scratch. This is the existing, intentional
    // "time-travel" contract already covered end-to-end (without HITL enabled)
    // by scripts/smoke-test.js; re-asserting it here — with AGENT_HITL_ENABLED=true
    // and against a paused run specifically — proves this fix's added
    // `!pausedDecision` gate did not also disable plain checkpoint continuation.
    const plainResume = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId })
    });
    assert(plainResume.payload?.harness?.resume?.mode === "checkpoint_continuation",
      `resume without a decision must still report mode=checkpoint_continuation, got ${plainResume.payload?.harness?.resume?.mode}`);
    assert(plainResume.payload.hitl.paused === true, "resume without a decision should keep replaying the paused checkpoint as-is");

    console.log(JSON.stringify({
      ok: true,
      scenario: "hitl-decision-resume-no-longer-replays-paused-snapshot",
      pausedRunId: runId,
      approvedResumeRunId: approved.payload.harness.run_id,
      rejectedResumeRunId: rejected.payload.harness.run_id,
      plainResumeMode: plainResume.payload.harness.resume.mode
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
