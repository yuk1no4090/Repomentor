import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Behavioral, offline, no-API-key proof for Task L3's bounded QACritic revise
// loop (lib/agent-graph.js's decideNextRoute + the "retrieve"/"qa_plan" nodes).
//
// The deterministic critic (lib/agent-contracts.js's createDeterministicQaCriticReview)
// returns verdict="revise" whenever `impact.impact_areas` comes back EMPTY (as
// well as when an area lacks cited files, but lib/answers.js's deterministic
// generateImpactAnswer() only ever pushes an area once it already has files,
// so an empty impact_areas array is the only revise trigger reachable purely
// offline). This script exploits exactly that: a tiny custom project plus a
// question that retrieves ZERO chunks on the first pass (triggering revise),
// where the SECOND-round retrieval -- fed by the critic's own fixed
// additional_queries ("dependency callers tests integration state transition")
// -- finds a file the first pass could not, because that file's content/path
// only overlaps the word "integration" (present only in the critic's
// additional_queries, not in the Supervisor's own two fixed template queries
// or in expand_context's hardcoded expansion words). This was verified
// empirically against the real lib/retrieval.js scorer before being encoded
// here (see the task's final report for the exact probe output).
//
// Three server runs prove the whole loop:
//   1. FIXABLE project, default AGENT_MAX_REVISION_ROUNDS (1): revise round
//      finds the missing evidence, verdict flips revise -> approve, uncited
//      area count only ever goes down (or stays at 0), never up.
//   2. Same FIXABLE project, AGENT_MAX_REVISION_ROUNDS=0: the config gate
//      disables the loop entirely -- same question, zero revise rounds, the
//      verdict stays "revise" forever. This is the A/B baseline against run 1.
//   3. UNFIXABLE project (nothing in it ever matches, not even the critic's
//      additional_queries): the critic keeps asking for revision, but the run
//      still completes in exactly one bounded round and never exceeds the
//      step budget -- the termination proof.

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

// Minimal uncompressed (stored, method 0) ZIP writer -- same shape as the one
// scripts/smoke-test.js keeps locally (not exported there, so duplicated here
// rather than reaching into another check script's internals).
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

// The question deliberately avoids "integration" (and other words the
// Supervisor's own two fixed template queries -- "<q> model schema route
// service test" / "<q> caller dependency state transition" -- would expand
// into a match for), so the FIRST retrieval pass finds nothing in either
// project below, every time.
const QUESTION = "As a PM, what should I double check before removing the legacy logging helper?";

// FIXABLE: the file's path/content only overlaps "integration", a word that
// appears ONLY in the QACritic's fixed additional_queries string
// ("dependency callers tests integration state transition"), not in the
// Supervisor's fixed queries, not in expand_context's hardcoded expansion
// words, and not in QUESTION. So it is invisible to every retrieval call
// EXCEPT the revise round's.
const FIXABLE_PROJECT_FILES = {
  "docs/integration-notes.txt": "This document describes integration considerations for downstream consumers of the module"
};

// UNFIXABLE: shares no vocabulary with QUESTION, the Supervisor's fixed
// queries, expand_context's expansion words, OR the critic's additional_queries
// -- so even the revise round's retrieval finds nothing here, ever.
const UNFIXABLE_PROJECT_FILES = {
  "docs/weather-notes.txt": "Weather patterns are influenced by ocean currents and atmospheric pressure zones across different seasons"
};

function countRetrieveTraceSteps(trace) {
  return (trace || []).filter((step) => step.tool === "retriever_agent.retrieve_repository_chunks");
}

async function runScenario({ label, dataDir, extraEnv, projectFiles }) {
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
      ...extraEnv
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
      body: JSON.stringify({ zipBase64: createZipBase64(projectFiles), fileName: `${label}.zip` })
    });
    const projectId = imported.project?.id;
    assert(projectId, `[${label}] import did not return a project id`);

    const answer = await requestTo(baseUrl, "/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({ projectId, question: QUESTION })
    });
    return { answer, projectId };
  } catch (error) {
    console.error(`[${label}] stdout:\n${stdout}`);
    console.error(`[${label}] stderr:\n${stderr}`);
    throw error;
  } finally {
    await stopChild(child);
  }
}

