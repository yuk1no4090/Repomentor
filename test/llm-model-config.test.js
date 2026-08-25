import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  resolveLlmModel,
  resolveLlmModelForRole,
  resolveLlmTemperature,
  resolveLlmTemperatureForRole,
  resolveRoleModelConfig,
  maybeCallOpenAI,
  runModelAdapter,
  runAgentModelAdapter
} from "../lib/llm.js";
import { SUPERVISOR_AGENT, IMPACT_ANALYST_AGENT, QA_CRITIC_AGENT } from "../lib/agent-contracts.js";
import { normalizeHarnessRun } from "../lib/agent-graph.js";

// Unit tests for Task L4's per-role model/temperature resolution
// (lib/llm.js's resolveLlmModelForRole/resolveLlmTemperatureForRole/
// resolveRoleModelConfig). Every function under test here reads process.env
// at CALL time (nothing is cached at module load, unlike the frozen
// lib/config.js constants test/routing.test.js has to spawn a child process
// for) -- so in-process process.env mutation with save/restore around each
// test is enough to exercise every branch of the *real* exported function.

const ROLE_ENV_VARS = {
  model: {
    [SUPERVISOR_AGENT.role]: "OPENAI_MODEL_SUPERVISOR",
    [IMPACT_ANALYST_AGENT.role]: "OPENAI_MODEL_IMPACT_ANALYST",
    [QA_CRITIC_AGENT.role]: "OPENAI_MODEL_QA_CRITIC"
  },
  temperature: {
    [SUPERVISOR_AGENT.role]: "OPENAI_TEMPERATURE_SUPERVISOR",
    [IMPACT_ANALYST_AGENT.role]: "OPENAI_TEMPERATURE_IMPACT_ANALYST",
    [QA_CRITIC_AGENT.role]: "OPENAI_TEMPERATURE_QA_CRITIC"
  }
};

const ALL_MANAGED_ENV_VARS = [
  "OPENAI_MODEL",
  "OPENAI_TEMPERATURE",
  ...Object.values(ROLE_ENV_VARS.model),
  ...Object.values(ROLE_ENV_VARS.temperature),
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL"
];

let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of ALL_MANAGED_ENV_VARS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ALL_MANAGED_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("resolveLlmModel (non-agent /api/chat path, unaffected by per-role config)", () => {
  test("falls back to the hardcoded default when nothing is set", () => {
    delete process.env.OPENAI_MODEL;
    assert.equal(resolveLlmModel(), "gpt-4o-mini");
  });

  test("uses OPENAI_MODEL when set", () => {
    process.env.OPENAI_MODEL = "gpt-4o";
    assert.equal(resolveLlmModel(), "gpt-4o");
  });

  test("treats a whitespace-only OPENAI_MODEL as unset", () => {
    process.env.OPENAI_MODEL = "   ";
    assert.equal(resolveLlmModel(), "gpt-4o-mini");
  });

  test("ignores per-role env vars entirely -- the /api/chat path never reaches resolveLlmModelForRole", () => {
    delete process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL_SUPERVISOR = "should-never-be-used";
    process.env.OPENAI_MODEL_IMPACT_ANALYST = "should-never-be-used";
    process.env.OPENAI_MODEL_QA_CRITIC = "should-never-be-used";
    assert.equal(resolveLlmModel(), "gpt-4o-mini");
  });
});

