import { readFile } from "node:fs/promises";

const [serverSource, architectureDoc, readme] = await Promise.all([
  readFile("server.js", "utf8"),
  readFile("docs/AGENT_RUNTIME_ARCHITECTURE.md", "utf8"),
  readFile("README.md", "utf8")
]);

const requiredServerSnippets = [
  "function scanInputSafety",
  "const SAFETY_POLICY",
  "function safetyPolicySummary",
  "function matchesSafetyPolicy",
  "SAFETY_RISK_EXPLANATIONS",
  "function describeSafetyRisks",
  "risk_details: describeSafetyRisks(riskTypes)",
  "function scanImportSafety",
  "safetyReview",
  "import_prompt_injection",
  "import_sensitive_content",
  "risk_type: \"prompt_injection\"",
  "忽略.{0,20}(系统|指令|规则)",
  "(reveal|show|print|dump|leak).{0,40}(system|developer)",
  "泄露.{0,20}(系统|开发者).{0,10}(提示|提示词|指令)",
  "risk_type: \"secret_request\"",
  "泄露|密钥|令牌",
  "risk_type: \"tool_permission\"",
  "删除|写入|提交|推送|执行命令",
  "function scanRetrievedSafety",
  "retrieved_prompt_injection",
  "retrieved_sensitive_content",
  "SENSITIVE_VALUE_PATTERN",
  "password|credential|secret",
  "api[_-]?key|apikey|token|password|credential|secret",
  "function redactSensitiveText",
  "function redactSensitivePayload",
  "function redactSensitivePayloadWithReport",
  "function attachOutputRedactionReport",
  "SECRET_REDACTION",
  "payload = attachOutputRedactionReport(redacted.payload, redacted.redaction)",
  "output_redaction",
  "function scanOutputSafety",
  "const refs = collectCitationFiles(payload)",
  "function isSafeRelativePath",
  "raw.startsWith(\"/\")",
  "part === \"..\"",
  "risk_type: \"missing_citation\"",
  "risk_type: \"sensitive_output\"",
  "risk_type: \"overconfidence\"",
  "hasRequiredCitations",
  "does not clearly mark uncertainty",
  "function validateTraceToolUse",
  "tool_policy_violation",
  "safety_policy: safetyPolicySummary()"
];

const requiredDocSnippets = [
  "prompt injection",
  "secret requests",
  "write/tool escalation intent",
  "retrieved-context prompt injection",
  "retrieved sensitive content",
  "import-time `safetyReview`",
  "sensitive-looking values",
  "no-impact-citation overconfidence",
  "read-only registry",
  "safety policy",
  "red-team"
];

const missingServerSnippets = requiredServerSnippets.filter((snippet) => {
  return !serverSource.includes(snippet);
});

const combinedDocs = `${architectureDoc}\n${readme}`;
const missingDocSnippets = requiredDocSnippets.filter((snippet) => {
  return !combinedDocs.includes(snippet);
});

if (missingServerSnippets.length || missingDocSnippets.length) {
  console.error(JSON.stringify({
    missingServerSnippets,
    missingDocSnippets
  }, null, 2));
  throw new Error("Safety guardrail contract is incomplete.");
}

console.log(JSON.stringify({
  ok: true,
  serverSnippets: requiredServerSnippets.length,
  docSnippets: requiredDocSnippets.length
}, null, 2));
