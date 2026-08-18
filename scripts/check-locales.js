import { readFrontendSource } from "./shared/source-reader.js";

const appSource = await readFrontendSource();
const copyStart = appSource.indexOf("const copy = ");
const copyEnd = appSource.indexOf("\nfunction t()", copyStart);

if (copyStart === -1 || copyEnd === -1) {
  throw new Error("Could not locate the copy object in public/app.js.");
}

const copyLiteral = appSource.slice(copyStart + "const copy = ".length, copyEnd).trim().replace(/;$/, "");
const copy = Function(`"use strict"; return (${copyLiteral});`)();

function collectPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return collectPaths(item, next);
  });
}

function missingPaths(source, target) {
  return collectPaths(source)
    .filter(Boolean)
    .filter((path) => {
      return path.split(".").reduce((value, key) => value?.[key], target) === undefined;
    });
}

const missingInZh = missingPaths(copy.en, copy.zh);
const missingInEn = missingPaths(copy.zh, copy.en);

if (missingInZh.length || missingInEn.length) {
  console.error(JSON.stringify({ missingInZh, missingInEn }, null, 2));
  throw new Error("Locale copy keys are out of sync.");
}

const requiredPaths = [
  "chat.memory",
  "chat.harness",
  "chat.safety",
  "chat.pendingMemory",
  "chat.durationMs",
  "chat.fallbackUsed",
  "chat.noFallback",
  "chat.budgetOk",
  "chat.budgetExceeded",
  "chat.memorySuggestions",
  "chat.saveMemory",
  "chat.ignoreMemory",
  "chat.briefingTitle",
  "chat.briefingFlows",
  "chat.briefingTesting",
  "chat.briefingRisk",
  "chat.techDetails",
  "dashboard.guardrailHits",
  "dashboard.memorySaves",
  "dashboard.fallbackRuns",
  "dashboard.qualitySummary.title",
  "dashboard.qualitySummary.empty",
  "dashboard.qualitySummary.citation",
  "dashboard.qualitySummary.guardrail",
  "dashboard.qualitySummary.fallback",
  "dashboard.qualitySummary.feedback",
  "dashboard.groups.trust.title",
  "dashboard.groups.trust.desc",
  "dashboard.groups.safety.title",
  "dashboard.groups.safety.desc",
  "dashboard.groups.reliability.title",
  "dashboard.groups.reliability.desc",
  "dashboard.groups.usage.title",
  "dashboard.groups.usage.desc",
  "dashboard.methodology.title",
  "dashboard.methodology.intro",
  "dashboard.methodology.link"
];

for (const locale of ["en", "zh"]) {
  for (const path of requiredPaths) {
    const value = path.split(".").reduce((item, key) => item?.[key], copy[locale]);
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Missing required locale string: ${locale}.${path}`);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  locales: Object.keys(copy),
  checkedPaths: collectPaths(copy.en).length
}, null, 2));