describe("resolveLlmModelForRole", () => {
  test("a role-specific override wins over OPENAI_MODEL and the default", () => {
    process.env.OPENAI_MODEL = "gpt-4o-mini";
    process.env.OPENAI_MODEL_IMPACT_ANALYST = "gpt-4o";
    assert.equal(resolveLlmModelForRole(IMPACT_ANALYST_AGENT.role), "gpt-4o");
  });

  test("falls back to OPENAI_MODEL when the role-specific var is unset", () => {
    delete process.env.OPENAI_MODEL_SUPERVISOR;
    process.env.OPENAI_MODEL = "deepseek-chat";
    assert.equal(resolveLlmModelForRole(SUPERVISOR_AGENT.role), "deepseek-chat");
  });

  test("falls back to the hardcoded default when neither is set", () => {
    delete process.env.OPENAI_MODEL_QA_CRITIC;
    delete process.env.OPENAI_MODEL;
    assert.equal(resolveLlmModelForRole(QA_CRITIC_AGENT.role), "gpt-4o-mini");
  });

  test("treats an empty-string role-specific override as unset", () => {
    process.env.OPENAI_MODEL_SUPERVISOR = "";
    process.env.OPENAI_MODEL = "deepseek-chat";
    assert.equal(resolveLlmModelForRole(SUPERVISOR_AGENT.role), "deepseek-chat");
  });

  test("treats a whitespace-only role-specific override as unset", () => {
    process.env.OPENAI_MODEL_IMPACT_ANALYST = "   ";
    process.env.OPENAI_MODEL = "deepseek-chat";
    assert.equal(resolveLlmModelForRole(IMPACT_ANALYST_AGENT.role), "deepseek-chat");
  });

  test("an unknown/renamed role falls through to the shared resolution instead of throwing or matching a similarly-named var", () => {
    delete process.env.OPENAI_MODEL;
    // A string-mangled lookup (role.toUpperCase() etc.) would find this var;
    // the real implementation must NOT, because "TotallyUnknownRole" has no
    // entry in ROLE_MODEL_ENV_VARS.
    process.env.OPENAI_MODEL_TOTALLYUNKNOWNROLE = "should-never-be-used";
    assert.equal(resolveLlmModelForRole("TotallyUnknownRole"), "gpt-4o-mini");

    process.env.OPENAI_MODEL = "deepseek-chat";
    assert.equal(resolveLlmModelForRole("TotallyUnknownRole"), "deepseek-chat");
  });

  test("the three real roles resolve independently when all three are overridden at once", () => {
    process.env.OPENAI_MODEL = "gpt-4o-mini";
    process.env.OPENAI_MODEL_SUPERVISOR = "model-a";
    process.env.OPENAI_MODEL_IMPACT_ANALYST = "model-b";
    process.env.OPENAI_MODEL_QA_CRITIC = "model-c";
    assert.equal(resolveLlmModelForRole(SUPERVISOR_AGENT.role), "model-a");
    assert.equal(resolveLlmModelForRole(IMPACT_ANALYST_AGENT.role), "model-b");
    assert.equal(resolveLlmModelForRole(QA_CRITIC_AGENT.role), "model-c");
  });
});

describe("resolveLlmTemperature / resolveLlmTemperatureForRole", () => {
  test("resolveLlmTemperature defaults to 0.2 when unset", () => {
    delete process.env.OPENAI_TEMPERATURE;
    assert.equal(resolveLlmTemperature(), 0.2);
  });

  test("resolveLlmTemperature honors a valid OPENAI_TEMPERATURE", () => {
    process.env.OPENAI_TEMPERATURE = "0.9";
    assert.equal(resolveLlmTemperature(), 0.9);
  });

  test("resolveLlmTemperature treats blank/non-numeric/out-of-range values as unset", () => {
    for (const value of ["", "   ", "not-a-number", "-0.5", "2.5"]) {
      process.env.OPENAI_TEMPERATURE = value;
      assert.equal(resolveLlmTemperature(), 0.2, `expected default for OPENAI_TEMPERATURE=${JSON.stringify(value)}`);
    }
  });

  test("resolveLlmTemperature accepts the boundary values 0 and 2", () => {
    process.env.OPENAI_TEMPERATURE = "0";
    assert.equal(resolveLlmTemperature(), 0);
    process.env.OPENAI_TEMPERATURE = "2";
    assert.equal(resolveLlmTemperature(), 2);
  });

  test("resolveLlmTemperatureForRole: role-specific override wins", () => {
    process.env.OPENAI_TEMPERATURE = "0.2";
    process.env.OPENAI_TEMPERATURE_QA_CRITIC = "0";
    assert.equal(resolveLlmTemperatureForRole(QA_CRITIC_AGENT.role), 0);
  });

  test("resolveLlmTemperatureForRole: falls back to OPENAI_TEMPERATURE, then the default", () => {
    delete process.env.OPENAI_TEMPERATURE_SUPERVISOR;
    process.env.OPENAI_TEMPERATURE = "0.5";
    assert.equal(resolveLlmTemperatureForRole(SUPERVISOR_AGENT.role), 0.5);

    delete process.env.OPENAI_TEMPERATURE;
    assert.equal(resolveLlmTemperatureForRole(SUPERVISOR_AGENT.role), 0.2);
  });

  test("resolveLlmTemperatureForRole: an invalid role-specific override falls through rather than sending NaN", () => {
    process.env.OPENAI_TEMPERATURE_IMPACT_ANALYST = "not-a-number";
    process.env.OPENAI_TEMPERATURE = "0.7";
    assert.equal(resolveLlmTemperatureForRole(IMPACT_ANALYST_AGENT.role), 0.7);
  });

  test("resolveLlmTemperatureForRole: unknown role falls through to the shared resolution", () => {
    process.env.OPENAI_TEMPERATURE = "0.6";
    assert.equal(resolveLlmTemperatureForRole("TotallyUnknownRole"), 0.6);
  });
});

