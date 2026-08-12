import { spawn } from "node:child_process";

// Runs the node:test pure-function unit suite under test/ (see routing.test.js,
// safety.test.js, retrieval.test.js) and surfaces its pass/fail as this check's
// own exit code, so static-checks.js's readdir-based auto-discovery picks this
// up as just another scripts/check-*.js gate with zero config changes.
//
// NOTE: we deliberately pass the explicit glob "test/**/*.js" rather than the
// bare directory "test/". On this Node build (v24.16.0), `node --test test/`
// (a bare directory positional argument) fails immediately with a CommonJS
// "Cannot find module" error identical to plain `node test/` -- i.e. the
// directory gets treated as an entry-point module instead of a test root. Glob
// patterns (and the zero-argument default-discovery form) do not have this
// problem, so we use a glob here to reliably scope the run to test/ only
// (running bare `node --test` with no path would also re-run every
// scripts/*-test.js smoke/integration script via its "*-test.js" auto-discovery
// pattern, which duplicates the rest of `npm test` and is not what this check
// is for).
function runUnitTests() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "test/**/*.js"], {
      cwd: process.cwd(),
      stdio: "inherit"
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`node --test test/**/*.js failed with exit code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

await runUnitTests();

console.log(JSON.stringify({
  ok: true,
  runner: "node --test",
  target: "test/**/*.js"
}, null, 2));
