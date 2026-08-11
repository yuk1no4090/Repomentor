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
  ["AI_PM_AUTH_REQUIRED", "auth required env"],
  ["AI_PM_USER_TOKENS", "auth token mapping env"],
  ["function parseAuthTokenConfig", "auth token parser"],
  ["function getRequestAuthToken", "request auth token parser"],
  ["function resolveAuthenticatedUserId", "authenticated user resolver"],
  ["function authUserFromIdentity", "auth user record builder"],
  ["function normalizeAuthTokenRecord", "auth token record normalizer"],
  ["function findStoreAuthTokenIdentity", "store auth token resolver"],
  ["function upsertLocalAuthUser", "local auth user creation"],
  ["function disableLocalAuthUser", "local auth user disable"],
  ["function listAuthUsers", "auth user audit listing"],
  ["function recordAuthEvent", "auth event recorder"],
  ["function listAuthEvents", "auth event audit listing"],
  ["function requireAuthScope", "auth scope gate"],
  ["function requiredScopeForRequest", "route scope mapping"],
  ["\"/api/auth/me\"", "auth me endpoint"],
  ["\"/api/auth/users\"", "auth users endpoint"],
  ["\"/api/auth/users/disable\"", "auth user disable endpoint"],
  ["\"/api/auth/events\"", "auth events endpoint"],
  ["AUTH_SCOPE_FORBIDDEN", "scope forbidden error"],
  ["AUTH_REQUIRED", "missing auth error"],
  ["AUTH_INVALID", "invalid auth error"],
  ["AUTH_USER_MISMATCH", "user mismatch error"],
  ["pathname !== \"/api/health\"", "health remains public"],
  ["token_count", "health auth metadata"],
  ["users_indexed", "health auth user count metadata"]
].forEach(([needle, label]) => assertIncludes(server, needle, label));

if (packageJson.scripts["test:auth"] !== "node scripts/auth-boundary-test.js") {
  throw new Error("package.json is missing test:auth script");
}

assertIncludes(packageJson.scripts.test, "npm run test:auth", "full test suite auth step");
assertIncludes(readme, "AI_PM_AUTH_REQUIRED", "README auth env docs");
assertIncludes(readme, "/api/auth/me", "README auth me docs");
assertIncludes(readme, "/api/auth/users", "README auth users docs");
assertIncludes(readme, "/api/auth/users/disable", "README auth user disable docs");
assertIncludes(readme, "/api/auth/events", "README auth events docs");
assertIncludes(readme, "AUTH_USER_MISMATCH", "README auth error docs");
assertIncludes(readme, "AUTH_SCOPE_FORBIDDEN", "README auth scope error docs");
assertIncludes(architecture, "token-bound user identity", "architecture auth boundary docs");
assertIncludes(architecture, "authUsers", "architecture auth user audit docs");
assertIncludes(architecture, "authTokens", "architecture auth token docs");
assertIncludes(architecture, "authEvents", "architecture auth event audit docs");
assertIncludes(architecture, "scopes", "architecture auth scopes docs");

console.log(JSON.stringify({ ok: true, checked: "auth-boundary" }, null, 2));