describe("resolveRoleModelConfig", () => {
  test("reports the effective model/temperature and override flags per role", () => {
    process.env.OPENAI_MODEL = "gpt-4o-mini";
    process.env.OPENAI_TEMPERATURE = "0.2";
    delete process.env.OPENAI_MODEL_SUPERVISOR;
    delete process.env.OPENAI_TEMPERATURE_SUPERVISOR;
    process.env.OPENAI_MODEL_IMPACT_ANALYST = "gpt-4o";
    delete process.env.OPENAI_TEMPERATURE_IMPACT_ANALYST;
    delete process.env.OPENAI_MODEL_QA_CRITIC;
    process.env.OPENAI_TEMPERATURE_QA_CRITIC = "0";

    const config = resolveRoleModelConfig();

    assert.deepEqual(Object.keys(config).sort(), [SUPERVISOR_AGENT.role, IMPACT_ANALYST_AGENT.role, QA_CRITIC_AGENT.role].sort());

    assert.equal(config[SUPERVISOR_AGENT.role].model, "gpt-4o-mini");
    assert.equal(config[SUPERVISOR_AGENT.role].model_overridden, false);
    assert.equal(config[SUPERVISOR_AGENT.role].model_env_var, "OPENAI_MODEL_SUPERVISOR");
    assert.equal(config[SUPERVISOR_AGENT.role].temperature, 0.2);
    assert.equal(config[SUPERVISOR_AGENT.role].temperature_overridden, false);

    assert.equal(config[IMPACT_ANALYST_AGENT.role].model, "gpt-4o");
    assert.equal(config[IMPACT_ANALYST_AGENT.role].model_overridden, true);
    assert.equal(config[IMPACT_ANALYST_AGENT.role].temperature, 0.2);
    assert.equal(config[IMPACT_ANALYST_AGENT.role].temperature_overridden, false);

    assert.equal(config[QA_CRITIC_AGENT.role].model, "gpt-4o-mini");
    assert.equal(config[QA_CRITIC_AGENT.role].model_overridden, false);
    assert.equal(config[QA_CRITIC_AGENT.role].temperature, 0);
    assert.equal(config[QA_CRITIC_AGENT.role].temperature_overridden, true);
  });
});

describe("normalizeHarnessRun preserves a nullable per-call temperature", () => {
  // Regression coverage for a bug caught during review: model_calls[].temperature
  // is meaningfully nullable (null on the offline/no-API-key path, a real
  // number including 0 otherwise). normalizeHarnessRun's other numeric-field
  // normalizations use `Number.isFinite(Number(x)) ? Number(x) : fallback`,
  // but Number(null) === 0, so applying that same pattern to temperature
  // would silently turn a null (offline) temperature into 0. The real
  // implementation must use a typeof check instead.
  test("a null temperature (offline path) stays null, not 0", () => {
    const normalized = normalizeHarnessRun({
      run_id: "run-1",
      model_calls: [{ agent_role: "Supervisor", model: "offline-retrieval", temperature: null }]
    });
    assert.equal(normalized.model_calls[0].temperature, null);
  });

  test("a real 0 temperature is preserved as 0, not coerced to null", () => {
    const normalized = normalizeHarnessRun({
      run_id: "run-2",
      model_calls: [{ agent_role: "QACritic", model: "qa-critic-model", temperature: 0 }]
    });
    assert.equal(normalized.model_calls[0].temperature, 0);
  });

  test("a normal non-zero temperature passes through unchanged", () => {
    const normalized = normalizeHarnessRun({
      run_id: "run-3",
      model_calls: [{ agent_role: "ImpactAnalyst", model: "impact-analyst-model", temperature: 0.7 }]
    });
    assert.equal(normalized.model_calls[0].temperature, 0.7);
  });
});

describe("offline/no-API-key path is unaffected by per-role config", () => {
  test("maybeCallOpenAI short-circuits before any model resolution reaches the network", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_MODEL_IMPACT_ANALYST = "gpt-4o";
    const result = await maybeCallOpenAI({
      question: "does removing a field break anything?",
      chunks: [],
      kind: "agent",
      project: { name: "demo" },
      agent: IMPACT_ANALYST_AGENT,
      input: null
    });
    assert.equal(result.attempted, false);
    assert.equal(result.payload, null);
  });
});

