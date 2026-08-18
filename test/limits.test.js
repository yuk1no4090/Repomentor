import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setStoreRecordNormalizers, normalizeStore } from "../lib/store.js";
import {
  normalizeAuthUserRecord, normalizeAuthTokenRecord, normalizeAuthEvent,
  mergeAuthUsersWithConfiguredTokens
} from "../lib/auth.js";
import { normalizeHarnessRun } from "../lib/agent-graph.js";
import { createEmptyPreferences, normalizePreferences } from "../lib/answers.js";
import { normalizeMemorySuggestion, normalizeMemoryEvent } from "../lib/memory-db.js";
import {
  STORE_MAX_QUESTIONS, STORE_MAX_ANSWERS, STORE_MAX_HARNESS_RUNS, STORE_MAX_MEMORY_EVENTS
} from "../lib/config.js";

// normalizeStore() (lib/store.js) delegates normalization of several
// sub-collections to helper functions server.js normally injects at startup
// via setStoreRecordNormalizers(); wiring the *real* functions from their
// owning lib modules here (rather than stubs) lets this test call the actual
// normalizeStore() exactly as server.js would, per AGENTS.md's "call the real
// function" convention.
setStoreRecordNormalizers({
  normalizeAuthUserRecord,
  normalizeAuthTokenRecord,
  normalizeAuthEvent,
  normalizeHarnessRun,
  createEmptyPreferences,
  normalizePreferences,
  normalizeMemorySuggestion,
  normalizeMemoryEvent,
  mergeAuthUsersWithConfiguredTokens
});

function makeQuestions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `q-${index}`,
    projectId: "proj-1",
    question: `question ${index}`,
    kind: "qa",
    createdAt: new Date(index * 1000).toISOString()
  }));
}

function makeAnswers(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `a-${index}`,
    projectId: "proj-1",
    questionId: `q-${index}`,
    kind: "qa",
    payload: {},
    responseTimeMs: 10,
    createdAt: new Date(index * 1000).toISOString()
  }));
}

function makeHarnessRuns(count) {
  return Array.from({ length: count }, (_, index) => ({
    run_id: `run-${index}`,
    projectId: "proj-1",
    kind: "qa",
    runtime: "deterministic"
  }));
}

function makeMemoryEvents(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `mem-${index}`,
    projectId: "proj-1",
    action: "created",
    key: "role",
    value: "Backend Engineer",
    createdAt: new Date(index * 1000).toISOString()
  }));
}

describe("normalizeStore() collection caps (lib/store.js)", () => {
  test("questions beyond STORE_MAX_QUESTIONS are trimmed to the most recent N", () => {
    const overflow = STORE_MAX_QUESTIONS + 5;
    const store = normalizeStore({ questions: makeQuestions(overflow) });
    assert.equal(store.questions.length, STORE_MAX_QUESTIONS);
    // Most recent (highest index) entries survive, not the first N.
    assert.equal(store.questions[0].id, `q-5`);
    assert.equal(store.questions[store.questions.length - 1].id, `q-${overflow - 1}`);
  });

  test("answers beyond STORE_MAX_ANSWERS are trimmed to the most recent N", () => {
    const overflow = STORE_MAX_ANSWERS + 5;
    const store = normalizeStore({ answers: makeAnswers(overflow) });
    assert.equal(store.answers.length, STORE_MAX_ANSWERS);
    assert.equal(store.answers[0].id, `a-5`);
    assert.equal(store.answers[store.answers.length - 1].id, `a-${overflow - 1}`);
  });

  test("harnessRuns beyond STORE_MAX_HARNESS_RUNS are trimmed to the most recent N", () => {
    const overflow = STORE_MAX_HARNESS_RUNS + 5;
    const store = normalizeStore({ harnessRuns: makeHarnessRuns(overflow) });
    assert.equal(store.harnessRuns.length, STORE_MAX_HARNESS_RUNS);
    assert.equal(store.harnessRuns[0].run_id, `run-5`);
    assert.equal(store.harnessRuns[store.harnessRuns.length - 1].run_id, `run-${overflow - 1}`);
  });

  test("memoryEvents beyond STORE_MAX_MEMORY_EVENTS are trimmed to the most recent N", () => {
    const overflow = STORE_MAX_MEMORY_EVENTS + 5;
    const store = normalizeStore({ memoryEvents: makeMemoryEvents(overflow) });
    assert.equal(store.memoryEvents.length, STORE_MAX_MEMORY_EVENTS);
    assert.equal(store.memoryEvents[0].id, `mem-5`);
    assert.equal(store.memoryEvents[store.memoryEvents.length - 1].id, `mem-${overflow - 1}`);
  });

  test("collections under the cap are left untouched", () => {
    const store = normalizeStore({
      questions: makeQuestions(3),
      answers: makeAnswers(3),
      harnessRuns: makeHarnessRuns(3),
      memoryEvents: makeMemoryEvents(3)
    });
    assert.equal(store.questions.length, 3);
    assert.equal(store.answers.length, 3);
    assert.equal(store.harnessRuns.length, 3);
    assert.equal(store.memoryEvents.length, 3);
    assert.deepEqual(store.questions.map((item) => item.id), ["q-0", "q-1", "q-2"]);
  });

  test("non-array questions/answers/harnessRuns/memoryEvents default to an empty array", () => {
    const store = normalizeStore({ questions: "not-an-array", answers: null, harnessRuns: 42, memoryEvents: {} });
    assert.deepEqual(store.questions, []);
    assert.deepEqual(store.answers, []);
    assert.deepEqual(store.harnessRuns, []);
    assert.deepEqual(store.memoryEvents, []);
  });

  test("feedback referencing an answer trimmed away by STORE_MAX_ANSWERS is dropped, feedback for a retained answer survives", () => {
    const overflow = STORE_MAX_ANSWERS + 2;
    const answers = makeAnswers(overflow);
    const store = normalizeStore({
      answers,
      feedback: [
        // a-0 falls outside the retained window (the oldest 2 of `overflow` answers are trimmed away).
        { id: "fb-orphan", projectId: "proj-1", answerId: "a-0", type: "helpful", createdAt: new Date().toISOString() },
        // The most recent answer is always retained.
        { id: "fb-kept", projectId: "proj-1", answerId: `a-${overflow - 1}`, type: "helpful", createdAt: new Date().toISOString() }
      ]
    });
    assert.equal(store.answers.length, STORE_MAX_ANSWERS);
    assert.deepEqual(store.feedback.map((item) => item.id), ["fb-kept"]);
  });

  test("feedback is untouched when its answer is within the retained window", () => {
    const store = normalizeStore({
      answers: makeAnswers(3),
      feedback: [
        { id: "fb-1", projectId: "proj-1", answerId: "a-0", type: "helpful", createdAt: new Date().toISOString() },
        { id: "fb-2", projectId: "proj-1", answerId: "a-2", type: "not_helpful", createdAt: new Date().toISOString() }
      ]
    });
    assert.deepEqual(store.feedback.map((item) => item.id), ["fb-1", "fb-2"]);
  });
});

