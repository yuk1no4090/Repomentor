import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments, readServerSourceStripped, listServerSourceFiles } from "../scripts/shared/source-reader.js";

// Unit tests for stripComments() (scripts/shared/source-reader.js), added
// alongside the fix for check-hitl-resume.js's comment-tautology bug: several
// of its `serverSource.includes("...")` assertions were satisfied by a
// docstring/comment that merely *mentions* the target snippet, so the
// assertion could never fail even if the real call was removed or altered.
// stripComments() lets those checks match against comment-free source instead.
// These tests pin down the exact behavior that fix depends on: line comments
// and block comments are removed, but anything inside a string or template
// literal — including a `//`-containing URL or a `/*`-looking sequence — is
// left completely untouched.

describe("stripComments", () => {
  test("removes a `//` line comment, keeping the code before it on the line", () => {
    const source = 'const x = 1; // trailing comment\nconst y = 2;';
    const result = stripComments(source);
    assert.equal(result.includes("trailing comment"), false);
    assert.ok(result.includes("const x = 1;"));
    assert.ok(result.includes("const y = 2;"));
  });

  test("removes a full standalone `//` line comment", () => {
    const source = "// this whole line is a comment\nconst kept = true;";
    const result = stripComments(source);
    assert.equal(result.includes("this whole line is a comment"), false);
    assert.ok(result.includes("const kept = true;"));
  });

  test("removes a single-line `/* ... */` block comment", () => {
    const source = "const a = 1; /* inline block comment */ const b = 2;";
    const result = stripComments(source);
    assert.equal(result.includes("inline block comment"), false);
    assert.ok(result.includes("const a = 1;"));
    assert.ok(result.includes("const b = 2;"));
  });

  test("removes a multi-line `/* ... */` block comment (e.g. a JSDoc-style header)", () => {
    const source = [
      "/**",
      " * This function calls interrupt(reviewRequest) to pause the graph.",
      " * Also mentions new Command({ resume: pausedDecision }) and __interrupt__.",
      " */",
      "function real() { return isInterrupted(state); }"
    ].join("\n");
    const result = stripComments(source);
    assert.equal(result.includes("interrupt(reviewRequest)"), false,
      "a call shape mentioned only inside a /** ... */ docstring must not survive stripComments");
    assert.equal(result.includes("__interrupt__"), false);
    assert.ok(result.includes("function real() { return isInterrupted(state); }"),
      "real code outside the comment must be preserved verbatim");
  });

  test("does NOT strip a `//` that appears inside a string literal (e.g. a URL)", () => {
    const source = 'const url = "https://example.com/path"; // real comment here';
    const result = stripComments(source);
    assert.ok(result.includes('"https://example.com/path"'),
      "the // inside the URL string must survive untouched");
    assert.equal(result.includes("real comment here"), false,
      "the actual trailing // comment must still be removed");
  });

  test("does NOT strip a `/*`-looking sequence inside a string literal", () => {
    const source = 'const pattern = "/* not a real comment */"; const kept = 1;';
    const result = stripComments(source);
    assert.ok(result.includes('"/* not a real comment */"'),
      "a /* .. */-shaped sequence inside a string literal must be preserved, not treated as a comment");
    assert.ok(result.includes("const kept = 1;"));
  });

  test("does NOT strip comment-shaped text inside a single-quoted string", () => {
    const source = "const s = 'not // a comment and not /* a comment */ either';";
    const result = stripComments(source);
    assert.ok(result.includes("'not // a comment and not /* a comment */ either'"));
  });

  test("does NOT strip comment-shaped text inside a template literal", () => {
    const source = "const msg = `resume mode is native_interrupt_resume // see docs /* also */`;";
    const result = stripComments(source);
    assert.ok(result.includes("`resume mode is native_interrupt_resume // see docs /* also */`"),
      "template literal contents (including // and /* sequences) must be preserved untouched");
  });

  test("handles escaped quotes inside a string without ending the string early", () => {
    const source = 'const s = "he said \\"// not a comment\\" ok"; // real trailing comment';
    const result = stripComments(source);
    assert.ok(result.includes('"he said \\"// not a comment\\" ok"'),
      "an escaped quote inside a string must not be treated as the string's closing quote");
    assert.equal(result.includes("real trailing comment"), false);
  });

  test("realistic mixed snippet: strips comments, keeps real calls and string contents", () => {
    const source = [
      "// human_review calls interrupt() to genuinely pause the graph.",
      "const decision = interrupt(reviewRequest);",
      "/* on resume: new Command({ resume: pausedDecision }) is used */",
      'const endpoint = "https://api.example.com/v1"; // not stripped from the string above',
      'if (isInterrupted(state)) { return "__interrupt__ detected"; }'
    ].join("\n");
    const result = stripComments(source);
    assert.equal(result.includes("human_review calls interrupt()"), false);
    assert.equal(result.includes("new Command({ resume: pausedDecision }) is used"), false);
    assert.ok(result.includes("const decision = interrupt(reviewRequest);"));
    assert.ok(result.includes('"https://api.example.com/v1"'));
    assert.ok(result.includes('if (isInterrupted(state)) { return "__interrupt__ detected"; }'));
  });

  test("empty and non-string-ish input does not throw", () => {
    assert.equal(stripComments(""), "");
    assert.equal(stripComments(undefined), "");
    assert.equal(stripComments(null), "");
  });
});