// ── Integration-ish proof: the per-role model actually reaches the outbound
// request AND the harness.model_calls[]-shaped event that runAgentModelAdapter
// returns. lib/agent-graph.js's buildAgentHarnessReport() builds
// harness.model_calls[] by mapping each of these events 1:1
// (agent_role/model/temperature/... copied straight across -- see
// buildAgentHarnessReport's `model_calls: modelEvents.map((event) => ({...}))`
// in lib/agent-graph.js), so asserting on the event returned here directly
// exercises what ends up in harness.model_calls[] without needing to spin up
// the whole HTTP server + LangGraph workflow.
//
// Uses a real local fake OpenAI-compatible HTTP endpoint (genuine loopback
// network I/O), per the task instructions, rather than mocking fetch() --
// the same technique scripts/check-revise-hitl-cross.js and
// scripts/check-agent-impact-stream.js use for their own fake LLM servers.
describe("per-role model reaches the real outbound request and the model_calls event", () => {
  function startFakeLlmServer() {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let rawBody = "";
      for await (const chunk of req) rawBody += chunk.toString();
      const body = rawBody ? JSON.parse(rawBody) : {};
      requests.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const { port } = server.address();
        resolve({ server, baseUrl: `http://127.0.0.1:${port}`, requests });
      });
    });
  }

  const alwaysValid = () => ({ valid: true, errors: [] });

  test("Supervisor/ImpactAnalyst/QACritic each send their own configured model+temperature, and the non-agent path keeps sending the shared default", async () => {
    const fakeLlm = await startFakeLlmServer();
    try {
      process.env.OPENAI_API_KEY = "fake-test-key";
      process.env.OPENAI_BASE_URL = fakeLlm.baseUrl;
      process.env.OPENAI_MODEL = "shared-default-model";
      process.env.OPENAI_TEMPERATURE = "0.2";
      process.env.OPENAI_MODEL_SUPERVISOR = "supervisor-model";
      process.env.OPENAI_TEMPERATURE_SUPERVISOR = "0.1";
      process.env.OPENAI_MODEL_IMPACT_ANALYST = "impact-analyst-model";
      delete process.env.OPENAI_TEMPERATURE_IMPACT_ANALYST; // inherits shared 0.2
      process.env.OPENAI_MODEL_QA_CRITIC = "qa-critic-model";
      process.env.OPENAI_TEMPERATURE_QA_CRITIC = "0.3";

      const project = { name: "demo" };

      const supervisorResult = await runAgentModelAdapter({
        agent: SUPERVISOR_AGENT, question: "q", project, validatePayload: alwaysValid
      });
      const impactResult = await runAgentModelAdapter({
        agent: IMPACT_ANALYST_AGENT, question: "q", project, validatePayload: alwaysValid
      });
      const qaResult = await runAgentModelAdapter({
        agent: QA_CRITIC_AGENT, question: "q", project, validatePayload: alwaysValid
      });
      const chatResult = await runModelAdapter({
        question: "q", chunks: [], kind: "qa", project, validatePayload: alwaysValid
      });

      assert.equal(fakeLlm.requests.length, 4, "expected exactly 4 outbound requests (3 agents + 1 non-agent chat)");

      // What was actually SENT to the provider (the request body maybeCallOpenAI
      // constructs) carries the resolved per-role model/temperature.
      assert.equal(fakeLlm.requests[0].model, "supervisor-model");
      assert.equal(fakeLlm.requests[0].temperature, 0.1);
      assert.equal(fakeLlm.requests[1].model, "impact-analyst-model");
      assert.equal(fakeLlm.requests[1].temperature, 0.2, "ImpactAnalyst has no temperature override, so it inherits OPENAI_TEMPERATURE");
      assert.equal(fakeLlm.requests[2].model, "qa-critic-model");
      assert.equal(fakeLlm.requests[2].temperature, 0.3);
      assert.equal(fakeLlm.requests[3].model, "shared-default-model", "the non-agent /api/chat path must keep using OPENAI_MODEL, never a per-role override");
      assert.equal(fakeLlm.requests[3].temperature, 0.2);

      // What comes BACK out as the model_adapter event -- the exact shape
      // lib/agent-graph.js's buildAgentHarnessReport() copies into
      // harness.model_calls[].
      assert.equal(supervisorResult.event.agent_role, "Supervisor");
      assert.equal(supervisorResult.event.model, "supervisor-model");
      assert.equal(supervisorResult.event.temperature, 0.1);
      assert.equal(impactResult.event.agent_role, "ImpactAnalyst");
      assert.equal(impactResult.event.model, "impact-analyst-model");
      assert.equal(impactResult.event.temperature, 0.2);
      assert.equal(qaResult.event.agent_role, "QACritic");
      assert.equal(qaResult.event.model, "qa-critic-model");
      assert.equal(qaResult.event.temperature, 0.3);
      // The non-agent path's event carries no agent_role.
      assert.equal(chatResult.event.agent_role, null);
      assert.equal(chatResult.event.model, "shared-default-model");
    } finally {
      fakeLlm.server.close();
    }
  });
});
