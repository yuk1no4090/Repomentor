import { readFileSync } from "node:fs";
import { readServerSource } from "./shared/source-reader.js";

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

// SLIM-A consolidation note: this file used to also pin DEFAULT_USER_ID,
// userPreferencesByUser, resolveUserId/getUserPreferences/setUserPreferences
// function names, MEMORY_USER_MISMATCH, the memory_items.user_id column, and
// x-user-id header support against server source. All of that is now proven
// -- more strongly, through the real call path -- by
// scripts/user-memory-isolation-test.js (this file's own behavioral
// companion, part of `npm test` via test:user-memory): it drives real HTTP
// requests with distinct X-User-Id headers for two users and asserts their
// preferences and long-term memories are never cross-visible, and a
// cross-user memory confirmation attempt returns the real
// payload.code === "MEMORY_USER_MISMATCH". getUserPreferences/
// setUserPreferences are additionally unit-tested directly by
// test/preferences.test.js's "getUserPreferences purity" suite, which calls
// the real exported functions. A mutation removing the user_id column,
// breaking X-User-Id header handling, or loosening MEMORY_USER_MISMATCH would
// fail one of those real assertions.
//
// What remains here is what neither of those can see: (1) package.json
// wiring; (2) the idx_memory_items_user_status SQL index -- dropping an
// index is a performance regression, not a correctness one, so no functional
// test (unit or behavioral) would ever notice its removal; (3) doc-sync for
// terms check-architecture-docs.js's own generic list does not already cover
// (it DOES already require "userPreferencesByUser" -- see that file -- so
// that one is not re-pinned here).

const server = await readServerSource();
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const readme = readFileSync("README.md", "utf8");
const architecture = readFileSync("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8");

assertIncludes(server, "idx_memory_items_user_status", "long-term memory user index");

if (packageJson.scripts["test:user-memory"] !== "node scripts/user-memory-isolation-test.js") {
  throw new Error("package.json is missing test:user-memory script");
}

assertIncludes(packageJson.scripts.test, "npm run test:user-memory", "full test suite user-memory step");
assertIncludes(readme, "test:user-memory", "README user memory test docs");
assertIncludes(readme, "X-User-Id", "README user id docs");
assertIncludes(architecture, "memory_items.user_id", "architecture long-term memory user id docs");

console.log(JSON.stringify({ ok: true, checked: "user-memory-isolation" }, null, 2));
