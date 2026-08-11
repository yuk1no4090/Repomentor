import crypto from "node:crypto";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { DEFAULT_USER_ID, apiError, normalizeUserId } from "./config.js";
import { getMemoryDatabase, getCachedStatement, runInSqliteTransaction } from "./memory-db.js";

// ── Collaborators injected by server.js ──
// buildLangGraphReplay()/findLangGraphCheckpoint()/runLangGraphResumeFromCheckpoint()
// need findProject(), findHarnessRunAudit() and runAgenticImpactWorkflow(). findProject
// lives in lib/importer.js and runAgenticImpactWorkflow now lives in lib/agent-graph.js —
// both dependency-free with respect to server.js, so server.js simply re-exports them
// here via injection rather than this module importing lib/agent-graph.js directly
// (which would otherwise need to import lib/checkpoints.js right back for
// deserializeMemorySaverSnapshot/persistLangGraphCheckpoints, an import cycle).
// findHarnessRunAudit() still stays in server.js itself (see refactor report) since it
// composes findProject, listLangGraphCheckpoints, and lib/agent-graph.js's
// createHarnessRunSnapshot — none of which lib/checkpoints.js may import without
// risking the same cycle. Server.js injects all three once at startup via
// setCheckpointCollaborators(), before any checkpoint route is served.
let collaborators = null;

export function setCheckpointCollaborators(fns) {
  collaborators = fns;
}

function getCollaborators() {
  if (!collaborators) {
    throw new Error("[checkpoints] setCheckpointCollaborators() must be called before use.");
  }
  return collaborators;
}

function summarizeCheckpointTuple(tuple) {
  const values = tuple?.checkpoint?.channel_values || {};
  const finalPayload = values.finalPayload || values.synthesize?.finalPayload || null;
  const trace = values.trace || finalPayload?.trace || [];
  const memoryUsed = values.memoryUsed || finalPayload?.memory_used || null;
  const safety = finalPayload?.safety || values.outputSafety || values.inputSafety || null;
  return {
    channel_keys: Object.keys(values).sort(),
    trace_steps: Array.isArray(trace) ? trace.length : 0,
    memory_used: memoryUsed
      ? {
          used: !!memoryUsed.used,
          summary: typeof memoryUsed.summary === "string" ? memoryUsed.summary.slice(0, 500) : "none",
          long_term_count: Array.isArray(memoryUsed.long_term) ? memoryUsed.long_term.length : 0
        }
      : null,
    safety_status: safety?.status || "unknown",
    risk_types: Array.isArray(safety?.risk_types) ? safety.risk_types : [],
    related_files_count: Array.isArray(finalPayload?.related_files) ? finalPayload.related_files.length : 0
  };
}

function bytesToBase64(value) {
  return Buffer.from(value || []).toString("base64");
}

function base64ToBytes(value) {
  return Uint8Array.from(Buffer.from(String(value || ""), "base64"));
}

function serializeMemorySaverSnapshot(checkpointer) {
  const storage = {};
  for (const [threadId, namespaces] of Object.entries(checkpointer.storage || {})) {
    storage[threadId] = {};
    for (const [namespace, checkpoints] of Object.entries(namespaces || {})) {
      storage[threadId][namespace] = {};
      for (const [checkpointId, entry] of Object.entries(checkpoints || {})) {
        const [checkpoint, metadata, parentCheckpointId] = entry;
        storage[threadId][namespace][checkpointId] = [
          bytesToBase64(checkpoint),
          bytesToBase64(metadata),
          parentCheckpointId
        ];
      }
    }
  }
  const writes = {};
  for (const [outerKey, inner] of Object.entries(checkpointer.writes || {})) {
    writes[outerKey] = {};
    for (const [innerKey, entry] of Object.entries(inner || {})) {
      const [taskId, channel, value] = entry;
      writes[outerKey][innerKey] = [taskId, channel, bytesToBase64(value)];
    }
  }
  return { version: 1, storage, writes };
}

