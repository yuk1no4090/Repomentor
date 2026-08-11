import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import {
  ALLOWED_EXTENSIONS, IGNORE_DIRS, MAX_ZIP_ENTRIES, MAX_ZIP_BYTES,
  MAX_IMPORTED_FILES, MAX_IMPORTED_FILE_BYTES, MAX_IMPORTED_TOTAL_BYTES, GITHUB_IMPORT_TIMEOUT_MS,
  AUTH_REQUIRED, apiError
} from "./config.js";
import { chunkFile } from "./retrieval.js";
import { describeSafetyRisks, SENSITIVE_VALUE_PATTERN } from "./safety.js";

function normalizeRepoPath(filePath) {
  return String(filePath || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function isSafeRelativePath(filePath) {
  const raw = String(filePath || "").replaceAll("\\", "/");
  if (!raw.trim() || raw.includes("\u0000")) return false;
  if (raw.startsWith("/") || /^[a-z]:\//i.test(raw)) return false;
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || /[\x00-\x1f\x7f]/.test(part))) return false;
  return normalizeRepoPath(raw).length > 0;
}

function shouldIncludeFile(filePath) {
  if (!isSafeRelativePath(filePath)) return false;
  const normalized = normalizeRepoPath(filePath);
  const parts = normalized.split("/");
  if (parts.some((part) => IGNORE_DIRS.has(part))) return false;
  return ALLOWED_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function stripArchiveRoot(filePath) {
  if (!isSafeRelativePath(filePath)) return "";
  const parts = normalizeRepoPath(filePath).split("/");
  if (parts.length > 1 && /^[^/]+-[a-f0-9]{6,}$|^[^/]+-(main|master|trunk|develop)$/i.test(parts[0])) {
    return parts.slice(1).join("/");
  }
  return normalizeRepoPath(filePath);
}

function parseZip(buffer) {
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw apiError("Invalid ZIP: end of central directory not found.", "IMPORT_INVALID_ZIP");

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries > MAX_ZIP_ENTRIES) throw apiError("ZIP has too many entries for the MVP importer.", "IMPORT_TOO_LARGE", 413);
  if (centralDirOffset >= buffer.length) throw apiError("Invalid ZIP: central directory offset is out of range.", "IMPORT_INVALID_ZIP");

  const files = [];
  let totalImportedBytes = 0;
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > buffer.length) throw apiError("Invalid ZIP: central directory entry is truncated.", "IMPORT_INVALID_ZIP");
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    if (offset + 46 + fileNameLength + extraLength + commentLength > buffer.length) {
      throw apiError("Invalid ZIP: central directory entry is out of range.", "IMPORT_INVALID_ZIP");
    }
    const fileName = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    offset += 46 + fileNameLength + extraLength + commentLength;

    if (fileName.endsWith("/")) continue;
    const cleanPath = stripArchiveRoot(fileName);
    if (!shouldIncludeFile(cleanPath)) continue;
    if (compressedSize > 800_000) continue;

    if (localHeaderOffset + 30 > buffer.length) throw apiError("Invalid ZIP: local file header is out of range.", "IMPORT_INVALID_ZIP");
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw apiError("Invalid ZIP: compressed file data is out of range.", "IMPORT_INVALID_ZIP");
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);

    let contentBuffer;
    if (compressionMethod === 0) {
      contentBuffer = compressed;
    } else if (compressionMethod === 8) {
      // Guard against ZIP bombs: cap decompressed output before it fills memory.
      // maxOutputLength throws RangeError when the decompressed stream exceeds the limit.
      try {
        contentBuffer = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_IMPORTED_FILE_BYTES + 1 });
      } catch (inflateError) {
        if (inflateError instanceof RangeError) continue; // decompressed too large — skip
        throw inflateError;
      }
    } else {
      continue;
    }

    if (contentBuffer.length > MAX_IMPORTED_FILE_BYTES) continue;
    totalImportedBytes += contentBuffer.length;
    if (totalImportedBytes > MAX_IMPORTED_TOTAL_BYTES) {
      throw apiError("Imported files are too large for the MVP analyzer.", "IMPORT_TOO_LARGE", 413);
    }
    const content = contentBuffer.toString("utf8").replace(/\u0000/g, "");
    if (content.trim()) {
      files.push({ path: cleanPath, content });
      if (files.length > MAX_IMPORTED_FILES) {
        throw apiError("Repository contains too many supported files for the MVP analyzer.", "IMPORT_TOO_LARGE", 413);
      }
    }
  }

  return files;
}

