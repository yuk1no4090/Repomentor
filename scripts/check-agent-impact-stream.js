import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Behavioral, offline (no API key), real-server proof for Task L2's node-level
// SSE progress stream: POST /api/agent-impact/stream. Every assertion here
// drives the ACTUAL running server over real HTTP/SSE (like
// scripts/check-hitl-resume-behavior.js and scripts/check-revise-loop.js),
// rather than grepping source text — the strongest evidence available that
// the new route behaves correctly, and immune to the "satisfied by a comment"
// failure mode a string-match assertion could have. Four scenarios:
//
//   1. Basic run: event ordering is sane (workflow_started first, final
//      last, every one of the 9 phaseMap nodes appears exactly once, in
//      order), the final event's payload passes the same field-presence
//      shape check as scripts/check-agent-contract.js applies to
//      POST /api/agent-impact's response, AND — Task L2 (D)'s core
//      correctness requirement — the SAME question through both
//      POST /api/agent-impact and POST /api/agent-impact/stream produces
//      byte-identical payloads once run-scoped volatile fields
//      (run_id/thread_id/timestamps/duration_ms) are normalized out.
//   2. Bounded QACritic revise round (reusing check-revise-loop.js's FIXABLE
//      fixture/question): exactly 13 node_completed events (9 + 4 for the one
//      revise round: retrieve/expand_context/impact_analysis/qa_plan re-run),
//      exactly 1 revise_round_entered event carrying the critic's
//      additional_queries, and the run still resolves to "approve".
//   3. HITL native-interrupt pause (reusing check-hitl-resume-behavior.js's
//      high-risk question): exactly 8 node_completed events (synthesize never
//      runs — human_review's interrupt() throws before it can), exactly 1
//      hitl_paused event, and the final event's payload carries
//      hitl.paused === true with the "[HITL PAUSED" summary prefix.
//   4. Client-disconnect abort (Task L2 (E)): a slow fake OpenAI-compatible
//      endpoint (genuine local network I/O, so an externally-triggered abort
//      signal has a real chance to be observed between nodes — a fully
//      offline/synchronous run never yields to the event loop at all between
//      nodes, so an abort scheduled from outside that run's own consumption
//      loop would never be observed until the whole run finishes regardless
//      of how correctly it is wired; this is a Node/V8 microtask-draining
//      characteristic, not something specific to this implementation).
//      Disconnecting after 3 events must stop the run: no "final" event, no
//      answer record written to the store, the server stays alive and
//      healthy, and no unhandled rejection reaches its stderr.
//   5. Progressive delivery, not batch-then-flush (reviewer-flagged coverage
//      gap): scenarios 1-4 all assert event COUNT/ORDER/CONTENT, and the
//      basic scenario's "elapsed_ms should be non-decreasing" check only
//      constrains the VALUE each event carries -- a server that computed the
//      whole run, buffered every event, and wrote them all back-to-back right
//      before "final" would still produce non-decreasing elapsed_ms values
//      (they are still the true per-node completion times, just delivered
//      late) and would still pass every other assertion in this file. This
//      scenario measures wall-clock ARRIVAL time client-side (not the
//      elapsed_ms payload value) and asserts real events are spread across
//      the run rather than clustered at the end. See scenarioProgressiveDelivery
//      below for the exact metric, its threshold, and the mutation evidence
//      that it actually catches a batch-then-flush regression.

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

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json();
      if (body.status === "ok") return;
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

// Minimal uncompressed (stored, method 0) ZIP writer -- same shape duplicated
// across scripts/check-revise-loop.js and friends (not exported anywhere to
// import from).
function createZipBase64(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const name = Buffer.from(filePath, "utf8");
    const body = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, end]).toString("base64");
}

