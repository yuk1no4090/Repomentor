import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  getUserPreferences, setUserPreferences, createEmptyPreferences, createMemorySuggestions
} from "../lib/answers.js";

// Regression coverage for a reviewer-flagged bug: getUserPreferences() used to
// lazily write a normalized-defaults entry into store.userPreferencesByUser
// on first read for a given userId. That hidden write is a problem now that
// server.js's heavy-mutation routes (see isHeavyMutationRoute() in
// server.js) call getUserPreferences() — directly, and indirectly via
// createMemorySuggestions() here and the LangGraph "memory" node /
// runAgenticImpactWorkflow() in lib/agent-graph.js — during their *unlocked*
// compute phase. A write there races with concurrent requests outside any
// lock. getUserPreferences() must be a pure read; only setUserPreferences()
// may create/update a store-backed preferences entry.

function makeStore() {
  return {
    userPreferences: createEmptyPreferences(),
    userPreferencesByUser: {
      "local-user": createEmptyPreferences()
    },
    memorySuggestions: []
  };
}

describe("getUserPreferences purity", () => {
  test("does not mutate the store when reading preferences for a userId with no existing entry", () => {
    const store = makeStore();
    const before = JSON.stringify(store);
    const prefs = getUserPreferences(store, "brand-new-user");
    assert.equal(JSON.stringify(store), before, "getUserPreferences must not write into store.userPreferencesByUser as a read side effect");
    assert.equal(prefs.role, null);
    assert.deepEqual(prefs.focusAreas, []);
    assert.equal(store.userPreferencesByUser["brand-new-user"], undefined, "no entry should have been created for the unknown user");
  });

  test("does not mutate the store when reading preferences for the default user", () => {
    const store = makeStore();
    const before = JSON.stringify(store);
    getUserPreferences(store, "local-user");
    assert.equal(JSON.stringify(store), before);
  });

  test("returns normalized defaults for an unknown user without requiring a prior setUserPreferences call", () => {
    const store = makeStore();
    const prefs = getUserPreferences(store, "another-user");
    assert.deepEqual(prefs, createEmptyPreferences());
  });

  test("falls back to the legacy top-level store.userPreferences for the default user when userPreferencesByUser has no entry yet, without creating one", () => {
    const store = {
      userPreferences: { ...createEmptyPreferences(), role: "Backend Engineer" },
      userPreferencesByUser: {},
      memorySuggestions: []
    };
    const prefs = getUserPreferences(store, "local-user");
    assert.equal(prefs.role, "Backend Engineer");
    assert.equal(store.userPreferencesByUser["local-user"], undefined, "reading should not create the entry");
  });

  test("read path still reflects preferences previously written via setUserPreferences", () => {
    const store = makeStore();
    setUserPreferences(store, "some-user", { role: "QA" });
    const before = JSON.stringify(store);
    const prefs = getUserPreferences(store, "some-user");
    assert.equal(prefs.role, "QA");
    assert.equal(JSON.stringify(store), before, "a subsequent read must still not mutate the store");
  });

  test("survives being called against a store with no userPreferencesByUser field at all (defensive optional-chaining path)", () => {
    const store = { userPreferences: createEmptyPreferences(), memorySuggestions: [] };
    const prefs = getUserPreferences(store, "someone");
    assert.deepEqual(prefs, createEmptyPreferences());
    assert.equal(store.userPreferencesByUser, undefined, "must not create store.userPreferencesByUser as a side effect of reading");
  });

  test("createMemorySuggestions() (which internally reads preferences via getUserPreferences) does not create a userPreferencesByUser entry either", () => {
    const store = makeStore();
    const before = JSON.stringify(store);
    createMemorySuggestions(store, "project-1", "As a QA, what changed in order status handling?", "fresh-user");
    assert.equal(store.userPreferencesByUser["fresh-user"], undefined, "no preferences entry should have been created as a side effect of drafting memory suggestions");
    // createMemorySuggestions is allowed to *read* store.memorySuggestions but
    // this store starts with none and the call above must not push into it
    // itself (appendMemorySuggestions is the only mutator, called separately
    // by server.js at commit time) — so the store should be byte-for-byte
    // unchanged.
    assert.equal(JSON.stringify(store), before);
  });
});
