// Pure request-body builder for repository import.
//
// This is deliberately split out of app.js so the decision logic ("given
// these already-extracted plain values, what body do we send to
// POST /api/import?") can be unit-tested from plain Node (see
// test/import-request.test.js) without touching the DOM or a browser. All the
// DOM-dependent parts -- reading #repoUrl's value, reading #zipFile's
// FileList, and converting a File to base64 via FileReader -- stay in
// importRepository() inside app.js, which calls this function with the
// already-read values.
//
// Precedence: sample beats everything else; an attached file (sent as
// zipBase64 + fileName) beats a typed GitHub URL; if neither a file nor a URL
// is present we still send { repoUrl } (possibly undefined/empty) so the
// server's existing IMPORT_SOURCE_REQUIRED validation continues to fire.
export function buildImportRequestBody({ sample = false, repoUrl, file, zipBase64 } = {}) {
  if (sample) return { sample: true };
  if (file) return { zipBase64, fileName: file.name };
  return { repoUrl };
}