function spawnServer(port, dataDir, extraEnv = {}) {
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
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

// Parses one SSE response body into an ordered event list (kept in the same
// { type, data } shape the frontend's own parser in public/app.js builds),
// plus the "final" event's payload for convenience.
async function consumeSse(response) {
  assert(response.ok, `stream response not ok: ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  assert(contentType.includes("text/event-stream"), `expected text/event-stream, got "${contentType}"`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  let finalPayload = null;
  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let separatorIndex;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const eventMatch = rawEvent.match(/^event: (.+)$/m);
      const dataMatch = rawEvent.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue; // heartbeat comment line, etc.
      const data = JSON.parse(dataMatch[1]);
      events.push({ type: eventMatch[1], data });
      if (eventMatch[1] === "final") finalPayload = data;
    }
    if (done) break;
  }
  return { events, finalPayload };
}

// Same field-presence contract scripts/check-agent-contract.js enforces
// statically against server.js's finalPayload/fallbackPayload source blocks —
// applied here at runtime against an ACTUAL response object, for both routes,
// so this doubles as the "final event's payload passes the same shape
// validation as the JSON route" proof Task L2 (H) asks for.
const REQUIRED_PAYLOAD_FIELDS = [
  "memory_used", "memory_suggestions", "supervisor_plan", "critic_review", "harness", "safety"
];
const REQUIRED_HARNESS_FIELDS = [
  "run_id", "runtime", "model_mode", "model_provider", "model_adapter", "model_calls",
  "steps_executed", "duration_ms", "fallback_used", "fallback_reason", "schema_valid",
  "budgets", "budget_status", "tool_registry", "errors"
];
function assertPayloadShape(label, payload) {
  for (const field of REQUIRED_PAYLOAD_FIELDS) {
    assert(field in payload, `[${label}] payload missing required field "${field}"`);
  }
  for (const field of REQUIRED_HARNESS_FIELDS) {
    assert(field in payload.harness, `[${label}] payload.harness missing required field "${field}"`);
  }
  assert(Array.isArray(payload.trace) && payload.trace.length > 0, `[${label}] payload.trace must be a non-empty array`);
}

const SAMPLE_QUESTION = "I am a PM. Give a concise risk impact analysis for adding order status partially_refunded.";

// ── Scenario 1: ordering, shape, and payload equivalence (D) ──
async function scenarioBasicOrderingAndEquivalence() {
  // Two fully independent server processes/data dirs/projects: memory
  // suggestion generation dedupes by userId+key+value+status (see
  // lib/answers.js's createMemorySuggestions), NOT by which route asked, so a
  // second call against the SAME store for the SAME question would
  // legitimately produce fewer new suggestions than the first — a real
  // behavior, but an irrelevant confound for an equivalence proof. Two
  // independent stores eliminate it entirely.
  const dataDirJson = await mkdtemp(path.join(tmpdir(), "ai-pm-stream-basic-json-"));
  const dataDirStream = await mkdtemp(path.join(tmpdir(), "ai-pm-stream-basic-stream-"));
  const portJson = await getFreePort();
  const portStream = await getFreePort();
  const baseUrlJson = `http://127.0.0.1:${portJson}`;
  const baseUrlStream = `http://127.0.0.1:${portStream}`;
  const jsonServer = spawnServer(portJson, dataDirJson);
  const streamServer = spawnServer(portStream, dataDirStream);

  try {
    await Promise.all([
      waitForServer(baseUrlJson, jsonServer.child),
      waitForServer(baseUrlStream, streamServer.child)
    ]);

    const [importedJson, importedStream] = await Promise.all([
      fetch(`${baseUrlJson}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: true }) }).then((r) => r.json()),
      fetch(`${baseUrlStream}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: true }) }).then((r) => r.json())
    ]);
    const projectIdJson = importedJson.project?.id;
    const projectIdStream = importedStream.project?.id;
    assert(projectIdJson, "JSON-route server: sample import did not return a project id");
    assert(projectIdStream, "stream-route server: sample import did not return a project id");

    const jsonResponse = await fetch(`${baseUrlJson}/api/agent-impact`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: projectIdJson, question: SAMPLE_QUESTION })
    }).then((r) => r.json());
    assertPayloadShape("json-route", jsonResponse.payload);

    const streamResponse = await fetch(`${baseUrlStream}/api/agent-impact/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: projectIdStream, question: SAMPLE_QUESTION })
    });
    const { events, finalPayload } = await consumeSse(streamResponse);
    assert(finalPayload, "expected a final SSE event carrying the complete payload");
    assertPayloadShape("stream-route-final-event", finalPayload.payload);

    // ── Event ordering ──
    assert(events[0].type === "workflow_started", `first event should be workflow_started, got ${events[0].type}`);
    assert(events[events.length - 1].type === "final", `last event should be final, got ${events[events.length - 1].type}`);
    assert(Array.isArray(events[0].data.planned_nodes) && events[0].data.planned_nodes.length === 9,
      `workflow_started should list the 9 planned phaseMap nodes, got ${JSON.stringify(events[0].data.planned_nodes)}`);

    const nodeCompletedEvents = events.filter((event) => event.type === "node_completed");
    const nodeNames = nodeCompletedEvents.map((event) => event.data.node);
    const expectedOrder = ["input_safety", "memory", "classify", "retrieve", "expand_context", "impact_analysis", "qa_plan", "guardrails", "synthesize"];
    assert(nodeNames.length === expectedOrder.length,
      `expected exactly ${expectedOrder.length} node_completed events for a single-pass run, got ${nodeNames.length}: ${JSON.stringify(nodeNames)}`);
    assert(new Set(nodeNames).size === nodeNames.length, `every graph node must appear exactly once, got ${JSON.stringify(nodeNames)}`);
    assert(JSON.stringify(nodeNames) === JSON.stringify(expectedOrder),
      `node_completed events must arrive in phaseMap order, expected ${JSON.stringify(expectedOrder)}, got ${JSON.stringify(nodeNames)}`);
    for (const event of nodeCompletedEvents) {
      assert(typeof event.data.agent_role === "string" && event.data.agent_role.length > 0, `node_completed for "${event.data.node}" must carry a non-empty agent_role`);
      assert(typeof event.data.label === "string" && event.data.label.length > 0, `node_completed for "${event.data.node}" must carry a human-readable label`);
      assert(Number.isFinite(event.data.elapsed_ms) && event.data.elapsed_ms >= 0, `node_completed for "${event.data.node}" must carry a non-negative elapsed_ms`);
    }
    // elapsed_ms must be monotonically non-decreasing across the run.
    for (let i = 1; i < nodeCompletedEvents.length; i += 1) {
      assert(nodeCompletedEvents[i].data.elapsed_ms >= nodeCompletedEvents[i - 1].data.elapsed_ms,
        "elapsed_ms should be non-decreasing across node_completed events");
    }

    // ── Task L2 (D): payload equivalence ──
    function normalize(payload, projectId) {
      const clone = JSON.parse(JSON.stringify(payload));
      clone.harness.run_id = "RUN_ID";
      clone.harness.duration_ms = 0;
      clone.harness.budget_status.duration_ms = 0;
      clone.harness.model_adapter.duration_ms = 0;
      for (const call of clone.harness.model_calls) call.duration_ms = 0;
      if (clone.harness.checkpointing) {
        clone.harness.checkpointing.thread_id = "THREAD_ID";
        clone.harness.checkpointing.latest_checkpoint_id = "CHECKPOINT_ID";
      }
      for (const suggestion of clone.memory_suggestions || []) {
        suggestion.id = "SUGGESTION_ID";
        suggestion.createdAt = "TIMESTAMP";
      }
      // The two servers each import their own fresh copy of the sample
      // project, so projectId itself is a fresh random uuid per run -- not a
      // real payload divergence, just an artifact of the two-independent-
      // servers methodology chosen above. Substituted out wherever it
      // appears (trace step input, memory suggestions, ...) via string
      // replacement rather than hand-enumerating every field it could occur in.
      return JSON.parse(JSON.stringify(clone).split(projectId).join("PROJECT_ID"));
    }
    const normalizedJson = normalize(jsonResponse.payload, projectIdJson);
    const normalizedStream = normalize(finalPayload.payload, projectIdStream);
    assert(JSON.stringify(normalizedJson) === JSON.stringify(normalizedStream),
      `POST /api/agent-impact and POST /api/agent-impact/stream must return equivalent payloads for the same question (modulo run-scoped volatile fields). json=${JSON.stringify(normalizedJson)} stream=${JSON.stringify(normalizedStream)}`);

    return { nodeOrder: nodeNames, eventCount: events.length, equivalenceVerified: true };
  } catch (error) {
    console.error("[basic] json-route stdout:\n" + jsonServer.getStdout());
    console.error("[basic] json-route stderr:\n" + jsonServer.getStderr());
    console.error("[basic] stream-route stdout:\n" + streamServer.getStdout());
    console.error("[basic] stream-route stderr:\n" + streamServer.getStderr());
    throw error;
  } finally {
    await Promise.all([stopChild(jsonServer.child), stopChild(streamServer.child)]);
    await Promise.all([
      rm(dataDirJson, { recursive: true, force: true }),
      rm(dataDirStream, { recursive: true, force: true })
    ]);
  }
}

// ── Scenario 2: bounded QACritic revise round (reusing check-revise-loop.js's fixture) ──
const FIXABLE_PROJECT_FILES = {
  "docs/integration-notes.txt": "This document describes integration considerations for downstream consumers of the module"
};
const REVISE_QUESTION = "As a PM, what should I double check before removing the legacy logging helper?";

async function scenarioReviseLoop() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-stream-revise-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawnServer(port, dataDir);
  try {
    await waitForServer(baseUrl, server.child);
    const imported = await fetch(`${baseUrl}/api/import`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ zipBase64: createZipBase64(FIXABLE_PROJECT_FILES), fileName: "fixable.zip" })
    }).then((r) => r.json());
    const projectId = imported.project?.id;
    assert(projectId, "revise-loop scenario: import did not return a project id");

    const response = await fetch(`${baseUrl}/api/agent-impact/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, question: REVISE_QUESTION })
    });
    const { events, finalPayload } = await consumeSse(response);
    assert(finalPayload, "expected a final SSE event");

    const nodeCompletedCount = events.filter((event) => event.type === "node_completed").length;
    const reviseRoundEvents = events.filter((event) => event.type === "revise_round_entered");
    assert(nodeCompletedCount === 13,
      `expected 13 node_completed events (9 base + 4 for one bounded revise round), got ${nodeCompletedCount}`);
    assert(reviseRoundEvents.length === 1, `expected exactly 1 revise_round_entered event, got ${reviseRoundEvents.length}`);
    const revise = reviseRoundEvents[0].data;
    assert(revise.round >= 1, `revise_round_entered should report round >= 1, got ${revise.round}`);
    assert(Array.isArray(revise.additional_queries) && revise.additional_queries.length > 0,
      "revise_round_entered should carry the critic's additional_queries used for the revise round's retrieval");
    assert(finalPayload.payload.critic_review?.verdict === "approve",
      `expected the revise round to resolve to "approve", got "${finalPayload.payload.critic_review?.verdict}"`);
    assert(finalPayload.payload.harness.revision_rounds === 1, "expected harness.revision_rounds === 1 for this fixture");

    // Both events are derived from the SAME "retrieve" node update chunk (see
    // consumeGraphStreamForWorkflow in lib/agent-graph.js): its trace entry is
    // emitted as node_completed first, then its revisionRound is inspected to
    // decide whether to also emit revise_round_entered -- so revise_round_entered
    // must immediately follow the SECOND "retrieve" node_completed event, not
    // merely land somewhere between the two retrieve executions.
    const retrieveIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "node_completed" && event.data.node === "retrieve")
      .map(({ index }) => index);
    const reviseIndex = events.indexOf(reviseRoundEvents[0]);
    assert(retrieveIndexes.length === 2, `expected exactly 2 "retrieve" node_completed events, got ${retrieveIndexes.length}`);
    assert(reviseIndex === retrieveIndexes[1] + 1,
      `revise_round_entered (index ${reviseIndex}) should immediately follow the second retrieve's node_completed event (index ${retrieveIndexes[1]})`);

    return { nodeCompletedCount, reviseRounds: finalPayload.payload.harness.revision_rounds };
  } catch (error) {
    console.error("[revise] stdout:\n" + server.getStdout());
    console.error("[revise] stderr:\n" + server.getStderr());
    throw error;
  } finally {
    await stopChild(server.child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ── Scenario 3: HITL native-interrupt pause arrives as a stream event ──
const HIGH_RISK_QUESTION = "I am a PM. Give a concise risk impact analysis for adding order status partially_refunded.";

async function scenarioHitlPause() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-stream-hitl-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawnServer(port, dataDir, { AGENT_HITL_ENABLED: "true" });
  try {
    await waitForServer(baseUrl, server.child);
    const imported = await fetch(`${baseUrl}/api/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: true })
    }).then((r) => r.json());
    const projectId = imported.project?.id;
    assert(projectId, "hitl scenario: sample import did not return a project id");

    const response = await fetch(`${baseUrl}/api/agent-impact/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, question: HIGH_RISK_QUESTION })
    });
    const { events, finalPayload } = await consumeSse(response);
    assert(finalPayload, "expected a final SSE event even for a paused run");

    const nodeCompletedCount = events.filter((event) => event.type === "node_completed").length;
    const hitlPausedEvents = events.filter((event) => event.type === "hitl_paused");
    // synthesize never runs for a paused run -- human_review's interrupt()
    // throws before it can return, so only the 8 nodes before it (input_safety
    // .. guardrails) ever complete.
    assert(nodeCompletedCount === 8, `expected 8 node_completed events before the pause (synthesize never runs), got ${nodeCompletedCount}`);
    assert(hitlPausedEvents.length === 1, `expected exactly 1 hitl_paused event, got ${hitlPausedEvents.length}`);
    assert(hitlPausedEvents[0].data.risk_level === "high", `hitl_paused should report risk_level "high", got "${hitlPausedEvents[0].data.risk_level}"`);
    // hitl_paused must be the second-to-last event (immediately before final).
    assert(events[events.length - 2].type === "hitl_paused", "hitl_paused should immediately precede the final event");

    assert(finalPayload.payload.hitl?.paused === true, "final payload must report hitl.paused === true");
    assert(finalPayload.payload.hitl?.decision === null, "paused final payload should not carry a decision yet");
    assert(finalPayload.payload.summary.startsWith("[HITL PAUSED"), `final payload summary should carry the HITL paused marker, got "${finalPayload.payload.summary}"`);
    assert(finalPayload.payload.harness?.checkpointing?.enabled === true, "a paused streamed run should still persist LangGraph checkpoints");

    return { nodeCompletedCount, hitlPaused: finalPayload.payload.hitl.paused };
  } catch (error) {
    console.error("[hitl] stdout:\n" + server.getStdout());
    console.error("[hitl] stderr:\n" + server.getStderr());
    throw error;
  } finally {
    await stopChild(server.child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ── Scenario 4: client disconnect aborts the workflow (Task L2 (E)) ──
// A fake OpenAI-compatible endpoint that sleeps briefly before responding, so
// each of the 3 real model calls (Supervisor/ImpactAnalyst/QACritic) is a
// genuine local network round trip. This matters: verified empirically that a
// fully offline (no API key) run is synchronous end-to-end (node:sqlite is a
// synchronous API; retrieval/impact generation is pure CPU work) and never
// yields to the Node.js event loop between nodes at all -- an abort signal
// raised from OUTSIDE that run's own stream-consumption loop (exactly like a
// real socket "close" event, which is what this scenario is proving) is
// provably never observed until the whole run finishes regardless of how the
// abort is wired, because V8 fully drains its microtask queue before
// servicing any macrotask. A real deployment always has this same async yield
// point (a real LLM call is real network I/O), so this fake server exercises
// the exact mechanism this scenario needs to prove without requiring a live
// OpenAI-compatible endpoint.
function startSlowFakeLlmServer(delayMs) {
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
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    let payload;
    if (systemContent.includes("You are the Supervisor agent")) {
      payload = {
        intent: "impact_analysis", risk_hypothesis: "medium",
        required_agents: ["ImpactAnalyst", "QACritic"],
        retrieval_queries: ["order status model schema service"],
        require_human_review: false,
        rationale: "Order status changes touch the data model and service layer."
      };
    } else if (systemContent.includes("You are the QACritic agent")) {
      payload = {
        verdict: "approve", summary: "Evidence is sufficient.",
        findings: [{ severity: "medium", finding: "Covered.", evidence_files: ["src/models/order.ts"] }],
        testing_suggestions: ["Exercise every order status transition."],
        open_questions: [], additional_queries: []
      };
    } else {
      payload = {
        summary: "Adding a new order status value changes the order data model.",
        impact_areas: [{ area: "Data Model", risk_level: "medium", reason: "Order status enum changes shape.", files: ["src/models/order.ts"] }],
        testing_suggestions: ["Add a regression test for the new order status."],
        open_questions: [],
        briefing: {
          summary: "This adds a new order status value.",
          affected_flows: [{ flow: "Order lifecycle", why: "New status value." }],
          testing_focus: ["Verify existing transitions still work."],
          risk_note: "Medium risk."
        }
      };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function scenarioAbortOnDisconnect() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-stream-abort-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeLlm = await startSlowFakeLlmServer(150);
  const server = spawnServer(port, dataDir, {
    OPENAI_API_KEY: "fake-abort-test-key",
    OPENAI_BASE_URL: fakeLlm.baseUrl,
    OPENAI_MODEL: "fake-abort-test-model"
  });
  try {
    await waitForServer(baseUrl, server.child);
    const imported = await fetch(`${baseUrl}/api/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: true })
    }).then((r) => r.json());
    const projectId = imported.project?.id;
    assert(projectId, "abort scenario: sample import did not return a project id");

    const response = await fetch(`${baseUrl}/api/agent-impact/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, question: SAMPLE_QUESTION })
    });
    assert(response.ok, "abort scenario: expected an ok stream response");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events = [];
    let disconnected = false;
    while (!disconnected) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex;
      while (!disconnected && (separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const eventMatch = rawEvent.match(/^event: (.+)$/m);
        const dataMatch = rawEvent.match(/^data: (.+)$/m);
        if (!eventMatch || !dataMatch) continue;
        events.push(eventMatch[1]);
        // Disconnect after workflow_started + 2 node_completed events --
        // still mid-run (the fake LLM's 150ms delay means Supervisor's real
        // model call, and likely ImpactAnalyst's, have not resolved yet).
        if (events.length >= 3) disconnected = true;
      }
    }
    await reader.cancel().catch(() => {});

    assert(!events.includes("final"), `a disconnected stream must not have delivered a final event, saw: ${JSON.stringify(events)}`);
    assert(events.length < 11, `expected to disconnect well before a full single-pass run's ~11 events, saw ${events.length}: ${JSON.stringify(events)}`);

    // Give the abort a moment to propagate, then verify the server is still
    // healthy (no crash, no lingering handle preventing normal operation) and
    // that the aborted run left no trace in the store.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert(server.child.exitCode === null, "server process must still be alive after a client disconnect");
    const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    assert(health.status === "ok", "server must still respond healthy after an aborted stream");

    const answersAfter = await fetch(`${baseUrl}/api/answers?projectId=${projectId}`).then((r) => r.json());
    const agentAnswersAfter = (answersAfter.answers || []).filter((item) => item.kind === "agent_impact");
    assert(agentAnswersAfter.length === 0, `an aborted stream run must not write an answer record to the store, found ${agentAnswersAfter.length}`);

    const stderr = server.getStderr();
    assert(!stderr.toLowerCase().includes("unhandledrejection"), `expected no unhandled rejection in server stderr, got:\n${stderr}`);

    return { eventsBeforeDisconnect: events.length, answersWrittenAfterAbort: agentAnswersAfter.length };
  } catch (error) {
    console.error("[abort] stdout:\n" + server.getStdout());
    console.error("[abort] stderr:\n" + server.getStderr());
    throw error;
  } finally {
    await stopChild(server.child);
    await new Promise((resolve) => fakeLlm.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ── Scenario 5: progressive delivery, not batch-then-flush ──
// Fake LLM per-call delay for this scenario. 3 real model calls
// (Supervisor/ImpactAnalyst/QACritic) means a genuinely streaming server
// spreads its 9 node_completed events across roughly 3 * PROGRESSIVE_DELAY_MS
// of wall-clock time (input_safety completes near t=0, before Supervisor's
// own call; synthesize completes near the end, after all 3 calls have
// resolved) -- so the gap between the FIRST event received (workflow_started,
// arrives immediately) and the LAST node_completed event received should
// cover nearly the entire run. A batch-then-flush server instead writes every
// event in one burst immediately before "final", so that same gap collapses
// to roughly zero regardless of how long the run actually took internally.
// PROGRESSIVE_DELAY_MS=300 keeps the real server's expected spread
// (~900ms+ for 3 calls) comfortably far from both the ratio and absolute-ms
// thresholds below (see their own comments for the margin reasoning), while
// staying fast enough not to meaningfully slow the check suite.
const PROGRESSIVE_DELAY_MS = 300;
// Ratio threshold: spread / totalDuration, where spread is measured strictly
// between the FIRST and LAST node_completed event (NOT from workflow_started
// -- workflow_started is emitted eagerly by runAgenticImpactWorkflow itself,
// outside consumeGraphStreamForWorkflow's per-node loop, so it fires at t=0
// under EITHER a real streaming implementation OR a batch-then-flush one;
// anchoring the spread on it would fail to catch a regression that only
// delays the node_completed events themselves. Mutation-verified: an earlier
// draft of this scenario anchored on workflow_started and did NOT fail
// against a buffer-then-flush mutation of consumeGraphStreamForWorkflow --
// ratio still read ~0.96 because workflow_started's own early timestamp
// alone produced a large gap to the (now-late) last node_completed event,
// even though every node_completed event was itself clustered in one burst.
// Anchoring on the first node_completed event closes that gap: under a real
// streaming implementation, input_safety (the first node) still completes
// almost immediately (before Supervisor's own model call), so the ratio is
// essentially unchanged for a healthy server (~0.95+); under the same
// buffer-then-flush mutation, EVERY node_completed event -- including the
// first -- is now delayed to the same late burst, collapsing the ratio to
// ~0. A real streaming server lands close to 1.0; a batch-then-flush server
// lands close to 0.0. 0.4 sits at roughly half the real value and several
// times the batched value -- generous margin on both sides, and a RATIO (not
// an absolute ms figure) so it does not depend on how fast the machine
// running the check happens to be: a slower CI box inflates both the spread
// and the total duration together, leaving their ratio essentially unchanged.
const PROGRESSIVE_MIN_RATIO = 0.4;
// Absolute floor as a second, independent signal: real spread should be on
// the order of 2 * PROGRESSIVE_DELAY_MS (Supervisor's call plus
// ImpactAnalyst's/QACritic's own calls elapsing before the run's last event);
// batched delivery collapses this to a few ms of pure SSE-frame-parsing
// overhead. 150ms (half of one single fake-LLM delay) is far below the
// expected real value and far above what batching alone could produce on any
// reasonable machine, without being so tight that normal scheduler jitter on
// a loaded CI box could trip it.
const PROGRESSIVE_MIN_SPREAD_MS = 150;

async function scenarioProgressiveDelivery() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-stream-progressive-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeLlm = await startSlowFakeLlmServer(PROGRESSIVE_DELAY_MS);
  const server = spawnServer(port, dataDir, {
    OPENAI_API_KEY: "fake-progressive-test-key",
    OPENAI_BASE_URL: fakeLlm.baseUrl,
    OPENAI_MODEL: "fake-progressive-test-model"
  });
  try {
    await waitForServer(baseUrl, server.child);
    const imported = await fetch(`${baseUrl}/api/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: true })
    }).then((r) => r.json());
    const projectId = imported.project?.id;
    assert(projectId, "progressive-delivery scenario: sample import did not return a project id");

    const requestStartedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/agent-impact/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, question: SAMPLE_QUESTION })
    });
    assert(response.ok, "progressive-delivery scenario: expected an ok stream response");

    // Deliberately NOT using consumeSse() here: this scenario's whole point is
    // the wall-clock moment each frame is received by the client, which must
    // be stamped the instant each complete frame is parsed out of the byte
    // stream -- not after the fact from the parsed event list.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const receivedEvents = [];
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let separatorIndex;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const eventMatch = rawEvent.match(/^event: (.+)$/m);
        const dataMatch = rawEvent.match(/^data: (.+)$/m);
        if (!eventMatch || !dataMatch) continue;
        receivedEvents.push({ type: eventMatch[1], data: JSON.parse(dataMatch[1]), receivedAt: Date.now() });
      }
      if (done) break;
    }

    const finalEvent = receivedEvents.find((event) => event.type === "final");
    assert(finalEvent, "progressive-delivery scenario: expected a final event");
    const nodeCompletedEvents = receivedEvents.filter((event) => event.type === "node_completed");
    assert(nodeCompletedEvents.length === 9, `expected 9 node_completed events for a single-pass run, got ${nodeCompletedEvents.length}`);

    // Anchored on the first and last node_completed events specifically (see
    // PROGRESSIVE_MIN_RATIO's comment above for why workflow_started must
    // NOT be used as the start anchor).
    const firstNodeCompletedReceivedAt = nodeCompletedEvents[0].receivedAt;
    const lastNodeCompletedReceivedAt = nodeCompletedEvents[nodeCompletedEvents.length - 1].receivedAt;
    const totalMs = finalEvent.receivedAt - requestStartedAt;
    const spreadMs = lastNodeCompletedReceivedAt - firstNodeCompletedReceivedAt;
    const ratio = totalMs > 0 ? spreadMs / totalMs : 0;

    assert(spreadMs >= PROGRESSIVE_MIN_SPREAD_MS,
      `node_completed events arrived too close together (${spreadMs}ms) to be genuinely progressive -- a batch-then-flush server would produce a near-zero spread regardless of elapsed_ms values. Expected >= ${PROGRESSIVE_MIN_SPREAD_MS}ms with a ${PROGRESSIVE_DELAY_MS}ms fake-LLM delay per call.`);
    assert(ratio >= PROGRESSIVE_MIN_RATIO,
      `first-to-last node_completed arrival spread (${spreadMs}ms) is too small a fraction of the total run (${totalMs}ms) -- ratio ${ratio.toFixed(3)} < ${PROGRESSIVE_MIN_RATIO}. A batch-then-flush server clusters every event at the end, collapsing this ratio toward 0.`);

    return { totalMs, spreadMs, ratio: Number(ratio.toFixed(3)), nodeCompletedCount: nodeCompletedEvents.length };
  } catch (error) {
    console.error("[progressive] stdout:\n" + server.getStdout());
    console.error("[progressive] stderr:\n" + server.getStderr());
    throw error;
  } finally {
    await stopChild(server.child);
    await new Promise((resolve) => fakeLlm.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const basic = await scenarioBasicOrderingAndEquivalence();
  const revise = await scenarioReviseLoop();
  const hitl = await scenarioHitlPause();
  const abort = await scenarioAbortOnDisconnect();
  const progressive = await scenarioProgressiveDelivery();

  console.log(JSON.stringify({
    ok: true,
    scenario: "agent-impact-stream-sse",
    basic,
    revise,
    hitl,
    abort,
    progressive
  }, null, 2));
}

await main();
