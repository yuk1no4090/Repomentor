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

/**
 * Strips `//` line comments and `/* *\/` block comments from a JS source string,
 * leaving everything else — including string/template literal contents — intact.
 *
 * This exists because several check-*.js scripts assert a substring exists in
 * the *executable* source via `serverSource.includes(...)`, but a substring
 * that only appears inside a comment (e.g. a docstring that happens to mention
 * the exact call shape being asserted) satisfies `.includes()` just as well as
 * real code does — silently turning the assertion into a tautology that can
 * never fail no matter how badly the real implementation regresses. Running
 * a check's target snippets against `stripComments(source)` instead closes
 * that gap: a comment-only occurrence of the snippet disappears, so the
 * assertion can only pass if the snippet is present in real code.
 *
 * Implemented as a small single-pass character scanner with three states —
 * normal code, "inside a comment" (started by `//` or `/*`), and "inside a
 * string/template literal" (started by `'`, `"`, or `` ` ``) — specifically so
 * that:
 *   - a `//` inside a string (e.g. `"https://example.com"`) is NOT treated as
 *     the start of a line comment, because once inside a string/template
 *     literal this scanner does not look for comment starters at all until
 *     the matching (non-escaped) closing quote is seen;
 *   - a `/*` inside a string is NOT treated as the start of a block comment,
 *     for the same reason;
 *   - an escaped quote (`\'`, `\"`, `` \` ``) inside a string does not
 *     prematurely end that string.
 *
 * Deliberately does NOT do full JS parsing: template-literal `${...}`
 * interpolations are treated as opaque string content rather than re-entering
 * "code" mode, and regex literals are not specially recognized (a literal
 * regex containing `//` or `/*` could in principle be misread as a comment
 * start). Neither limitation matters for this repo's check-*.js use: the
 * snippets being asserted live in plain statements/object literals, not
 * inside template interpolations or regex literals. Only used by check
 * scripts that opt into it — readServerSource()/readFrontendSource() above
 * are unchanged, so the ~20 other check-*.js scripts that rely on their
 * existing (comments-included) behavior are unaffected.
 */
export function stripComments(source) {
  const text = String(source ?? "");
  const length = text.length;
  let out = "";
  let i = 0;
  while (i < length) {
    const ch = text[i];
    const nextCh = i + 1 < length ? text[i + 1] : "";
    if (ch === "/" && nextCh === "/") {
      i += 2;
      while (i < length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && nextCh === "*") {
      i += 2;
      while (i < length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i = Math.min(i + 2, length);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < length) {
        const c = text[i];
        if (c === "\\") {
          out += c;
          i++;
          if (i < length) {
            out += text[i];
            i++;
          }
          continue;
        }
        out += c;
        i++;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