// ── Regex-literal handling ──────────────────────────────────────────────
//
// A naive scanner that only knows "line comment / block comment / string
// literal" (no regex awareness) desyncs on a regex literal containing quote
// characters: it treats the FIRST quote inside the regex's pattern text as
// the start of a string literal, then hunts for a "closing" quote of the
// same type — which may be a different, unrelated quote character further
// into (or even past) that same regex, at the wrong position. That
// mispairing can leave the scanner still "inside a string" long past where
// the regex literal actually ends, silently swallowing everything after it
// — including real comments in the same file, or (before per-file
// stripping was added) in a LATER concatenated file — as fake "string
// content" instead of stripping/preserving it correctly.
describe("stripComments: regex literal handling", () => {
  // ── Regression test for the exact bug found in review round 3 ──
  // lib/safety.js:3's SENSITIVE_VALUE_PATTERN regex contains `["']` (a
  // character class holding both quote types) followed later by
  // `(?:"[^"]{8,}"|'[^']{8,}'|...)` (more quotes) — enough quote characters,
  // in the wrong pairing, to desync a naive scanner. Confirmed RED against
  // the pre-fix stripComments(): the comment on the next line survived
  // (worse: the entire snippet came back byte-for-byte unchanged, because
  // the scanner thought it was still inside an unterminated string all the
  // way to EOF). This is the actual production regex, read live from
  // lib/safety.js so the test tracks the real file rather than a
  // hand-simplified stand-in — per review instructions, lib/safety.js
  // itself must not be modified to "fix" this; the scanner has to handle it
  // as-is.
  test("REGRESSION: a real comment after lib/safety.js's SENSITIVE_VALUE_PATTERN regex is still stripped", () => {
    const safetyLines = readFileSync("lib/safety.js", "utf8").split("\n");
    const regexLine = safetyLines[2]; // `const SENSITIVE_VALUE_PATTERN = /.../i;` (line 3, 0-indexed here)
    assert.ok(regexLine.includes("SENSITIVE_VALUE_PATTERN"),
      "test fixture assumption broken: lib/safety.js line 3 is no longer the SENSITIVE_VALUE_PATTERN declaration — update the line index");
    // Sanity-check the fixture actually has the quote-parity shape this test targets,
    // so a future edit to that regex silently invalidates this regression coverage
    // loudly (via this assertion) rather than the test just quietly stopping to
    // exercise the bug it's meant to catch.
    assert.ok((regexLine.match(/"/g) || []).length >= 3 && (regexLine.match(/'/g) || []).length >= 3,
      "test fixture assumption broken: expected the regex line to contain multiple quote characters of both kinds");

    const source = [regexLine, "// real trailing comment that must be stripped", "const kept = 1;"].join("\n");
    const result = stripComments(source);
    assert.equal(result.includes("real trailing comment"), false,
      "REGRESSION: the comment after the regex literal survived stripComments — the scanner desynced on the regex's quote characters");
    assert.ok(result.split("\n")[0] === regexLine,
      "the regex literal itself must be preserved verbatim, not partially consumed");
    assert.ok(result.includes("const kept = 1;"),
      "code after the stripped comment must still be present");
  });

  test("a regex literal containing an escaped `//` sequence is preserved, and a real trailing comment is still stripped", () => {
    const source = 'const r = /a\\/\\/b/; // real comment';
    const result = stripComments(source);
    assert.ok(result.includes("const r = /a\\/\\/b/;"), "the regex literal (with its escaped slashes) must survive verbatim");
    assert.equal(result.includes("real comment"), false, "the trailing // comment must still be stripped");
  });

  test("a regex literal containing an escaped `/*...*/`-shaped sequence is preserved, not treated as a block comment", () => {
    const source = 'const r = /a\\/\\*b\\*\\/c/; const kept = 1;';
    const result = stripComments(source);
    assert.ok(result.includes("const r = /a\\/\\*b\\*\\/c/;"), "the regex literal must survive verbatim, not be misread as a /* block comment */");
    assert.ok(result.includes("const kept = 1;"));
  });

  test("a regex literal containing a character class with a literal `/` inside it does not end early", () => {
    // `/[/]/ ` is ONE complete regex (character class matching a literal "/"),
    // not "regex /[/`, stray `]`, regex `/ /`".
    const source = "const r = /[/]/; // real comment";
    const result = stripComments(source);
    assert.ok(result.includes("const r = /[/]/;"), "the whole /[/]/  regex must be preserved as one literal");
    assert.equal(result.includes("real comment"), false);
  });

  test("a regex literal containing single and double quotes (mirroring the safety.js shape) is preserved and does not swallow a later comment", () => {
    const source = 'const r = /["\']value["\']/; // real comment';
    const result = stripComments(source);
    assert.ok(result.includes('const r = /["\']value["\']/;'), "the quote-containing regex literal must survive verbatim");
    assert.equal(result.includes("real comment"), false);
  });

  test("division is not misread as a regex literal (a/b/c ambiguity)", () => {
    const source = "const x = a / b / c; // real comment";
    const result = stripComments(source);
    assert.ok(result.includes("const x = a / b / c;"), "both `/` characters must be preserved as division operators, untouched");
    assert.equal(result.includes("real comment"), false, "the trailing comment must still be recognized and stripped");
  });

  test("a regex literal is correctly recognized after keywords like return/typeof/case", () => {
    const source = [
      "function f(x) {",
      "  if (typeof x === \"string\") return /^abc$/.test(x); // real comment 1",
      "  switch (x) { case /foo/.source: break; } // real comment 2",
      "}"
    ].join("\n");
    const result = stripComments(source);
    assert.ok(result.includes("return /^abc$/.test(x);"));
    assert.ok(result.includes("case /foo/.source: break;"));
    assert.equal(result.includes("real comment 1"), false);
    assert.equal(result.includes("real comment 2"), false);
  });

  test("a regex literal right after a closing paren/bracket is NOT misread (division context)", () => {
    // After `)` or `]`, the previous token is value-like, so a following `/`
    // must be division, not a regex start.
    const source = "const r = (a + b) / 2; // real comment";
    const result = stripComments(source);
    assert.ok(result.includes("const r = (a + b) / 2;"));
    assert.equal(result.includes("real comment"), false);
  });
});

// ── Per-file isolation (readServerSourceStripped vs. concatenate-then-strip) ──
describe("stripComments: per-file isolation", () => {
  test("one file's regex-heavy content does not affect stripping of a separately-processed file", () => {
    // Simulates the exact shape of the original bug: fileA ends with a
    // quote-heavy regex literal; fileB (processed independently, the way
    // readServerSourceStripped() does it) opens with a real comment. If
    // fileA's scan state ever leaked into fileB (e.g. by concatenating
    // first and stripping once), fileB's comment would silently survive.
    const fileA = 'const SENSITIVE_VALUE_PATTERN = /(?:api[_-]?key)["\']?\\s*[:=]\\s*(?:"[^"]{8,}"|\'[^\']{8,}\')/i;\n';
    const fileB = "// this must be recognized and stripped when fileB is scanned on its own\nconst kept = 1;\n";

    const strippedA = stripComments(fileA);
    const strippedB = stripComments(fileB);

    // fileA parses to completion on its own (no throw) and is preserved verbatim.
    assert.equal(strippedA, fileA);
    // fileB, stripped independently, has its own comment removed correctly —
    // proving fileA's content (were it processed first via naive
    // concatenate-then-strip) has no way to affect fileB's result here.
    assert.equal(strippedB.includes("this must be recognized and stripped"), false);
    assert.ok(strippedB.includes("const kept = 1;"));
  });

  test("readServerSourceStripped() strips server.js + every lib/*.js file, and the real lib/store.js header comment is gone", async () => {
    // This is the literal symptom review round 3 caught: with the old
    // concatenate-then-strip approach, lib/safety.js's regex desynced the
    // scanner and the NEXT file in sort order (lib/store.js, whose opening
    // comment reads "── Resident in-memory cache ──") survived untouched in
    // the stripped output. Asserting on the real files (not synthetic
    // stand-ins) here is the strongest possible regression guard for the
    // actual reported bug.
    const fileList = await listServerSourceFiles();
    assert.ok(fileList.includes("lib/safety.js"), "expected lib/safety.js to be part of the server source set");
    assert.ok(fileList.includes("lib/store.js"), "expected lib/store.js to be part of the server source set");
    const stripped = await readServerSourceStripped();
    assert.equal(stripped.includes("Resident in-memory cache"), false,
      "REGRESSION: lib/store.js's real header comment survived — a prior file's parse state leaked across the file boundary");
  });
});

// ── Fail loudly on desync, instead of silently returning a wrong result ──
describe("stripComments: throws on an unterminated string/template/block comment", () => {
  test("throws on an unterminated double-quoted string", () => {
    assert.throws(() => stripComments('const s = "never closed'), /unterminated string literal/);
  });

  test("throws on an unterminated single-quoted string", () => {
    assert.throws(() => stripComments("const s = 'never closed"), /unterminated string literal/);
  });

  test("throws on an unterminated template literal", () => {
    assert.throws(() => stripComments("const s = `never closed"), /unterminated template literal/);
  });

  test("throws on an unterminated block comment", () => {
    assert.throws(() => stripComments("const s = 1; /* never closed"), /unterminated block comment/);
  });

  test("the thrown error message includes the sourceName option, for per-file debuggability", () => {
    assert.throws(
      () => stripComments('const s = "never closed', { sourceName: "lib/example.js" }),
      /unterminated string literal in lib\/example\.js/
    );
  });

  test("a misjudged division `/` that never finds a closing `/` on the same line falls back to plain division, and does NOT throw", () => {
    // Distinguishes the two different "the heuristic guessed wrong" outcomes:
    // an ambiguous bare `/` that turns out not to close as a regex on the
    // same line is safely reinterpreted as division (no throw) — only a
    // genuinely unterminated string/template/block comment is treated as a
    // hard parse error.
    assert.doesNotThrow(() => stripComments("const x = a / b;\nconst y = 2;"));
  });
});

// ── Postfix `++`/`--` leaves division context (review-flagged fast-follow) ──
//
// Before the fix, `+` and `-` fell through to the generic "every other
// punctuation" branch, which unconditionally marks "operand expected next".
// That's correct for a BINARY `+`/`-` or a PREFIX `++`/`--` (both await an
// operand), but wrong for a POSTFIX `++`/`--`: `x++` already produced a
// value (the pre-increment value of `x`), so a `/` right after it is
// division, not the start of a regex literal. With the bug, that `/` was
// misread as a regex-candidate, which greedily "closed" on the first `/` of
// a following `//` comment — leaving a lone `/` behind that never forms a
// second `//`, so the real comment survived stripping entirely.
describe("stripComments: postfix `++`/`--` leaves division context", () => {
  test("RED→GREEN: `x++ / y // comment` — comment is stripped, code (including the division `/`) is preserved", () => {
    const source = "let z = x++ / y; // trailing comment";
    const result = stripComments(source);
    assert.equal(result.includes("trailing comment"), false,
      "the real trailing // comment must be stripped, not swallowed into a fake regex nor left behind as an orphan comment");
    assert.ok(result.includes("let z = x++ / y;"),
      "the code, including the genuine division `/`, must be preserved verbatim — no code may ever be deleted");
  });

  test("`x-- / y /* c */` — postfix decrement, block comment is stripped", () => {
    const source = "let z = x-- / y; /* c */ let w = 1;";
    const result = stripComments(source);
    assert.equal(result.includes("/* c */") || result.includes(" c "), false,
      "the block comment body must be removed");
    assert.ok(result.includes("let z = x-- / y;"));
    assert.ok(result.includes("let w = 1;"));
  });

  test("`a.b++ / c // c2` — postfix increment on a member expression, comment is stripped", () => {
    const source = "let z = a.b++ / c; // c2";
    const result = stripComments(source);
    assert.equal(result.includes("c2"), false, "the trailing comment must be stripped");
    assert.ok(result.includes("let z = a.b++ / c;"));
  });

  test("control: prefix `++x / y // comment` still resolves `/` as division (correct because `x` itself is a value, independent of the `++` fix)", () => {
    // Not a case where `/` should be read as regex: even though `++x` is a
    // PREFIX increment (still awaiting its operand at the moment `++` is
    // scanned), the very next token is the identifier `x`, which — like any
    // identifier — marks "value produced" on its own via flushWord(). So the
    // `/` after `++x` is correctly division regardless of how `++` itself is
    // classified. This pins down that the postfix fix does not regress the
    // (already-correct) prefix case.
    const source = "let z = ++x / y; // trailing comment";
    const result = stripComments(source);
    assert.equal(result.includes("trailing comment"), false);
    assert.ok(result.includes("let z = ++x / y;"));
  });

  test("`x++ + ++y // comment` — postfix then binary `+` then prefix — comment stripped, code intact", () => {
    const source = "let z = x++ + ++y; // trailing comment";
    const result = stripComments(source);
    assert.equal(result.includes("trailing comment"), false);
    assert.ok(result.includes("let z = x++ + ++y;"));
  });
});
