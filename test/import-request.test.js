import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildImportRequestBody } from "../public/import-request.js";

// Regression coverage for a real P0 production bug: importRepository() (see
// public/app.js) used to read #repoUrl's value and #zipFile's selected file
// only *after* several render() calls had already replaced #app's entire
// innerHTML (as part of a fake progress animation) -- which destroys and
// recreates every input node, including those two. By the time the DOM was
// finally queried, the user's typed URL / selected file were already gone, so
// every manual import (URL or ZIP) silently sent an empty body and failed
// with IMPORT_SOURCE_REQUIRED, even though the user had filled the form
// correctly. Only "Use Sample Repo" worked, because it never needed to read
// either field.
//
// The fix in app.js moves the DOM reads to the very top of importRepository(),
// before any render() call, and threads the already-read values through to
// this pure function to decide the actual request body. This suite cannot
// exercise the DOM-timing half of the bug (that requires a real browser), but
// it locks down the *decision logic* -- given already-extracted values, what
// body gets sent -- so a future regression that, say, swaps the sample/file/
// repoUrl precedence, or forgets to include fileName, is caught here without
// needing jsdom or any new dependency.

describe("buildImportRequestBody", () => {
  test("sample=true ignores repoUrl/file/zipBase64 and sends only { sample: true }", () => {
    const body = buildImportRequestBody({
      sample: true,
      repoUrl: "https://github.com/owner/repo",
      file: { name: "repo.zip" },
      zipBase64: "ZmFrZS16aXAtYnl0ZXM="
    });
    assert.deepEqual(body, { sample: true });
  });

  test("repoUrl alone (no file) builds a { repoUrl } body", () => {
    const body = buildImportRequestBody({
      sample: false,
      repoUrl: "https://github.com/owner/repo",
      file: undefined,
      zipBase64: undefined
    });
    assert.deepEqual(body, { repoUrl: "https://github.com/owner/repo" });
  });

  test("a selected file (with its base64 already converted) builds a { zipBase64, fileName } body and ignores any repoUrl", () => {
    const mockZipBase64 = "UEsDBAoAAAAAAI9example=="; // stand-in for a real FileReader result
    const body = buildImportRequestBody({
      sample: false,
      repoUrl: "https://github.com/should/be-ignored",
      file: { name: "my-repo.zip" },
      zipBase64: mockZipBase64
    });
    assert.deepEqual(body, { zipBase64: mockZipBase64, fileName: "my-repo.zip" });
  });

  test("neither a file nor a repoUrl still builds a { repoUrl } body (possibly empty/undefined), matching the server's IMPORT_SOURCE_REQUIRED validation path", () => {
    const body = buildImportRequestBody({ sample: false, repoUrl: undefined, file: undefined, zipBase64: undefined });
    assert.deepEqual(body, { repoUrl: undefined });

    const bodyWithBlankUrl = buildImportRequestBody({ sample: false, repoUrl: "", file: undefined, zipBase64: undefined });
    assert.deepEqual(bodyWithBlankUrl, { repoUrl: "" });
  });

  test("defaults to sample=false when called with no arguments at all", () => {
    const body = buildImportRequestBody();
    assert.deepEqual(body, { repoUrl: undefined });
  });
});
