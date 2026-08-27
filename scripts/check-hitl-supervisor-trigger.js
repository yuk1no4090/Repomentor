import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Behavioral regression coverage for Task N2: the Supervisor's own
// `require_human_review` flag (schema-validated boolean on `supervisorPlan`,
// produced by the model agent or `createDeterministicSupervisorPlan`) becomes
// a second, OR'd HITL trigger alongside the ImpactAnalyst's evidence-grounded
// `riskLevel === "high"`. Before this card, `require_human_review` was
// produced, schema-enforced by `validateSupervisorPlan()`, and then consumed
// by nothing -- decideNextRoute's HITL reroute keyed on `riskLevel` alone.
//
// A separate file from scripts/check-revise-hitl-cross.js on purpose: that
// file's own scenario (and its already-dense header comment) is specifically
// about the bounded QACritic revise loop crossing the HITL pause/resume path
// -- a different cross-feature concern from this one. Conflating them would
// force one fixture to prove two unrelated things at once. This scenario
// deliberately keeps QACritic approving on the FIRST call (no revise round),
// so the ONLY thing that can explain a pause here is the new trigger this
// card adds, isolated from the revise loop entirely.
//
// Why this needs a FAKE LLM instead of the deterministic (no-API-key) path:
// createDeterministicSupervisorPlan() sets `require_human_review` to the
// EXACT SAME boolean it uses for `risk_hypothesis === "high"` (both driven by
// one regex match against the question text -- see lib/agent-contracts.js).
// The ImpactAnalyst's riskLevel, in the deterministic path, is a COMPLETELY
// INDEPENDENT computation (lib/answers.js's generateImpactAnswer(), which
// assigns risk_level "high" only to file-path-pattern-matched Data Model/
// Business Logic areas -- nothing to do with the question's own keywords).
// So the deterministic path CAN in principle diverge the two signals for some
// question/repository combination, but it cannot be forced to on demand for
// a controlled test -- and forcing it would risk asserting on an accidental
// property of the sample repo's file paths rather than the actual routing
// policy. A fake OpenAI-compatible endpoint (the same technique
// scripts/smoke-test.js and scripts/check-revise-hitl-cross.js already use)
// sidesteps this cleanly: it lets this script set `require_human_review` and
// the ImpactAnalyst's `risk_level`s completely independently, so the
// treatment scenario below can construct EXACTLY "flag true, riskLevel
// medium" -- the one combination the deterministic path cannot reliably
// isolate -- while the control scenario proves the flag is genuinely
// load-bearing (not just always-true-when-medium-risk-happens-to-pause).
//
// Scenario (treatment): Supervisor sets require_human_review=true (with
// risk_hypothesis="medium", proving risk_hypothesis itself is NOT wired into
// routing -- only require_human_review is) while ImpactAnalyst reports a
// single "medium" (never "high") impact area -> riskLevel stays "medium" ->
// the run pauses ONLY because of the supervisor flag. hitl.triggers must be
// exactly ["supervisor_flag"] (NOT "high_risk") -- the payload-level proof
// that the ImpactAnalyst signal genuinely did not fire, so the pause can only
// be explained by the new trigger. A decision-resume must then complete
// normally via native_interrupt_resume.
//
// Scenario (control): identical fixtures except require_human_review=false
// -> no pause at all. This is the load-bearing negative case: without it, a
// bug that pauses on ANY supervisorPlan (or on medium risk generally) would
// pass the treatment assertions above for the wrong reason.

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message} (expected ${e}, got ${a})`);
  }
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
// technique scripts/smoke-test.js's/check-revise-hitl-cross.js's fake servers
// use). `requireHumanReview` parameterizes the ONE thing that differs between
// the treatment and control scenarios; everything else about the fixture
// (ImpactAnalyst's medium-only risk, QACritic's immediate approve) stays
// identical, so a pause/no-pause difference between the two runs can only be
// explained by that one flag.
function startFakeLlmServer(requireHumanReview) {
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
      risk_hypothesis: "medium",
      required_agents: ["ImpactAnalyst", "QACritic"],
      retrieval_queries: ["order listing endpoint query parameter"],
      require_human_review: requireHumanReview,
      // risk_hypothesis stays "medium" regardless of require_human_review, on
      // purpose: this is the empirical proof that risk_hypothesis itself is
      // NOT a routing input (Task N2 deliberately does not wire it in) --
      // only require_human_review changes between the treatment and control
      // fixtures below.
      rationale: requireHumanReview
        ? "Adding a query parameter is evidence-light so far; escalating out of caution while more usage data comes in."
        : "Adding a query parameter to an existing read endpoint is routine and evidence-backed; no escalation needed."
    };
    const impactAnalystPayload = {
      summary: "Adding a query parameter to the order listing endpoint extends the route's request shape.",
      // Exactly one impact area, deliberately risk_level "medium" (never
      // "high") -- this is what keeps state.riskLevel at "medium" so ONLY
      // the supervisor flag (not the ImpactAnalyst's own signal) can explain
      // a pause in the treatment scenario.
      impact_areas: [{
        area: "API Routes",
        risk_level: "medium",
        reason: "The order listing route gains a new optional query parameter; existing callers are unaffected but the contract widens.",
        files: ["src/routes/order.ts"]
      }],
      testing_suggestions: ["Add a test asserting the endpoint still works when the new query parameter is omitted."],
      open_questions: ["Should the new query parameter be documented in the public API reference?"],
      briefing: {
        summary: "This change adds an optional filter to the order listing endpoint.",
        affected_flows: [{ flow: "Order listing", why: "The endpoint accepts one more optional query parameter." }],
        testing_focus: ["Verify the endpoint's existing behavior is unchanged when the parameter is omitted."],
        risk_note: "Medium risk: recommend targeted tests for the new parameter plus a quick smoke test."
      }
    };
    const qaCriticPayload = {
      verdict: "approve",
      summary: "The impact assessment is evidence-backed; no additional evidence is required.",
      findings: [{
        severity: "low",
        finding: "The change is additive to the route's request shape and does not touch existing behavior.",
        evidence_files: ["src/routes/order.ts"]
      }],
      testing_suggestions: ["Exercise the endpoint both with and without the new query parameter."],
      open_questions: [],
      additional_queries: []
    };

    const isSupervisorRequest = systemContent.includes("You are the Supervisor agent");
    const isQaCriticRequest = systemContent.includes("You are the QACritic agent");
    let responsePayload;
    if (isSupervisorRequest) {
      responsePayload = supervisorPayload;
    } else if (isQaCriticRequest) {
      responsePayload = qaCriticPayload;
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
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

const QUESTION = "As a PM, evaluate the risk of adding an optional query parameter to the order listing endpoint.";

// Runs one full scenario (import sample project, ask QUESTION against a
// server wired to a fake LLM whose Supervisor response carries the given
// require_human_review value) and returns { baseUrl, dataDir, child, fakeLlm,
// paused } for the caller to assert on and eventually tear down. Kept as one
// function (rather than inlined twice) so the treatment and control runs are
// guaranteed to share identical fixtures/requests apart from the one
// parameter under test.
async function runScenario(requireHumanReview) {
  const dataDir = await mkdtemp(path.join(tmpdir(), `ai-pm-hitl-supervisor-trigger-${requireHumanReview}-`));
  const fakeLlm = await startFakeLlmServer(requireHumanReview);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "fake-hitl-supervisor-trigger-key",
      OPENAI_BASE_URL: fakeLlm.baseUrl,
      OPENAI_MODEL: "fake-hitl-supervisor-trigger-model",
      AGENT_HITL_ENABLED: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  await waitForServer(baseUrl, child);

  const imported = await requestTo(baseUrl, "/api/import", {
    method: "POST",
    body: JSON.stringify({ sample: true })
  });
  const projectId = imported.project?.id;
  assert(projectId, "sample import did not return a project id");

  const result = await requestTo(baseUrl, "/api/agent-impact", {
    method: "POST",
    body: JSON.stringify({ projectId, question: QUESTION })
  });

  return { dataDir, fakeLlm, child, baseUrl, projectId, result, getStdout: () => stdout, getStderr: () => stderr };
}

async function main() {
  let treatment;
  let control;
  try {
    // ── 1. Treatment: require_human_review=true + riskLevel medium -> pause ──
    treatment = await runScenario(true);
    const paused = treatment.result;

    assert(paused.payload?.harness?.model_calls?.some((call) => call.llm_used === true),
      "sanity check: the fake LLM must actually have been used (otherwise this proves nothing about the model-driven flag)");
    assert(!paused.payload.impact_areas.some((area) => area.risk_level === "high"),
      "fixture sanity: no impact area may be risk_level high (riskLevel must be \"medium\", not \"high\", so only the supervisor flag can explain the pause)");
    assert(paused.payload?.hitl, "expected a hitl field: require_human_review=true should pause the run even though riskLevel is only \"medium\"");
    assert(paused.payload.hitl.paused === true, "supervisor-flagged run should pause for human review");
    assert(paused.payload.hitl.decision === null, "paused answer should not carry a decision yet");
    assert(paused.payload.summary.startsWith("[HITL PAUSED"), "paused summary should carry the HITL paused marker");
    assertDeepEqual(paused.payload.hitl.triggers, ["supervisor_flag"],
      "hitl.triggers must be exactly [\"supervisor_flag\"] -- proves riskLevel (\"high_risk\") did NOT also fire, so the pause is explained by the new trigger alone");
    assert(paused.payload.hitl.reason === "supervisor requested human review",
      `hitl.reason should name the supervisor trigger specifically, got "${paused.payload.hitl.reason}"`);
    assert(paused.payload.supervisor_plan?.risk_hypothesis === "medium",
      "fixture sanity: supervisor_plan.risk_hypothesis is \"medium\" (not \"high\") -- proves risk_hypothesis itself is not what triggered the pause, require_human_review is");
    const runId = paused.payload.harness?.run_id;
    assert(runId, "paused agent-impact answer did not report a harness run id");
    const pausedTraceLength = paused.payload.trace.length;

    // ── 2. Resume with a decision -> correct, non-paused synthesis ──
    const approved = await requestTo(treatment.baseUrl, "/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId: treatment.projectId, runId, decision: "approve" })
    });
    assert(approved.payload?.harness?.resume?.mode === "native_interrupt_resume",
      `decision resume with a persisted checkpoint payload must report mode=native_interrupt_resume, got ${approved.payload?.harness?.resume?.mode}`);
    assert(approved.payload.hitl.paused === false, "resumed answer must not still report a paused card");
    assert(approved.payload.hitl.approved === true, "resumed answer should mark hitl.approved");
    assert(approved.payload.hitl.decision === "approve", "resumed answer should record the approve decision");
    assert(approved.payload.summary.startsWith("[HITL APPROVED]"), "resumed summary should carry the HITL approved marker");
    assertDeepEqual(approved.payload.trace.length, pausedTraceLength + 1,
      "resume must only re-run human_review + synthesize's own new trace step (trace length +1) -- no revise round is involved in this scenario");

    // ── 3. Control: require_human_review=false + riskLevel medium -> no pause ──
    control = await runScenario(false);
    const notPaused = control.result;
    assert(notPaused.payload?.harness?.model_calls?.some((call) => call.llm_used === true),
      "control sanity check: the fake LLM must actually have been used");
    assert(!notPaused.payload.impact_areas.some((area) => area.risk_level === "high"),
      "control fixture sanity: no impact area may be risk_level high (identical fixture to the treatment run except require_human_review)");
    assert(notPaused.payload.hitl === undefined,
      `control (require_human_review=false, riskLevel medium) must not pause at all -- expected no hitl field, got ${JSON.stringify(notPaused.payload.hitl)}`);
    assert(!notPaused.payload.summary.startsWith("[HITL"), "control summary must not carry any HITL marker");
    assert(notPaused.payload.harness?.run_id, "control run should still complete with a real harness run id");

    console.log(JSON.stringify({
      ok: true,
      scenario: "supervisor-require-human-review-second-hitl-trigger",
      treatment: {
        pausedRunId: runId,
        pausedTraceLength,
        resumedTraceLength: approved.payload.trace.length,
        triggers: paused.payload.hitl.triggers,
        reason: paused.payload.hitl.reason,
        resumeMode: approved.payload.harness.resume.mode,
        finalHitl: approved.payload.hitl
      },
      control: {
        runId: notPaused.payload.harness.run_id,
        hitl: notPaused.payload.hitl ?? null
      }
    }, null, 2));
  } catch (error) {
    if (treatment) {
      console.error("[treatment] stdout:\n" + treatment.getStdout());
      console.error("[treatment] stderr:\n" + treatment.getStderr());
    }
    if (control) {
      console.error("[control] stdout:\n" + control.getStdout());
      console.error("[control] stderr:\n" + control.getStderr());
    }
    throw error;
  } finally {
    for (const scenario of [treatment, control]) {
      if (!scenario) continue;
      await stopChild(scenario.child);
      scenario.fakeLlm.server.close();
      await rm(scenario.dataDir, { recursive: true, force: true });
    }
  }
}

await main();