async function main() {
  const dataDirFixableDefault = await mkdtemp(path.join(tmpdir(), "ai-pm-revise-loop-fixable-default-"));
  const dataDirFixableZero = await mkdtemp(path.join(tmpdir(), "ai-pm-revise-loop-fixable-zero-"));
  const dataDirUnfixable = await mkdtemp(path.join(tmpdir(), "ai-pm-revise-loop-unfixable-"));

  try {
    // ── 1. Default AGENT_MAX_REVISION_ROUNDS (1), fixable project ──
    const { answer: fixed } = await runScenario({
      label: "fixable-default",
      dataDir: dataDirFixableDefault,
      extraEnv: {},
      projectFiles: FIXABLE_PROJECT_FILES
    });
    const fixedHarness = fixed.payload.harness;
    const fixedRevision = fixedHarness.revision_metrics;

    assert(fixedHarness.revision_rounds >= 1, `expected revision_rounds >= 1, got ${fixedHarness.revision_rounds}`);
    assert(typeof fixedHarness.revision_reason === "string" && fixedHarness.revision_reason.length > 0,
      "expected a non-empty revision_reason recording why the critic asked for revision");

    const retrieveSteps = countRetrieveTraceSteps(fixed.payload.trace);
    assert(retrieveSteps.length === 2, `expected the trace to contain 2 "retrieve" steps (initial + 1 revise round), got ${retrieveSteps.length}`);
    const secondRetrieveStep = retrieveSteps[1];
    assert(secondRetrieveStep.input.revision_round >= 1, "second retrieve step should report revision_round >= 1");
    assert(Array.isArray(secondRetrieveStep.input.additional_queries_used) && secondRetrieveStep.input.additional_queries_used.length > 0,
      "second retrieve step should record the QACritic additional_queries actually used");
    assert(secondRetrieveStep.input.additional_queries_used.some((q) => q.includes("integration")),
      `expected the revise round's additional_queries_used to include the critic's fixed query, got ${JSON.stringify(secondRetrieveStep.input.additional_queries_used)}`);

    assert(fixedRevision.final_uncited_area_count <= fixedRevision.pre_revision_uncited_area_count,
      `final uncited-area count (${fixedRevision.final_uncited_area_count}) must be <= pre-revision uncited-area count (${fixedRevision.pre_revision_uncited_area_count})`);
    assert(fixedRevision.final_impact_area_count > fixedRevision.pre_revision_impact_area_count,
      `expected the revise round to find MORE evidence than the pre-revision pass: pre=${fixedRevision.pre_revision_impact_area_count}, final=${fixedRevision.final_impact_area_count}`);
    assert(fixed.payload.critic_review?.verdict === "approve",
      `expected the revise round to resolve the critic's verdict to "approve", got "${fixed.payload.critic_review?.verdict}"`);

    const fixedBudget = fixedHarness.budget_status;
    assert(fixedBudget.step_budget_exceeded === false, "the successful revise round must not exceed AGENT_MAX_STEPS");
    assert(fixedBudget.steps_executed <= fixedHarness.budgets.max_steps,
      `steps_executed (${fixedBudget.steps_executed}) must not exceed max_steps (${fixedHarness.budgets.max_steps})`);

    // ── 2. AGENT_MAX_REVISION_ROUNDS=0, SAME fixable project + question (A/B baseline) ──
    const { answer: gated } = await runScenario({
      label: "fixable-rounds-zero",
      dataDir: dataDirFixableZero,
      extraEnv: { AGENT_MAX_REVISION_ROUNDS: "0" },
      projectFiles: FIXABLE_PROJECT_FILES
    });
    const gatedHarness = gated.payload.harness;
    assert(gatedHarness.revision_rounds === 0, `AGENT_MAX_REVISION_ROUNDS=0 must produce 0 revise rounds, got ${gatedHarness.revision_rounds}`);
    assert(countRetrieveTraceSteps(gated.payload.trace).length === 1,
      "AGENT_MAX_REVISION_ROUNDS=0 must never re-enter the retrieve node");
    assert(gated.payload.critic_review?.verdict === "revise",
      `AGENT_MAX_REVISION_ROUNDS=0 should leave the verdict unresolved ("revise"), got "${gated.payload.critic_review?.verdict}"`);
    assert(gatedHarness.revision_metrics.final_impact_area_count === gatedHarness.revision_metrics.pre_revision_impact_area_count,
      "with the loop disabled, final and pre-revision impact-area counts must be identical (no second round ever ran)");

    // ── 3. Termination proof: unfixable project, critic keeps asking for revision ──
    const { answer: stuck } = await runScenario({
      label: "unfixable-default",
      dataDir: dataDirUnfixable,
      extraEnv: {},
      projectFiles: UNFIXABLE_PROJECT_FILES
    });
    const stuckHarness = stuck.payload.harness;
    assert(stuckHarness.revision_rounds === stuckHarness.revision_max_rounds,
      `the stuck run should have taken exactly its max rounds (${stuckHarness.revision_max_rounds}), got ${stuckHarness.revision_rounds}`);
    assert(stuck.payload.critic_review?.verdict === "revise",
      "the unfixable project's verdict should still read \"revise\" -- the critic never got evidence to approve");
    assert(stuckHarness.revision_budget_exhausted === true,
      "the harness must report that the revise loop was cut short by the round budget, not that it resolved");
    const stuckBudget = stuckHarness.budget_status;
    assert(stuckBudget.step_budget_exceeded === false, "a perpetually-revising critic must still terminate within AGENT_MAX_STEPS");
    assert(stuckBudget.steps_executed <= stuckHarness.budgets.max_steps,
      `steps_executed (${stuckBudget.steps_executed}) must not exceed max_steps (${stuckHarness.budgets.max_steps}) even when the critic never approves`);
    assert(stuckHarness.revision_rounds <= stuckHarness.revision_max_rounds,
      "revision_rounds must never exceed the configured AGENT_MAX_REVISION_ROUNDS, proving the loop cannot run forever");

    console.log(JSON.stringify({
      ok: true,
      scenario: "qa-critic-bounded-revise-loop",
      fixable_default: {
        revision_rounds: fixedHarness.revision_rounds,
        revision_max_rounds: fixedHarness.revision_max_rounds,
        revision_reason: fixedHarness.revision_reason,
        verdict_before: "revise",
        verdict_after: fixed.payload.critic_review?.verdict,
        pre_revision_impact_area_count: fixedRevision.pre_revision_impact_area_count,
        pre_revision_uncited_area_count: fixedRevision.pre_revision_uncited_area_count,
        final_impact_area_count: fixedRevision.final_impact_area_count,
        final_uncited_area_count: fixedRevision.final_uncited_area_count,
        steps_executed: fixedBudget.steps_executed,
        max_steps: fixedHarness.budgets.max_steps,
        trace_length: fixed.payload.trace.length
      },
      fixable_rounds_zero_ab_baseline: {
        revision_rounds: gatedHarness.revision_rounds,
        verdict_after: gated.payload.critic_review?.verdict,
        pre_revision_impact_area_count: gatedHarness.revision_metrics.pre_revision_impact_area_count,
        final_impact_area_count: gatedHarness.revision_metrics.final_impact_area_count,
        steps_executed: gatedHarness.budget_status.steps_executed,
        trace_length: gated.payload.trace.length
      },
      unfixable_termination_proof: {
        revision_rounds: stuckHarness.revision_rounds,
        revision_max_rounds: stuckHarness.revision_max_rounds,
        revision_budget_exhausted: stuckHarness.revision_budget_exhausted,
        verdict_after: stuck.payload.critic_review?.verdict,
        steps_executed: stuckBudget.steps_executed,
        max_steps: stuckHarness.budgets.max_steps,
        trace_length: stuck.payload.trace.length
      }
    }, null, 2));
  } finally {
    await rm(dataDirFixableDefault, { recursive: true, force: true });
    await rm(dataDirFixableZero, { recursive: true, force: true });
    await rm(dataDirUnfixable, { recursive: true, force: true });
  }
}

await main();
