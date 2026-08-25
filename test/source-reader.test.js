import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { stripComments } from "../scripts/shared/source-reader.js";

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
