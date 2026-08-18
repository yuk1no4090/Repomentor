import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { withWorkflowTimeout } from "../lib/agent-graph.js";

// Unit tests for the *real* withWorkflowTimeout() exported by lib/agent-graph.js.
// This is what runAgenticImpactWorkflow() uses to race a LangGraph
// graph.invoke() call against AGENT_BUDGETS.timeout_ms and, on timeout, abort
// the AbortController it now threads through to graph.invoke()'s `signal`
// option so the pregel loop stops scheduling further supersteps instead of
// running the rest of the graph to completion unobserved after the caller
// has already moved on to the deterministic fallback response.
//
// These tests exercise withWorkflowTimeout() directly with a plain,
// manually-controlled promise standing in for graph.invoke() (rather than a
// real LangGraph run), since AGENT_BUDGETS.timeout_ms is a hardcoded 30s (not
// env-configurable) and a real end-to-end test would need to actually wait
// that out.

function neverSettles() {
  return new Promise(() => {});
}

describe("withWorkflowTimeout", () => {
  test("resolves with the underlying value when it settles before the timeout", async () => {
    const controller = new AbortController();
    const result = await withWorkflowTimeout(Promise.resolve("done"), 50, controller);
    assert.equal(result, "done");
    assert.equal(controller.signal.aborted, false, "controller should not be aborted when the promise settles in time");
  });

  test("rejects with a WORKFLOW_TIMEOUT error when the promise does not settle in time", async () => {
    const controller = new AbortController();
    await assert.rejects(
      () => withWorkflowTimeout(neverSettles(), 20, controller),
      (error) => {
        assert.equal(error.code, "WORKFLOW_TIMEOUT");
        assert.match(error.message, /timed out after 20ms/);
        return true;
      }
    );
  });

  test("aborts the passed-in controller's signal when the timeout fires (so the graph invocation observes cancellation)", async () => {
    const controller = new AbortController();
    await assert.rejects(() => withWorkflowTimeout(neverSettles(), 20, controller));
    assert.equal(controller.signal.aborted, true, "controller.signal should be aborted once the workflow times out");
  });

  test("works without a controller argument (backward-compatible call shape)", async () => {
    await assert.rejects(
      () => withWorkflowTimeout(neverSettles(), 20),
      (error) => {
        assert.equal(error.code, "WORKFLOW_TIMEOUT");
        return true;
      }
    );
  });

  test("does not throw when the controller is already aborted before the timeout fires", async () => {
    const controller = new AbortController();
    controller.abort("pre-aborted for an unrelated reason");
    await assert.rejects(() => withWorkflowTimeout(neverSettles(), 20, controller));
    assert.equal(controller.signal.aborted, true);
  });

  test("a late settlement of the underlying promise after timeout does not change the already-rejected outcome", async () => {
    const controller = new AbortController();
    let resolveLate;
    const latePromise = new Promise((resolve) => {
      resolveLate = resolve;
    });
    const timeoutPromise = withWorkflowTimeout(latePromise, 20, controller);
    await assert.rejects(() => timeoutPromise, (error) => {
      assert.equal(error.code, "WORKFLOW_TIMEOUT");
      return true;
    });
    // Resolving the underlying promise late (as an in-flight LangGraph node
    // finishing its own work after the abort signal fired would) must not
    // throw or surface anywhere — the wrapper promise already settled.
    resolveLate("too-late-value");
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("does not clear/reject once resolved, even if the underlying promise later rejects", async () => {
    const controller = new AbortController();
    let rejectLate;
    const latePromise = new Promise((_resolve, reject) => {
      rejectLate = reject;
    });
    const result = await withWorkflowTimeout(
      Promise.race([Promise.resolve("fast-value"), latePromise]),
      50,
      controller
    );
    assert.equal(result, "fast-value");
    // Reject the loser of the race after the wrapper already resolved; this
    // must not produce an unhandled rejection or change the outcome.
    rejectLate(new Error("late rejection from the losing promise"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
