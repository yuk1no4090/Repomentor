import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { listServerSourceFiles } from "./shared/source-reader.js";

const rootFiles = [
  "README.md",
  ...(await listServerSourceFiles()),
  "public/app.js",
  "public/styles.css"
];

const scriptFiles = (await readdir("scripts"))
  .filter((file) => file.endsWith(".js"))
  .map((file) => path.join("scripts", file).replaceAll("\\", "/"));

const docFiles = (await readdir("docs"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => path.join("docs", file).replaceAll("\\", "/"));

const files = [...rootFiles, ...docFiles, ...scriptFiles];
const patterns = [
  { name: "replacement character", pattern: /\uFFFD/g },
  { name: "UTF-8 mojibake quote", pattern: /\u00E2\u20AC|\u9225/g },
  { name: "UTF-8 mojibake accent", pattern: /\u00C3.|\u00C2./g },
  { name: "emoji mojibake", pattern: /\u9983/g },
  { name: "question-mark mojibake run", pattern: /\?{4,}/g },
  { name: "private-use mojibake", pattern: /[\uE000-\uF8FF]/g },
  { name: "CJK mojibake sentinel", pattern: /[\u942E\u7035\u93AC\u9286\u9225\u9983\u923F]/g }
];

const findings = [];

for (const file of files) {
  const content = await readFile(file, "utf8");
  if (content.charCodeAt(0) === 0xFEFF) {
    findings.push({
      file,
      line: 1,
      type: "UTF-8 BOM",
      text: "File starts with a UTF-8 byte-order mark."
    });
  }
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { name, pattern } of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.push({
          file,
          line: index + 1,
          type: name,
          text: line.trim().slice(0, 160)
        });
      }
    }
  });
}

if (findings.length) {
  console.error(JSON.stringify({ findings }, null, 2));
  throw new Error("Text quality check failed.");
}

console.log(JSON.stringify({
  ok: true,
  checkedFiles: files.length,
  patterns: patterns.map((item) => item.name)
}, null, 2));
