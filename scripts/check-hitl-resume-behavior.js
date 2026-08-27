import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bytesToBase64, base64ToBytes } from "../lib/checkpoints.js";

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
//
// Upgraded alongside the move from a soft, non-stopping "pause" (human_review just
// set a flag and the graph kept running to synthesize in the same invoke() call) to
// a genuine LangGraph interrupt()/Command pause: human_review now calls interrupt(),
// which throws before returning, so graph.invoke() comes back with `__interrupt__`
// set and no finalPayload — the run is truly stopped mid-execution, not merely
// flagged. A decision-resume now rehydrates that SAME paused MemorySaver checkpoint
// and resumes it via `graph.invoke(new Command({ resume: decision }), ...)`
// (harness.resume.mode="native_interrupt_resume"): only human_review (re-run from
// its top, per LangGraph's resume contract) and synthesize execute — input_safety
// through guardrails are NOT re-run, because their state already lives in the
// persisted checkpoint. This file proves that with a trace-length delta assertion
// below: the resumed answer's trace must be longer than the paused answer's trace
// by exactly the two nodes that actually re-ran, not by a full 9-phase re-run's
// worth of steps. The legacy "input_snapshot_reexecution" full re-run from phase 0
// (baseInput.hitlRequest injection) is kept only as a fallback for when the
// persisted checkpoint payload no longer exists (e.g. pruned by
// CHECKPOINT_MAX_RUNS) — exercised at the end of this file by deleting the run's
// row from langgraph_checkpoint_payloads directly and resuming again.
//
// The server process that pauses the run is killed and a brand-new server
// process (same DATA_DIR, fresh port) is spawned before the first decision
// resume, so every resume/replay assertion below is proven across a real
// process boundary — the persisted checkpoint payload has to survive in
// SQLite, not merely in the original process's in-memory MemorySaver.

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

