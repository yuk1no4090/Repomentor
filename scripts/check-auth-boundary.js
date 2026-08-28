import { readFileSync } from "node:fs";

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

// SLIM-A consolidation note: this file used to also pin every auth function
// name (parseAuthTokenConfig, getRequestAuthToken, resolveAuthenticatedUserId,
// authUserFromIdentity, normalizeAuthTokenRecord, findStoreAuthTokenIdentity,
// upsertLocalAuthUser, disableLocalAuthUser, listAuthUsers, recordAuthEvent,
// listAuthEvents, requireAuthScope, requiredScopeForRequest), every
// /api/auth/* route string, every AUTH_* error code, and the "health remains
// public"/token_count/users_indexed health metadata against server source.
// All of that is now proven -- more strongly, through the real call path --
// by scripts/auth-boundary-test.js (this file's own behavioral companion,
// part of `npm test` via test:auth): it spawns the real server and drives
// real HTTP calls through every one of those routes, asserting the exact
// real status codes and payload.code values (AUTH_REQUIRED, AUTH_INVALID,
// AUTH_USER_MISMATCH, AUTH_SCOPE_FORBIDDEN, ...), real scope enforcement
// (viewer vs admin), real token creation/disable lifecycle, and the real
// health.auth.{required,token_count,scopes_enabled,users_indexed} fields --
// including implicitly proving /api/health stays public, since
// waitForServer() polls it with no token at all before anything else runs.
// A mutation to any of those function names' effects, route strings, or
// error codes would fail one of those real HTTP assertions.
//
// What remains here is what scripts/auth-boundary-test.js's real assertions
// cannot guard: (1) package.json wiring; (2) README/architecture doc-sync
// for the specific field names ("authUsers", "authTokens", "authEvents",
// "scopes") that check-architecture-docs.js's own generic term list does not
// already require (it DOES already require "## Auth Boundary",
// "token-bound user identity", and "AUTH_USER_MISMATCH" -- see that file --
// so those three are not re-pinned here to avoid a duplicate-of-a-duplicate).
// The README route/error-code mentions this file used to check are also
// dropped: check-api-docs.js already auto-discovers every `/api/auth/*`
// route from server source and cross-checks README + USER_GUIDE, and its own
// requiredErrorDocSnippets list already includes AUTH_REQUIRED, AUTH_INVALID,
// AUTH_USER_MISMATCH, and AUTH_SCOPE_FORBIDDEN verbatim.

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const architecture = readFileSync("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8");

if (packageJson.scripts["test:auth"] !== "node scripts/auth-boundary-test.js") {
  throw new Error("package.json is missing test:auth script");
}

assertIncludes(packageJson.scripts.test, "npm run test:auth", "full test suite auth step");
assertIncludes(architecture, "authUsers", "architecture auth user audit docs");
assertIncludes(architecture, "authTokens", "architecture auth token docs");
assertIncludes(architecture, "authEvents", "architecture auth event audit docs");
assertIncludes(architecture, "scopes", "architecture auth scopes docs");

console.log(JSON.stringify({ ok: true, checked: "auth-boundary" }, null, 2));