async function fetchGithubZip(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!match) throw apiError("Enter a valid GitHub repository URL.", "INVALID_GITHUB_REPO");
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");

  const metaResponse = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { "user-agent": "ai-developer-onboarding-copilot" }
  });
  if (!metaResponse.ok) throw apiError(`GitHub repository lookup failed: ${metaResponse.status}`, "GITHUB_IMPORT_FAILED", 502);
  const meta = await metaResponse.json();
  const branch = meta.default_branch || "main";
  const zipResponse = await fetchWithTimeout(`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`, {
    headers: { "user-agent": "ai-developer-onboarding-copilot" }
  });
  if (!zipResponse.ok) throw apiError(`GitHub ZIP download failed: ${zipResponse.status}`, "GITHUB_IMPORT_FAILED", 502);
  const buffer = await readResponseBuffer(zipResponse, MAX_ZIP_BYTES);
  return {
    files: parseZip(buffer),
    repoName: repo,
    source: `github:${owner}/${repo}`
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_IMPORT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw apiError("GitHub import timed out.", "GITHUB_IMPORT_TIMEOUT", 504);
    }
    throw apiError(`GitHub import failed: ${error.message || "network error"}`, "GITHUB_IMPORT_FAILED", 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBuffer(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw apiError("GitHub ZIP is too large for the MVP importer.", "IMPORT_TOO_LARGE", 413);
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw apiError("GitHub ZIP is too large for the MVP importer.", "IMPORT_TOO_LARGE", 413);
    }
    return buffer;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw apiError("GitHub ZIP is too large for the MVP importer.", "IMPORT_TOO_LARGE", 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function inferTechStack(files) {
  const names = files.map((file) => file.path.toLowerCase());
  const content = files.map((file) => `${file.path}\n${file.content.slice(0, 4000)}`).join("\n").toLowerCase();
  const stack = [];
  if (names.some((name) => name.endsWith("package.json")) || names.some((name) => /\.(ts|tsx|js)$/.test(name))) stack.push("Node.js / JavaScript");
  if (names.some((name) => name.endsWith(".ts") || name.endsWith(".tsx")) || content.includes("typescript")) stack.push("TypeScript");
  if (names.some((name) => name.endsWith(".tsx")) || content.includes("react")) stack.push("React");
  if (content.includes("next")) stack.push("Next.js");
  if (names.some((name) => name.endsWith(".py")) || content.includes("fastapi") || content.includes("django")) stack.push("Python");
  if (content.includes("fastapi")) stack.push("FastAPI");
  if (names.some((name) => name.endsWith(".java")) || content.includes("springframework")) stack.push("Java");
  if (content.includes("express")) stack.push("Express");
  if (content.includes("tailwind")) stack.push("Tailwind CSS");
  if (content.includes("prisma")) stack.push("Prisma");
  if (content.includes("postgres") || content.includes("pgvector")) stack.push("PostgreSQL");
  return [...new Set(stack)].slice(0, 8);
}

function buildTree(files) {
  const root = {};
  files.forEach((file) => {
    const parts = file.path.split("/");
    let node = root;
    parts.forEach((part, index) => {
      node[part] ||= index === parts.length - 1 ? null : {};
      if (node[part]) node = node[part];
    });
  });

  function render(node, depth = 0) {
    return Object.keys(node)
      .sort((a, b) => {
        const aDir = node[a] !== null;
        const bDir = node[b] !== null;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b);
      })
      .slice(0, depth === 0 ? 16 : 12)
      .flatMap((key) => {
        const prefix = `${"  ".repeat(depth)}- ${key}`;
        if (node[key] === null || depth >= 2) return [prefix];
        return [prefix, ...render(node[key], depth + 1)];
      });
  }

  return render(root).join("\n");
}

function detectBusinessFeatures(files) {
  const catalog = [
    ["Authentication", ["auth", "login", "jwt", "session", "password"]],
    ["Users", ["user", "profile", "account"]],
    ["Orders", ["order", "checkout"]],
    ["Payments", ["payment", "charge", "paid", "gateway"]],
    ["Refunds", ["refund", "refunded"]],
    ["Coupons", ["coupon", "discount", "promo"]],
    ["Products", ["product", "sku", "catalog"]],
    ["Admin", ["admin", "backoffice"]],
    ["Testing", ["test", "spec", "scenario"]]
  ];
  const haystack = files.map((file) => `${file.path}\n${file.content.slice(0, 2500)}`).join("\n").toLowerCase();
  return catalog
    .filter(([, terms]) => terms.some((term) => haystack.includes(term)))
    .map(([name]) => name);
}

function summarizeReadme(files) {
  const readme = files.find((file) => /(^|\/)readme\.md$/i.test(file.path));
  if (!readme) return "No README.md was found in the imported repository.";
  const text = readme.content
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  return text.slice(0, 700) || "README.md exists but does not contain enough readable text for a summary.";
}

function recommendFiles(files) {
  const scored = files.map((file) => {
    const lower = file.path.toLowerCase();
    let score = 0;
    if (/readme\.md$/.test(lower)) score += 100;
    if (lower.includes("route") || lower.includes("controller")) score += 30;
    if (lower.includes("service")) score += 25;
    if (lower.includes("model") || lower.includes("schema")) score += 20;
    if (lower.includes("order") || lower.includes("auth") || lower.includes("payment")) score += 12;
    if (lower.includes("test") || lower.includes("spec")) score += 8;
    return { path: file.path, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter((item) => item.score > 0)
    .slice(0, 8)
    .map((item) => item.path);
}

function scanImportSafety(files) {
  const promptInjectionFiles = files
    .filter((file) => /(ignore previous|disregard (all )?(previous|system)|reveal the (system|developer) prompt|show the system prompt|泄露|忽略.{0,20}(系统|指令|规则))/i.test(file.content))
    .map((file) => file.path);
  const sensitiveFiles = files
    .filter((file) => SENSITIVE_VALUE_PATTERN.test(file.content))
    .map((file) => file.path);
  const uniquePromptInjectionFiles = [...new Set(promptInjectionFiles)].sort();
  const uniqueSensitiveFiles = [...new Set(sensitiveFiles)].sort();
  const riskTypes = [
    uniquePromptInjectionFiles.length ? "import_prompt_injection" : null,
    uniqueSensitiveFiles.length ? "import_sensitive_content" : null
  ].filter(Boolean);
  return {
    status: riskTypes.length ? "needs_review" : "passed",
    risk_types: riskTypes,
    risk_details: describeSafetyRisks(riskTypes),
    prompt_injection_files: uniquePromptInjectionFiles,
    sensitive_files: uniqueSensitiveFiles,
    prompt_injection_file_count: uniquePromptInjectionFiles.length,
    sensitive_file_count: uniqueSensitiveFiles.length
  };
}

function createProject({ name, source, files, ownerId = null }) {
  const limitedFiles = files
    .filter((file) => shouldIncludeFile(file.path))
    .slice(0, MAX_IMPORTED_FILES)
    .map((file) => ({ path: normalizeRepoPath(file.path), content: file.content.slice(0, MAX_IMPORTED_FILE_BYTES) }));

  if (limitedFiles.length === 0) {
    throw apiError("No supported source or documentation files were found.", "NO_SUPPORTED_FILES");
  }

  const chunks = limitedFiles.flatMap(chunkFile);
  const techStack = inferTechStack(limitedFiles);
  const businessFeatures = detectBusinessFeatures(limitedFiles);
  const recommendedFiles = recommendFiles(limitedFiles);
  const safetyReview = scanImportSafety(limitedFiles);
  const project = {
    id: crypto.randomUUID(),
    name,
    source,
    ownerId,
    createdAt: new Date().toISOString(),
    fileCount: limitedFiles.length,
    chunkCount: chunks.length,
    files: limitedFiles.map((file) => ({
      path: file.path,
      type: path.extname(file.path).slice(1) || "txt",
      size: Buffer.byteLength(file.content)
    })),
    chunks,
    summary: {
      techStack,
      directoryTree: buildTree(limitedFiles),
      coreModules: businessFeatures.length ? businessFeatures : ["Documentation", "Source code"],
      businessFeatures,
      readmeSummary: summarizeReadme(limitedFiles),
      recommendedFiles,
      safetyReview,
      overview: buildOverview(name, techStack, businessFeatures, recommendedFiles)
    }
  };
  return project;
}

function buildOverview(name, techStack, businessFeatures, recommendedFiles) {
  const stack = techStack.length ? techStack.join(", ") : "the imported files";
  const modules = businessFeatures.length ? businessFeatures.join(", ") : "the visible code and documentation";
  const reads = recommendedFiles.slice(0, 4).join(", ");
  return `${name} appears to use ${stack}. The main visible domains are ${modules}. Recommended first reads: ${reads || "README and top-level source files"}.`;
}

function findProject(store, projectId, userId = null) {
  const visibleTo = (item) => {
    if (!AUTH_REQUIRED || !userId) return true;
    return !item.ownerId || item.ownerId === userId;
  };
  if (projectId) {
    const project = store.projects.find((item) => item.id === projectId && visibleTo(item));
    if (!project) throw apiError("Project not found.", "PROJECT_NOT_FOUND", 404);
    return project;
  }
  const project = store.projects.filter(visibleTo).at(-1);
  if (!project) throw apiError("Import a repository before using this feature.", "PROJECT_REQUIRED");
  return project;
}

export {
  normalizeRepoPath,
  isSafeRelativePath,
  shouldIncludeFile,
  stripArchiveRoot,
  parseZip,
  fetchGithubZip,
  fetchWithTimeout,
  readResponseBuffer,
  inferTechStack,
  buildTree,
  detectBusinessFeatures,
  summarizeReadme,
  recommendFiles,
  scanImportSafety,
  createProject,
  buildOverview,
  findProject
};