function deserializeMemorySaverSnapshot(payload, { sourceThreadId = null, targetThreadId = null } = {}) {
  const checkpointer = new MemorySaver();
  const threadMap = sourceThreadId && targetThreadId && sourceThreadId !== targetThreadId
    ? { [sourceThreadId]: targetThreadId }
    : {};
  for (const [threadId, namespaces] of Object.entries(payload?.storage || {})) {
    const mappedThreadId = threadMap[threadId] || threadId;
    checkpointer.storage[mappedThreadId] ||= Object.create(null);
    for (const [namespace, checkpoints] of Object.entries(namespaces || {})) {
      checkpointer.storage[mappedThreadId][namespace] ||= Object.create(null);
      for (const [checkpointId, entry] of Object.entries(checkpoints || {})) {
        const [checkpoint, metadata, parentCheckpointId] = entry;
        checkpointer.storage[mappedThreadId][namespace][checkpointId] = [
          base64ToBytes(checkpoint),
          base64ToBytes(metadata),
          parentCheckpointId
        ];
      }
    }
  }
  for (const [outerKey, inner] of Object.entries(payload?.writes || {})) {
    let mappedOuterKey = outerKey;
    if (sourceThreadId && targetThreadId && sourceThreadId !== targetThreadId) {
      try {
        const [threadId, namespace, checkpointId] = JSON.parse(outerKey);
        if (threadId === sourceThreadId) mappedOuterKey = JSON.stringify([targetThreadId, namespace, checkpointId]);
      } catch {
        mappedOuterKey = outerKey;
      }
    }
    checkpointer.writes[mappedOuterKey] ||= Object.create(null);
    for (const [innerKey, entry] of Object.entries(inner || {})) {
      const [taskId, channel, value] = entry;
      checkpointer.writes[mappedOuterKey][innerKey] = [taskId, channel, base64ToBytes(value)];
    }
  }
  return checkpointer;
}

