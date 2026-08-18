import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const REQUEST_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestTo(baseUrl, pathname, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: {
        "content-type": "application/json",
        ...(fetchOptions.headers || {})
      },
      ...fetchOptions,
      signal: controller.signal
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`${options.method || "GET"} ${pathname} failed: ${response.status} ${JSON.stringify(payload)}`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${fetchOptions.method || "GET"} ${pathname} timed out after ${timeoutMs}ms`);
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

async function waitForServer(child, baseUrl) {
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

// ── Minimal JSON-RPC-over-stdio client for the MCP server under test ──
// Mirrors the newline-delimited JSON-RPC framing implemented by
// @modelcontextprotocol/sdk's StdioServerTransport (see
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js).

function createRpcClient(child) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  let stderrText = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`RPC error ${message.error.code}: ${message.error.message}`));
        else resolve(message.result);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString("utf8");
  });

  function send(method, params, { notification = false } = {}) {
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    let id;
    if (!notification) {
      id = nextId++;
      payload.id = id;
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    if (notification) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC "${method}" timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  return {
    request: (method, params) => send(method, params),
    notify: (method, params) => send(method, params, { notification: true }),
    get stderrText() {
      return stderrText;
    }
  };
}

async function waitForMcpReady(child, rpc) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`mcp-server.js exited early with code ${child.exitCode}. stderr:\n${rpc.stderrText}`);
    }
    if (rpc.stderrText.includes("[ai-pm-mcp] Ready.")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`mcp-server.js did not report ready in time. stderr so far:\n${rpc.stderrText}`);
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-pm-mcp-test-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const apiServer = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OPENAI_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let apiStdout = "";
  let apiStderr = "";
  apiServer.stdout.on("data", (chunk) => {
    apiStdout += chunk.toString();
  });
  apiServer.stderr.on("data", (chunk) => {
    apiStderr += chunk.toString();
  });

  let mcpChild = null;

  try {
    await waitForServer(apiServer, baseUrl);

    const imported = await requestTo(baseUrl, "/api/import", {
      method: "POST",
      body: JSON.stringify({ sample: true })
    });
    const projectId = imported.project?.id;
    assert(projectId, "sample import did not return a project id");

    // ── Spawn the real mcp-server.js as a subprocess and drive it over stdio ──
    mcpChild = spawn(process.execPath, ["mcp-server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AI_PM_BASE_URL: baseUrl,
        AI_PM_PROJECT_ID: projectId
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const rpc = createRpcClient(mcpChild);
    await waitForMcpReady(mcpChild, rpc);

    const initResult = await rpc.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ai-pm-mcp-server-test", version: "0.0.1" }
    });
    assert(initResult?.serverInfo?.name === "repomentor", "initialize did not report expected server name");
    await rpc.notify("notifications/initialized", {});

    const toolsList = await rpc.request("tools/list", {});
    const toolNames = (toolsList.tools || []).map((tool) => tool.name).sort();
    assert(toolsList.tools?.length === 4, `expected exactly 4 tools, got ${toolsList.tools?.length}`);
    assert(
      JSON.stringify(toolNames) === JSON.stringify(["analyze_impact", "ask_codebase", "get_onboarding_plan", "list_projects"]),
      `unexpected tool set: ${toolNames.join(", ")}`
    );
    toolsList.tools.forEach((tool) => {
      assert(typeof tool.description === "string" && tool.description.length > 20, `tool ${tool.name} is missing a real description`);
      assert(tool.inputSchema?.type === "object", `tool ${tool.name} inputSchema must be a JSON object schema`);
    });

    const listProjectsResult = await rpc.request("tools/call", { name: "list_projects", arguments: {} });
    assert(!listProjectsResult.isError, `list_projects returned isError: ${JSON.stringify(listProjectsResult)}`);
    const listProjectsText = listProjectsResult.content?.[0]?.text || "";
    assert(listProjectsText.includes(projectId), "list_projects output did not include the imported project id");
    assert(listProjectsText.includes("Sample Commerce API"), "list_projects output did not include the sample project name");

    const askResult = await rpc.request("tools/call", {
      name: "ask_codebase",
      arguments: { question: "How does authentication work in this repository?" }
    });
    assert(!askResult.isError, `ask_codebase returned isError: ${JSON.stringify(askResult)}`);
    const askText = askResult.content?.[0]?.text || "";
    assert(askText.includes("File references ("), "ask_codebase output did not include a file-references section");
    assert(!askText.includes("File references (0)"), "ask_codebase returned zero file references for a question the sample repo should answer");
    assert(askText.includes("Safety status:"), "ask_codebase output did not include a safety status line");

    const impactResult = await rpc.request("tools/call", {
      name: "analyze_impact",
      arguments: { question: "Add a discount percentage field to the Order model." }
    });
    assert(!impactResult.isError, `analyze_impact returned isError: ${JSON.stringify(impactResult)}`);
    const impactText = impactResult.content?.[0]?.text || "";
    assert(impactText.includes("Overall risk level:"), "analyze_impact output did not include an overall risk level");
    assert(impactText.includes("Harness: run_id="), "analyze_impact output did not include harness run metadata");

    const onboardingResult = await rpc.request("tools/call", {
      name: "get_onboarding_plan",
      arguments: { role: "QA", duration: "5 days" }
    });
    assert(!onboardingResult.isError, `get_onboarding_plan returned isError: ${JSON.stringify(onboardingResult)}`);
    const onboardingText = onboardingResult.content?.[0]?.text || "";
    assert(onboardingText.includes("role: QA"), "get_onboarding_plan output did not echo the requested role");
    assert(onboardingText.includes("Day 5"), "get_onboarding_plan output did not include all 5 requested days");

    // Missing required argument should surface as an isError tool result, not a thrown protocol error.
    const missingQuestionResult = await rpc.request("tools/call", {
      name: "ask_codebase",
      arguments: {}
    });
    assert(missingQuestionResult.isError === true, "ask_codebase without a question should return isError: true");
    assert(
      (missingQuestionResult.content?.[0]?.text || "").includes("question is required"),
      "missing-question error text did not explain the problem"
    );

    // Unknown tool name is a protocol-level error (JSON-RPC error), not a tool result.
    let unknownToolError = null;
    try {
      await rpc.request("tools/call", { name: "does_not_exist", arguments: {} });
    } catch (error) {
      unknownToolError = error;
    }
    assert(unknownToolError && /unknown tool/i.test(unknownToolError.message), "calling an unknown tool should raise an RPC error mentioning the unknown tool");

    await stopChild(mcpChild);
    mcpChild = null;

    // ── Error path: mcp-server.js should refuse to start when the API is unreachable ──
    const deadPort = await getFreePort();
    const unreachableChild = spawn(process.execPath, ["mcp-server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AI_PM_BASE_URL: `http://127.0.0.1:${deadPort}`
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let unreachableStderr = "";
    unreachableChild.stderr.on("data", (chunk) => {
      unreachableStderr += chunk.toString();
    });
    const unreachableExitCode = await new Promise((resolve) => {
      unreachableChild.once("exit", (code) => resolve(code));
    });
    assert(unreachableExitCode === 1, `mcp-server.js should exit with code 1 when the API is unreachable, got ${unreachableExitCode}`);
    assert(/Cannot reach the AI PM API/.test(unreachableStderr), "unreachable-API error message did not explain the problem");
    assert(/npm start/.test(unreachableStderr), "unreachable-API error message did not suggest starting the main server");

    console.log(JSON.stringify({
      ok: true,
      projectId,
      toolCount: toolsList.tools.length,
      toolNames,
      askCodebaseHasCitations: !askText.includes("File references (0)"),
      analyzeImpactHasHarness: impactText.includes("Harness: run_id="),
      unreachableApiExitCode: unreachableExitCode
    }, null, 2));
  } catch (error) {
    console.error(apiStdout);
    console.error(apiStderr);
    throw error;
  } finally {
    await stopChild(mcpChild);
    await stopChild(apiServer);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