// ── LangGraph checkpoint retention (lib/checkpoints.js) ──
// CHECKPOINT_MAX_RUNS (lib/config.js) is a module-level constant fixed from
// process.env at import time, same as AGENT_HITL_ENABLED in test/routing.test.js.
// Testing a small, fast retention window (instead of the real default of 50,
// which would need 52 real persisted runs to exercise) means spawning a child
// process with CHECKPOINT_MAX_RUNS set *before* lib/config.js is ever imported,
// following that file's established pattern for this class of constant.
function runCheckpointPruneScenario({ totalRuns, maxRuns, dataDir }) {
  const checkpointsUrl = pathToFileURL(path.resolve("lib/checkpoints.js")).href;
  const memoryDbUrl = pathToFileURL(path.resolve("lib/memory-db.js")).href;
  const memorySaverUrl = "@langchain/langgraph-checkpoint";
  const script = [
    `import { persistLangGraphCheckpoints } from "${checkpointsUrl}";`,
    `import { getMemoryDatabase } from "${memoryDbUrl}";`,
    `import { MemorySaver } from "${memorySaverUrl}";`,
    `const runIds = [];`,
    `for (let i = 0; i < ${totalRuns}; i++) {`,
    `  const runId = \`test-run-\${i}\`;`,
    `  runIds.push(runId);`,
    `  const checkpointer = new MemorySaver();`,
    `  await checkpointer.put(`,
    `    { configurable: { thread_id: runId, checkpoint_ns: "" } },`,
    `    { id: \`ckpt-\${i}\`, ts: new Date(i * 1000).toISOString(), channel_values: {} },`,
    `    {}`,
    `  );`,
    `  await persistLangGraphCheckpoints({ projectId: "proj-1", runId, threadId: runId, checkpointer });`,
    `}`,
    `const db = getMemoryDatabase();`,
    `const checkpointRunIds = db.prepare("SELECT DISTINCT run_id FROM langgraph_checkpoints").all().map((row) => row.run_id);`,
    `const payloadRunIds = db.prepare("SELECT run_id FROM langgraph_checkpoint_payloads").all().map((row) => row.run_id);`,
    `console.log(JSON.stringify({ runIds, checkpointRunIds, payloadRunIds }));`
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, CHECKPOINT_MAX_RUNS: String(maxRuns), DATA_DIR: dataDir, MEMORY_DB_PATH: path.join(dataDir, "memory.sqlite") }
  });
  return JSON.parse(output);
}

describe("LangGraph checkpoint retention window (lib/checkpoints.js)", () => {
  test("persisting more runs than CHECKPOINT_MAX_RUNS prunes older runs from both tables", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-checkpoint-prune-"));
    try {
      const maxRuns = 3;
      const totalRuns = maxRuns + 2;
      const { runIds, checkpointRunIds, payloadRunIds } = runCheckpointPruneScenario({ totalRuns, maxRuns, dataDir });

      assert.equal(runIds.length, totalRuns);
      // Only the most recent `maxRuns` runs should remain in either table.
      const expectedKept = runIds.slice(-maxRuns);
      assert.equal(checkpointRunIds.length, maxRuns);
      assert.equal(payloadRunIds.length, maxRuns);
      assert.deepEqual(new Set(checkpointRunIds), new Set(expectedKept));
      assert.deepEqual(new Set(payloadRunIds), new Set(expectedKept));
      // The oldest runs must be gone from both tables (cascaded deletion).
      const droppedRunIds = runIds.slice(0, totalRuns - maxRuns);
      for (const runId of droppedRunIds) {
        assert.ok(!checkpointRunIds.includes(runId), `expected ${runId} pruned from langgraph_checkpoints`);
        assert.ok(!payloadRunIds.includes(runId), `expected ${runId} pruned from langgraph_checkpoint_payloads`);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("persisting fewer runs than CHECKPOINT_MAX_RUNS keeps every run", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-checkpoint-nopune-"));
    try {
      const maxRuns = 5;
      const totalRuns = 3;
      const { runIds, checkpointRunIds, payloadRunIds } = runCheckpointPruneScenario({ totalRuns, maxRuns, dataDir });
      assert.equal(checkpointRunIds.length, totalRuns);
      assert.equal(payloadRunIds.length, totalRuns);
      assert.deepEqual(new Set(checkpointRunIds), new Set(runIds));
      assert.deepEqual(new Set(payloadRunIds), new Set(runIds));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