function persistLangGraphCheckpointPayload({ projectId, runId, threadId, checkpointer }) {
  const payload = serializeMemorySaverSnapshot(checkpointer);
  const db = getMemoryDatabase();
  getCachedStatement(db, `
    INSERT OR REPLACE INTO langgraph_checkpoint_payloads (
      run_id, project_id, thread_id, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(runId, projectId || null, threadId, JSON.stringify(payload), new Date().toISOString());
  return {
    persisted: true,
    store: "SQLite langgraph_checkpoint_payloads",
    version: payload.version
  };
}

function loadLangGraphCheckpointPayload({ projectId, runId }) {
  if (!runId) return null;
  const row = getMemoryDatabase().prepare(`
    SELECT * FROM langgraph_checkpoint_payloads
    WHERE run_id = ? AND (? IS NULL OR project_id = ?)
  `).get(runId, projectId || null, projectId || null);
  if (!row) return null;
  return {
    run_id: row.run_id,
    projectId: row.project_id,
    thread_id: row.thread_id,
    payload: JSON.parse(row.payload_json || "{}"),
    createdAt: row.created_at
  };
}

async function persistLangGraphCheckpoints({ projectId, runId, threadId, checkpointer, resumeInput = null }) {
  const db = getMemoryDatabase();
  const rows = [];
  for await (const tuple of checkpointer.list({ configurable: { thread_id: threadId } })) {
    rows.push(tuple);
  }
  const deleteExisting = getCachedStatement(db, "DELETE FROM langgraph_checkpoints WHERE run_id = ?");
  const insert = getCachedStatement(db, `
    INSERT INTO langgraph_checkpoints (
      id, run_id, project_id, thread_id, checkpoint_id, parent_checkpoint_id,
      source, step, node, metadata_json, state_summary_json, resume_input_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Replacing a run's checkpoint history is a delete-then-bulk-insert; wrap it
  // in one transaction so a mid-loop failure can't leave the table with the
  // old rows deleted but only some of the new rows written.
  runInSqliteTransaction(db, () => {
    deleteExisting.run(runId);
    rows.forEach((tuple) => {
      const checkpointId = tuple.checkpoint?.id || tuple.config?.configurable?.checkpoint_id || crypto.randomUUID();
      const parentCheckpointId = tuple.parentConfig?.configurable?.checkpoint_id || null;
      const metadata = tuple.metadata || {};
      const writes = metadata.writes && typeof metadata.writes === "object" ? Object.keys(metadata.writes) : [];
      const createdAt = tuple.checkpoint?.ts || new Date().toISOString();
      insert.run(
        `${runId}:${checkpointId}`,
        runId,
        projectId || null,
        threadId,
        checkpointId,
        parentCheckpointId,
        metadata.source || null,
        Number.isFinite(Number(metadata.step)) ? Number(metadata.step) : null,
        writes[0] || null,
        JSON.stringify(metadata),
        JSON.stringify(summarizeCheckpointTuple(tuple)),
        resumeInput ? JSON.stringify(resumeInput) : null,
        createdAt
      );
    });
  });
  const latest = rows[0];
  const payloadPersistence = persistLangGraphCheckpointPayload({ projectId, runId, threadId, checkpointer });
  return {
    enabled: true,
    saver: "MemorySaver",
    persisted: true,
    executable_resume: true,
    store: "SQLite langgraph_checkpoints",
    payload_store: payloadPersistence.store,
    thread_id: threadId,
    checkpoint_count: rows.length,
    latest_checkpoint_id: latest?.checkpoint?.id || null
  };
}

function listLangGraphCheckpoints({ projectId = null, runId = null, limit = 20 } = {}) {
  const db = getMemoryDatabase();
  const params = [];
  const clauses = [];
  if (projectId) {
    clauses.push("project_id = ?");
    params.push(projectId);
  }
  if (runId) {
    clauses.push("run_id = ?");
    params.push(runId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT * FROM langgraph_checkpoints
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(normalizeLangGraphCheckpointRow).filter(Boolean);
}

function normalizeLangGraphCheckpointRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_id: row.run_id,
    projectId: row.project_id,
    thread_id: row.thread_id,
    checkpoint_id: row.checkpoint_id,
    parent_checkpoint_id: row.parent_checkpoint_id,
    source: row.source,
    step: row.step,
    node: row.node,
    metadata: JSON.parse(row.metadata_json || "{}"),
    state_summary: JSON.parse(row.state_summary_json || "{}"),
    resume_input: row.resume_input_json ? JSON.parse(row.resume_input_json) : null,
    resumable: !!row.resume_input_json,
    createdAt: row.created_at
  };
}

function findLangGraphCheckpoint(store, { projectId, runId, checkpointId, userId = null }) {
  const { findProject } = getCollaborators();
  findProject(store, projectId, userId);
  if (!runId) throw apiError("Run id is required.", "RUN_ID_REQUIRED");
  if (!checkpointId) throw apiError("Checkpoint id is required.", "CHECKPOINT_ID_REQUIRED");
  const row = getMemoryDatabase().prepare(`
    SELECT * FROM langgraph_checkpoints
    WHERE project_id = ? AND run_id = ? AND checkpoint_id = ?
  `).get(projectId, runId, checkpointId);
  if (!row) throw apiError("LangGraph checkpoint not found.", "LANGGRAPH_CHECKPOINT_NOT_FOUND", 404);
  return normalizeLangGraphCheckpointRow(row);
}

function buildLangGraphReplay(store, { projectId, runId }) {
  const { findHarnessRunAudit } = getCollaborators();
  if (!runId) throw apiError("Run id is required.", "RUN_ID_REQUIRED");
  const audit = findHarnessRunAudit(store, projectId, runId);
  if (audit.run.runtime !== "LangGraph StateGraph") {
    throw apiError("Harness run is not a LangGraph workflow.", "LANGGRAPH_REPLAY_UNSUPPORTED", 400);
  }
  const checkpoints = listLangGraphCheckpoints({ projectId, runId, limit: 100 })
    .sort((left, right) => {
      const leftStep = Number.isFinite(Number(left.step)) ? Number(left.step) : Number.MAX_SAFE_INTEGER;
      const rightStep = Number.isFinite(Number(right.step)) ? Number(right.step) : Number.MAX_SAFE_INTEGER;
      if (leftStep !== rightStep) return leftStep - rightStep;
      return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    });
  if (!checkpoints.length) {
    throw apiError("LangGraph checkpoints are not available for this run.", "LANGGRAPH_REPLAY_UNAVAILABLE", 404);
  }
  const replaySteps = checkpoints.map((checkpoint, index) => ({
    index,
    checkpoint_id: checkpoint.checkpoint_id,
    parent_checkpoint_id: checkpoint.parent_checkpoint_id,
    step: checkpoint.step,
    node: checkpoint.node || checkpoint.metadata?.source || "unknown",
    source: checkpoint.source,
    createdAt: checkpoint.createdAt,
    state_summary: checkpoint.state_summary
  }));
  return {
    run: audit.run,
    replay: {
      mode: "checkpoint summary replay",
      executable: false,
      deterministic: true,
      checkpoint_count: checkpoints.length,
      first_checkpoint_id: replaySteps[0]?.checkpoint_id || null,
      latest_checkpoint_id: replaySteps[replaySteps.length - 1]?.checkpoint_id || null,
      note: "Replay reconstructs the persisted checkpoint timeline for audit only; it does not invoke the graph, tools, model, or mutate state."
    },
    steps: replaySteps,
    answer: audit.answer
      ? {
          answer_id: audit.answer.answer_id,
          kind: audit.answer.kind,
          trace_steps: Array.isArray(audit.answer.trace) ? audit.answer.trace.length : 0,
          safety_status: audit.answer.safety?.status || "unknown",
          harness_run_id: audit.answer.harness?.run_id || runId
        }
      : null
  };
}

async function runLangGraphResumeFromCheckpoint(store, { projectId, runId, checkpointId = null, userId = DEFAULT_USER_ID, decision = null } = {}) {
  const { findProject, runAgenticImpactWorkflow } = getCollaborators();
  if (!runId) throw apiError("Run id is required.", "RUN_ID_REQUIRED");
  findProject(store, projectId, userId);
  const checkpoint = checkpointId
    ? findLangGraphCheckpoint(store, { projectId, runId, checkpointId })
    : listLangGraphCheckpoints({ projectId, runId, limit: 1 })[0];
  if (!checkpoint) throw apiError("LangGraph checkpoint not found.", "LANGGRAPH_CHECKPOINT_NOT_FOUND", 404);
  const resumeInput = checkpoint.resume_input;
  if (!resumeInput?.projectId || !resumeInput?.question) {
    throw apiError("LangGraph checkpoint does not include a resumable input snapshot.", "LANGGRAPH_RESUME_UNAVAILABLE", 409);
  }
  const normalizedUserId = normalizeUserId(userId);
  const resumeUserId = normalizeUserId(resumeInput.userId || DEFAULT_USER_ID);
  if (resumeUserId !== normalizedUserId) {
    throw apiError("LangGraph checkpoint belongs to a different user.", "LANGGRAPH_RESUME_USER_MISMATCH", 403);
  }
  const project = findProject(store, resumeInput.projectId, normalizedUserId);
  const checkpointPayload = loadLangGraphCheckpointPayload({ projectId: resumeInput.projectId, runId });
  const resumeMode = checkpointPayload ? "checkpoint_continuation" : "input_snapshot_reexecution";
  const payload = await runAgenticImpactWorkflow(
    store,
    project,
    String(resumeInput.question || ""),
    normalizedUserId,
    {
      mode: resumeMode,
      sourceRunId: runId,
      sourceThreadId: checkpoint.thread_id,
      sourceCheckpointId: checkpoint.checkpoint_id,
      checkpointPayload,
      pausedDecision: decision || null
    }
  );
  return {
    project,
    checkpoint,
    question: String(resumeInput.question || ""),
    payload
  };
}


export {
  summarizeCheckpointTuple,
  bytesToBase64,
  base64ToBytes,
  serializeMemorySaverSnapshot,
  deserializeMemorySaverSnapshot,
  persistLangGraphCheckpointPayload,
  loadLangGraphCheckpointPayload,
  persistLangGraphCheckpoints,
  listLangGraphCheckpoints,
  normalizeLangGraphCheckpointRow,
  findLangGraphCheckpoint,
  buildLangGraphReplay,
  runLangGraphResumeFromCheckpoint
};
