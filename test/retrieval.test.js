import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, expandQueryTerms, chunkFile, retrieveChunks } from "../lib/retrieval.js";

// Pure-function unit tests for lib/retrieval.js. Expected values below were
// captured by running the real functions first rather than guessed from
// reading the source.

describe("tokenize", () => {
  test("lower-cases, keeps path-like and CJK tokens, drops short stopwords", () => {
    const tokens = tokenize("How does the OrderStatus change for refund.js and 支付 model?");
    assert.deepEqual(tokens, ["how", "does", "orderstatus", "change", "refund.js", "支付", "model"]);
  });

  test("a string made only of stopwords tokenizes to an empty array", () => {
    assert.deepEqual(tokenize("the and for with from this that"), []);
  });
});

describe("expandQueryTerms", () => {
  test("adds related auth terms even when they weren't typed", () => {
    const terms = expandQueryTerms("How does login work with jwt?");
    for (const expected of ["auth", "user", "password"]) {
      assert.ok(terms.includes(expected), `expected terms to include "${expected}"`);
    }
  });

  test("matches expansion rules against Chinese phrasing", () => {
    const terms = expandQueryTerms("退款流程是怎样的");
    for (const expected of ["refund", "refunded", "refundservice"]) {
      assert.ok(terms.includes(expected), `expected terms to include "${expected}"`);
    }
  });

  test("returns only the tokenized terms when nothing matches an expansion rule", () => {
    const query = "完全不相关的问题 xyz123";
    assert.deepEqual(expandQueryTerms(query), tokenize(query));
  });
});

describe("chunkFile boundaries", () => {
  test("a short file (under the line/char thresholds) becomes a single chunk", () => {
    const chunks = chunkFile({ path: "src/small.js", content: "line1\nline2\nline3" });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].start_line, 1);
    assert.equal(chunks[0].end_line, 3);
    assert.equal(chunks[0].file_type, "js");
  });

  test("a 150-line file flushes every 70 lines, plus a final remainder chunk", () => {
    const content = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkFile({ path: "src/big.py", content });
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map((c) => [c.start_line, c.end_line]), [
      [1, 70],
      [71, 140],
      [141, 150]
    ]);
  });

  test("an empty file produces no chunks", () => {
    assert.deepEqual(chunkFile({ path: "src/empty.js", content: "" }), []);
  });
});

describe("retrieveChunks ranking", () => {
  function buildProject() {
    return {
      chunks: [
        ...chunkFile({
          path: "src/order.js",
          content: "function createOrder() { return processOrder(); }\nfunction refund() { return refundService(); }"
        }),
        ...chunkFile({ path: "src/unrelated.js", content: "function foo() { return bar(); }" })
      ]
    };
  }

  test("sorts matches by descending score, favoring the file with more matching terms", () => {
    const results = retrieveChunks(buildProject(), "function", 5);
    assert.equal(results.length, 2);
    assert.equal(results[0].file_path, "src/order.js");
    assert.equal(results[1].file_path, "src/unrelated.js");
    assert.ok(results[0].score > results[1].score);
  });

  test("respects the topK limit", () => {
    const results = retrieveChunks(buildProject(), "function", 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].file_path, "src/order.js");
  });

  test("returns no chunks when no terms match", () => {
    const results = retrieveChunks(buildProject(), "zzz_nonexistent_term_qqq", 5);
    assert.deepEqual(results, []);
  });
});
