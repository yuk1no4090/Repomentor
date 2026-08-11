import { readFileSync } from "node:fs";
import { readServerSource } from "./shared/source-reader.js";

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

const server = await readServerSource();
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const readme = readFileSync("README.md", "utf8");
const architecture = readFileSync("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8");

[
  ["DEFAULT_USER_ID", "default local user"],
  ["userPreferencesByUser", "user-scoped preference store"],
  ["function resolveUserId", "request user resolver"],
  ["function getUserPreferences", "user-scoped preference reader"],
  ["function setUserPreferences", "user-scoped preference writer"],
  ["MEMORY_USER_MISMATCH", "cross-user memory guard"],
  ["user_id TEXT", "long-term memory user column"],
  ["idx_memory_items_user_status", "long-term memory user index"],
  ["x-user-id", "user id request header support"]
].forEach(([needle, label]) => assertIncludes(server, needle, label));

if (packageJson.scripts["test:user-memory"] !== "node scripts/user-memory-isolation-test.js") {
  throw new Error("package.json is missing test:user-memory script");
}

assertIncludes(packageJson.scripts.test, "npm run test:user-memory", "full test suite user-memory step");
assertIncludes(readme, "test:user-memory", "README user memory test docs");
assertIncludes(readme, "X-User-Id", "README user id docs");
assertIncludes(architecture, "userPreferencesByUser", "architecture user preference docs");
assertIncludes(architecture, "memory_items.user_id", "architecture long-term memory user id docs");

console.log(JSON.stringify({ ok: true, checked: "user-memory-isolation" }, null, 2));
