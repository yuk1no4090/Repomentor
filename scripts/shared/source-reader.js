import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// NOTE: this file intentionally lives under scripts/shared/ (not scripts/) so that
// static-checks.js's readdir-based auto-discovery (which runs every scripts/check-*.js)
// never picks it up as a check to execute.

async function collectLibFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      files.push(...(await collectLibFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Lists the backend source files that make up the server runtime: server.js plus
 * any lib/**\/*.js modules (the lib/ directory is optional and simply skipped while
 * it does not exist yet). Sorted by path for deterministic output.
 *
 * Exposed separately from readServerSource() for checks that need per-file
 * granularity (e.g. line-numbered scanning) instead of one concatenated string.
 */
export async function listServerSourceFiles() {
  const libFiles = await collectLibFiles("lib");
  return ["server.js", ...libFiles].sort();
}

/**
 * Reads server.js plus any lib/**\/*.js modules and concatenates them (sorted by
 * path) into a single source string.
 *
 * This is the single point of truth check-*.js scripts use to inspect backend
 * source code via String.includes()/regex snippet assertions. When server.js is
 * eventually split into server.js + lib/*.js modules, those checks keep working
 * unmodified because they search the combined string rather than a single file.
 */
// This repo has no .gitattributes and its tracked files are checked out with CRLF
// line endings on Windows. A number of check-*.js scripts locate code with
// LF-anchored regexes (e.g. `\n  };\n}`), which silently fail to match against raw
// CRLF content. Normalizing here means every check-*.js script that reads source
// through this module sees consistent `\n` line endings, regardless of the host
// platform's checkout behavior.
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

export async function readServerSource() {
  const files = await listServerSourceFiles();
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return contents.map(normalizeLineEndings).join("\n");
}

/**
 * Reads the frontend bundle source. Kept as a single-file read today
 * (public/app.js), but funneled through one function so that if the frontend
 * is ever split into modules, only this function needs to change.
 */
export async function readFrontendSource() {
  const content = await readFile("public/app.js", "utf8");
  return normalizeLineEndings(content);
}