// Post-review blocker fix regression coverage: rewrites every persisted
// checkpoint's serialized `channel_values` for one run, deleting the
// `phaseCursor` key wherever present -- simulates a checkpoint saved by
// pre-Task-N1 code, which never had this channel in its schema at all (so
// `channel_values` for every checkpoint that code ever wrote genuinely lacks
// the key, not just has it set to some stale value).
//
// Mirrors lib/checkpoints.js's own serializeMemorySaverSnapshot/
// deserializeMemorySaverSnapshot wire format exactly -- same nested
// storage[threadId][namespace][checkpointId] = [checkpointB64, metadataB64,
// parentCheckpointId] shape, same bytesToBase64/base64ToBytes encoding
// (reused directly from lib/checkpoints.js, not reimplemented, so this stays
// byte-faithful to production if that format ever changes) -- and the
// checkpoint blob itself is UTF-8-encoded JSON text (LangGraph's
// JsonPlusSerializer "json" type; see
// node_modules/@langchain/langgraph-checkpoint/dist/serde/jsonplus.js), so a
// plain JSON.parse/JSON.stringify round-trip on the decoded bytes is exact
// apart from the one deliberately deleted key. Only channel_values is
// touched -- channel_versions/versions_seen do not participate in restoring
// a channel's VALUE (see node_modules/@langchain/langgraph/dist/channels/base.js's
// emptyChannels(), which looks up `checkpoint.channel_values[k]` only), so
// leaving them untouched does not undermine the simulation.
function stripPhaseCursorFromPersistedRun(dbPath, runId) {
  const db = new DatabaseSync(dbPath);
  let strippedCount = 0;
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    const row = db.prepare("SELECT payload_json FROM langgraph_checkpoint_payloads WHERE run_id = ?").get(runId);
    if (!row) throw new Error(`no langgraph_checkpoint_payloads row for run ${runId}`);
    const payload = JSON.parse(row.payload_json);
    for (const namespaces of Object.values(payload.storage || {})) {
      for (const checkpoints of Object.values(namespaces || {})) {
        for (const checkpointId of Object.keys(checkpoints || {})) {
          const [checkpointB64, metadataB64, parentCheckpointId] = checkpoints[checkpointId];
          const checkpointObj = JSON.parse(new TextDecoder().decode(base64ToBytes(checkpointB64)));
          if (checkpointObj.channel_values && Object.prototype.hasOwnProperty.call(checkpointObj.channel_values, "phaseCursor")) {
            delete checkpointObj.channel_values.phaseCursor;
            strippedCount += 1;
          }
          const reEncoded = bytesToBase64(new TextEncoder().encode(JSON.stringify(checkpointObj)));
          checkpoints[checkpointId] = [reEncoded, metadataB64, parentCheckpointId];
        }
      }
    }
    db.prepare("UPDATE langgraph_checkpoint_payloads SET payload_json = ? WHERE run_id = ?").run(JSON.stringify(payload), runId);
  } finally {
    db.close();
  }
  return strippedCount;
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
  // `port`/`baseUrl` are `let`, not `const`: restartServer() below spawns a brand-new
  // server process on a freshly obtained free port (rather than reusing the old
  // port, which would risk an EADDRINUSE/TIME_WAIT race right after the old
  // process exits) and reassigns both, so every request made after the restart
  // transparently talks to the new process.
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
        OPENAI_API_KEY: "",
        AGENT_HITL_ENABLED: "true"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    return proc;
  }

  // Kills the current server process and spawns a fresh one against the SAME
  // DATA_DIR (so the SQLite-backed store/memory database and its
  // langgraph_checkpoints/langgraph_checkpoint_payloads rows survive), on a
  // newly obtained free port. Used once below, right after the run pauses and
  // before any resume is attempted, so the resume path is exercised across a
  // genuine process restart rather than within the single long-lived process
  // that happened to pause it.
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
    // Captured so step 2/3 below can check GET /api/answers replays this
    // exact answer record with its payload.hitl patched in place after a
    // decision, not just the brand-new resumed answer's own payload.hitl.
    const pausedAnswerId = paused.answerId;
    assert(pausedAnswerId, "paused agent-impact answer did not report an answerId");
    assert(Array.isArray(paused.payload.trace), "paused answer must report a trace array");
    const pausedTraceLength = paused.payload.trace.length;

    // ── 1c. Restart the server process before resuming ──
    // Everything from here on talks to a brand-new server process (same
    // DATA_DIR, fresh port). If checkpoint persistence were actually scoped to
    // the original process's in-memory MemorySaver instance rather than the
    // SQLite-backed langgraph_checkpoints/langgraph_checkpoint_payloads
    // tables, every resume assertion below would fail with
    // LANGGRAPH_CHECKPOINT_NOT_FOUND / LANGGRAPH_RESUME_UNAVAILABLE instead of
    // succeeding.
    await restartServer();

    // ── 2. Decision resume (approve) must resume the SAME paused execution,
    // not replay the paused snapshot and not re-execute the whole graph ──
    // Before the P3 fix (input_snapshot_reexecution era): runLangGraphResumeFromCheckpoint's
    // mode was "checkpoint_continuation" for any run with a persisted checkpoint
    // payload, decision or not, and runAgenticImpactWorkflow used that same
    // condition (without excluding pausedDecision) to decide whether to clone
    // the checkpointer from the old run. Cloning the old run's full checkpoint
    // history restored its already-set `finalPayload` channel, and
    // decideNextRoute() short-circuited on it before the injected decision was
    // ever consumed — so this call used to come back with hitl.paused still
    // true and the identical "[HITL PAUSED" summary, byte-for-byte the same as
    // the original paused answer.
    //
    // After the native interrupt()/Command upgrade: a decision resume with a
    // persisted checkpoint payload reports mode="native_interrupt_resume" and
    // rehydrates+resumes the SAME paused MemorySaver checkpoint via
    // `Command({ resume: decision })`, instead of re-executing the whole graph
    // from a fresh baseInput.
    const approved = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId, decision: "approve" })
    });
    assert(approved.payload?.harness?.resume?.mode === "native_interrupt_resume",
      `decision resume with a persisted checkpoint payload must report mode=native_interrupt_resume, got ${approved.payload?.harness?.resume?.mode}`);
    assert(approved.payload.hitl.paused === false,
      "REGRESSION: approve resume still returns a paused card — the old checkpoint's finalPayload leaked into the resumed run");
    assert(approved.payload.hitl.approved === true, "approve resume should mark hitl.approved");
    assert(approved.payload.hitl.decision === "approve", "approve resume should record the approve decision");
    assert(approved.payload.summary.startsWith("[HITL APPROVED]"), "approved summary should carry the HITL approved marker");
    assert(!approved.payload.summary.includes("[HITL PAUSED"), "approved summary must not still be the paused snapshot's summary");
    assert(approved.payload.harness.run_id !== runId, "resume should execute under a new harness run id");

    // ── 2c. Proof of no re-execution: only human_review + synthesize re-ran ──
    // If the resumed run had re-executed the whole graph from phase 0 (the old
    // input_snapshot_reexecution behavior), its trace would be a brand-new
    // 9-or-10-step trace unrelated in length to the paused run's trace. Because
    // native_interrupt_resume instead resumes the SAME persisted checkpoint —
    // which already contains the paused run's input_safety..guardrails trace
    // steps verbatim — the resumed trace must be exactly the paused trace plus
    // the steps contributed by the nodes that actually re-ran: human_review
    // (returns its real "resumed with decision" trace step this time, since
    // interrupt() returned instead of throwing) and synthesize (runs for the
    // first time). The paused answer's own trace additionally carries one
    // *synthetic* "hitl_paused" step appended for display only (human_review's
    // real return never materialized during the pause, since interrupt() threw
    // before the node could return it) — so the net delta measured here is
    // +1, not +2: the synthetic step effectively "becomes" human_review's real
    // resumed step, and synthesize contributes the other +1.
    assert(Array.isArray(approved.payload.trace), "approved answer must report a trace array");
    const approvedTraceLength = approved.payload.trace.length;
    console.log(JSON.stringify({
      probe: "trace-length-delta",
      pausedTraceLength,
      approvedTraceLength,
      delta: approvedTraceLength - pausedTraceLength
    }));
    const EXPECTED_RESUME_TRACE_DELTA = 1;
    assert(approvedTraceLength === pausedTraceLength + EXPECTED_RESUME_TRACE_DELTA,
      `native_interrupt_resume must not re-run input_safety..guardrails: expected resumed trace length ${pausedTraceLength} + ${EXPECTED_RESUME_TRACE_DELTA} = ${pausedTraceLength + EXPECTED_RESUME_TRACE_DELTA}, got ${approvedTraceLength}`);

    // ── 2b. The ORIGINAL paused answer record must be patched in place, not
    // just the brand-new resumed answer above. GET /api/answers is the same
    // read-only replay endpoint the frontend's restoreConversationHistory()
    // calls after a page refresh (see public/app.js) — before this fix,
    // server.js only ever pushed a new question/answer pair for the resumed
    // execution and never touched the record that originally paused, so a
    // refresh replayed hitl.paused=true forever and resurrected clickable
    // Approve/Reject buttons on an already-decided run (confirmed
    // reproducible: every refresh+click produced another duplicate resume
    // record). ──
    const historyAfterApprove = await requestTo(baseUrl, `/api/answers?projectId=${projectId}`);
    const originalAfterApprove = historyAfterApprove.answers.find((item) => item.answerId === pausedAnswerId);
    assert(originalAfterApprove, "GET /api/answers should still include the original paused answer record");
    assert(originalAfterApprove.payload.hitl?.paused === false,
      "REGRESSION: the original paused answer record still reports hitl.paused=true after approval — refreshing would resurrect clickable Approve/Reject buttons");
    assert(originalAfterApprove.payload.hitl?.approved === true, "original paused answer record should report hitl.approved=true after approval");
    assert(originalAfterApprove.payload.hitl?.decision === "approve", "original paused answer record should record the approve decision");
    // The brand-new resumed answer (pushed alongside the patch, at a
    // different answerId) must also show up in the same history replay —
    // patching the original must not have replaced or dropped it.
    assert(historyAfterApprove.answers.some((item) => item.answerId === approved.answerId),
      "GET /api/answers should also include the new resumed answer record");

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
    assert(rejected.payload?.harness?.resume?.mode === "native_interrupt_resume",
      `reject resume with a persisted checkpoint payload must report mode=native_interrupt_resume, got ${rejected.payload?.harness?.resume?.mode}`);
    assert(rejected.payload.hitl.paused === false, "REGRESSION: reject resume still returns a paused card");
    assert(rejected.payload.hitl.rejected === true, "reject resume should mark hitl.rejected");
    assert(rejected.payload.hitl.decision === "reject", "reject resume should record the reject decision");
    assert(rejected.payload.summary.startsWith("[HITL REJECTED]"), "rejected summary should carry the HITL rejected marker");

    // ── 3b. Same persisted-replay check as 2b, now for reject — and proof
    // that the original record's patched hitl state tracks the *latest*
    // decision for its source run (flipping from approved to rejected here,
    // since this reuses the same runId the approve calls above already
    // decided once) rather than getting stuck on whichever decision arrived
    // first. ──
    const historyAfterReject = await requestTo(baseUrl, `/api/answers?projectId=${projectId}`);
    const originalAfterReject = historyAfterReject.answers.find((item) => item.answerId === pausedAnswerId);
    assert(originalAfterReject, "GET /api/answers should still include the original paused answer record");
    assert(originalAfterReject.payload.hitl?.paused === false,
      "REGRESSION: the original paused answer record still reports hitl.paused=true after rejection");
    assert(originalAfterReject.payload.hitl?.rejected === true, "original paused answer record should report hitl.rejected=true after rejection");
    assert(originalAfterReject.payload.hitl?.decision === "reject",
      "original paused answer record should track the latest decision (reject), not stay stuck on the earlier approve");
    assert(originalAfterReject.payload.hitl?.approved === false, "original paused answer record should clear hitl.approved once superseded by a reject decision");

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
    // A plain (no-decision) resume must not touch the original paused
    // answer's persisted hitl state -- it's still "reject" from step 3b, and
    // this call carried no decision at all, so the server-side patch above
    // (gated on `body.decision` being truthy) must have been a no-op here.
    const historyAfterPlainResume = await requestTo(baseUrl, `/api/answers?projectId=${projectId}`);
    const originalAfterPlainResume = historyAfterPlainResume.answers.find((item) => item.answerId === pausedAnswerId);
    assert(originalAfterPlainResume.payload.hitl?.decision === "reject",
      "a plain resume (no decision) must not alter the original paused answer's already-persisted decision");

    // ── 4b. Phase-cursor checkpoint migration regression (post-review blocker
    // fix). A TRUE "time travel" resume (Task N1's checkpoint_continuation
    // mode: an explicit, non-latest checkpointId, no decision) from a
    // MID-GRAPH checkpoint whose phaseCursor channel predates Task N1 must
    // continue from the correct next phase, not silently restart at
    // "input_safety". Reproduces the exact reviewer-found regression: a
    // checkpoint persisted before the phaseCursor channel existed restores it
    // as LangGraph's own Annotation default (0) on resume -- a LEGITIMATE
    // integer indistinguishable from a fresh state by a naive
    // Number.isInteger(state.phaseCursor) check alone (see
    // lib/agent-graph.js's decideNextRoute for the fix: derive phase from
    // trace length whenever cursor reads exactly 0 with a non-empty trace).
    //
    // Uses the SAME paused run (runId) from step 1 above. Its persisted
    // checkpoint history is untouched by the decision-resume calls in steps
    // 2/3/4 (those only ever clone the source payload into a NEW thread/run
    // id when resuming; they never mutate the original run's own persisted
    // row), so its full checkpoint chain -- including the mid-graph
    // "retrieve" checkpoint -- is still exactly as step 1 left it.
    //
    // Checkpoint selection: this LangGraph version's persisted checkpoint
    // metadata does not carry a reliable per-node name (`checkpoint.node`
    // resolves to the generic pregel superstep source, "input"/"loop", not
    // "retrieve" -- confirmed empirically), so the mid-graph checkpoint is
    // located by `state_summary.trace_steps` instead: every real phase node's
    // own write is immediately followed by the supervisor's own routing
    // checkpoint at the SAME trace_steps count (supervisor's own write only
    // touches routeDecisions/handoffs, never trace), so trace_steps values
    // appear in adjacent pairs in the replay. The FIRST checkpoint whose
    // trace_steps is 4 is therefore exactly the one immediately after
    // "retrieve" wrote its own state -- pending task "supervisor" -- not yet
    // routed onward. This is precisely the checkpoint the reviewer's repro
    // targeted ("真实 phaseCursor 本应是 4 的中途 checkpoint").
    const replay = await requestTo(baseUrl, `/api/langgraph-replay?projectId=${projectId}&runId=${runId}`);
    // GUARD (do not copy-paste this selector onto a different fixture without
    // re-checking this): `.find()` returns only the FIRST checkpoint whose
    // trace_steps reads 4, which is unambiguous here only because this
    // fixture's run is a single straight-line pass with no revise loop. A
    // revise round (QACritic requesting a bounded re-run) can produce a
    // SECOND checkpoint that also reads trace_steps === 4 but sits at a
    // different graph position -- against a revise-looping fixture, `.find()`
    // would silently pick the wrong one instead of failing loudly.
    const midGraphStep = replay.steps.find((step) => step.state_summary?.trace_steps === 4);
    assert(midGraphStep,
      `expected a persisted checkpoint with trace_steps === 4 (right after "retrieve") in run ${runId}'s replay, got trace_steps sequence: ${JSON.stringify(replay.steps.map((step) => step.state_summary?.trace_steps))}`);
    const midGraphCheckpointId = midGraphStep.checkpoint_id;

    // Control: resume from this SAME mid-graph checkpoint with the persisted
    // payload's phaseCursor channel fully intact (cursor 4, "retrieve"'s own
    // successor). The run should continue normally from "expand_context"
    // through guardrails, then pause again at human_review — 5 more real
    // steps plus the synthetic paused step on top of the 4 already in the
    // checkpoint's trace = 9 total, byte-identical in shape to the original
    // step-1 pause.
    const controlResume = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId, checkpointId: midGraphCheckpointId })
    });
    assert(controlResume.payload?.harness?.resume?.mode === "checkpoint_continuation",
      `mid-graph resume with an intact payload must report mode=checkpoint_continuation, got ${controlResume.payload?.harness?.resume?.mode}`);
    assert(controlResume.payload.hitl?.paused === true, "mid-graph checkpoint_continuation resume should still pause at human_review");
    const controlTraceLength = controlResume.payload.trace.length;
    const controlTraceTools = controlResume.payload.trace.map((step) => step.tool);
    const controlDuplicateTools = controlTraceTools.filter((tool, index) => controlTraceTools.indexOf(tool) !== index);
    assert(controlDuplicateTools.length === 0,
      `control resume (intact phaseCursor) must not repeat any trace tool, got duplicates: ${JSON.stringify(controlDuplicateTools)}`);

    // Simulate a genuinely pre-Task-N1 checkpoint: strip the phaseCursor
    // channel from EVERY checkpoint persisted for this run (not just the
    // mid-graph one — an old snapshot never had this channel anywhere in its
    // history).
    const dbPathForMigration = path.join(dataDir, "memory.sqlite");
    const strippedCount = stripPhaseCursorFromPersistedRun(dbPathForMigration, runId);
    assert(strippedCount >= 1, `expected to strip phaseCursor from at least 1 persisted checkpoint for run ${runId}, stripped ${strippedCount}`);

    // Treatment: resume from the EXACT SAME mid-graph checkpoint id, now with
    // phaseCursor missing from every checkpoint's channel_values. Before the
    // fix: LangGraph seeds the restored phaseCursor with the Annotation's own
    // default (0) — decideNextRoute's old fallback could not tell this apart
    // from a fresh state, routed to "input_safety", and re-ran
    // input_safety/memory/classify/retrieve a SECOND time before "retrieve"'s
    // own nextPhaseCursor("retrieve") call self-healed the cursor back to 4.
    // After the fix: decideNextRoute detects cursor===0 with a non-empty
    // trace and derives phase from trace.length instead, so this resume must
    // behave identically to the control group above.
    const treatmentResume = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId, checkpointId: midGraphCheckpointId })
    });
    assert(treatmentResume.payload?.harness?.resume?.mode === "checkpoint_continuation",
      `mid-graph resume with a stripped payload must still report mode=checkpoint_continuation, got ${treatmentResume.payload?.harness?.resume?.mode}`);
    const treatmentTraceLength = treatmentResume.payload.trace.length;
    const treatmentTraceTools = treatmentResume.payload.trace.map((step) => step.tool);
    const treatmentDuplicateTools = treatmentTraceTools.filter((tool, index) => treatmentTraceTools.indexOf(tool) !== index);

    console.log(JSON.stringify({
      probe: "phase-cursor-migration-regression",
      midGraphCheckpointId,
      controlTraceLength,
      treatmentTraceLength,
      controlDuplicateTools,
      treatmentDuplicateTools
    }));

    assert(treatmentResume.payload.hitl?.paused === true,
      "REGRESSION: stripped-phaseCursor resume did not pause at human_review as expected");
    assert(treatmentDuplicateTools.length === 0,
      `REGRESSION: stripped-phaseCursor resume silently re-ran phases (duplicate trace tools): ${JSON.stringify(treatmentDuplicateTools)}`);
    assert(treatmentTraceLength === controlTraceLength,
      `REGRESSION: stripped-phaseCursor resume produced a different trace length (${treatmentTraceLength}) than the intact-payload control (${controlTraceLength}) -- a pre-phaseCursor checkpoint must derive phase from trace length, not silently restart at phase 0`);

    // ── 5. Legacy fallback proof: pruned checkpoint payload still resumes ──
    // native_interrupt_resume (steps 2/3 above) depends on the persisted MemorySaver
    // payload row in langgraph_checkpoint_payloads surviving until resume time. That
    // row is bounded by CHECKPOINT_MAX_RUNS and can legitimately be pruned before a
    // user gets around to deciding. Deleting the paused run's row directly here
    // reproduces that condition deterministically: runLangGraphResumeFromCheckpoint()
    // (lib/checkpoints.js) falls back to mode="input_snapshot_reexecution" (full
    // re-execution from a fresh baseInput with the decision injected — the original,
    // pre-native-interrupt behavior), and the resume must still succeed and approve.
    const dbPath = path.join(dataDir, "memory.sqlite");
    const db = new DatabaseSync(dbPath);
    let deletedPayloadRows;
    try {
      const before = db.prepare("SELECT COUNT(*) AS n FROM langgraph_checkpoint_payloads WHERE run_id = ?").get(runId);
      assert(Number(before?.n) > 0, "expected a persisted langgraph_checkpoint_payloads row for the paused run before deleting it");
      db.exec("PRAGMA journal_mode = WAL;");
      const result = db.prepare("DELETE FROM langgraph_checkpoint_payloads WHERE run_id = ?").run(runId);
      deletedPayloadRows = Number(result.changes);
    } finally {
      db.close();
    }
    assert(deletedPayloadRows === 1, `expected to delete exactly 1 langgraph_checkpoint_payloads row for the paused run, deleted ${deletedPayloadRows}`);

    const approvedAfterPruning = await requestTo(baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId, runId, decision: "approve" })
    });
    assert(approvedAfterPruning.payload?.harness?.resume?.mode === "input_snapshot_reexecution",
      `decision resume with no persisted checkpoint payload must fall back to mode=input_snapshot_reexecution, got ${approvedAfterPruning.payload?.harness?.resume?.mode}`);
    assert(approvedAfterPruning.payload.hitl.paused === false,
      "legacy fallback resume (pruned payload) must still not return a paused card");
    assert(approvedAfterPruning.payload.hitl.approved === true, "legacy fallback resume (pruned payload) should still mark hitl.approved");
    assert(approvedAfterPruning.payload.hitl.decision === "approve", "legacy fallback resume (pruned payload) should still record the approve decision");
    assert(approvedAfterPruning.payload.summary.startsWith("[HITL APPROVED]"), "legacy fallback resume (pruned payload) summary should still carry the HITL approved marker");

    console.log(JSON.stringify({
      ok: true,
      scenario: "hitl-decision-resume-no-longer-replays-paused-snapshot",
      crossProcessRestart: true,
      pausedRunId: runId,
      pausedAnswerId,
      pausedTraceLength,
      approvedTraceLength,
      resumeTraceLengthDelta: approvedTraceLength - pausedTraceLength,
      approvedResumeRunId: approved.payload.harness.run_id,
      approvedResumeMode: approved.payload.harness.resume.mode,
      rejectedResumeRunId: rejected.payload.harness.run_id,
      rejectedResumeMode: rejected.payload.harness.resume.mode,
      plainResumeMode: plainResume.payload.harness.resume.mode,
      prunedPayloadResumeMode: approvedAfterPruning.payload.harness.resume.mode,
      originalAnswerHitlAfterReject: originalAfterReject.payload.hitl
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
