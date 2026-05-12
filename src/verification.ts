import { shouldIncludeFile } from "./filters.js";
import type { CodeCatConfig, FixResult } from "./types.js";

export interface VerificationResult {
  ok: boolean;
  details: string;
}

const GENERATED_PREFIXES = ["node_modules/", "lib/", "dist/", "build/", "coverage/"];
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"']{8,}["']/i,
];

export async function verifyFix(
  config: CodeCatConfig,
  fix: FixResult,
): Promise<VerificationResult> {
  const problems: string[] = [];

  if (fix.changes.length === 0) {
    problems.push("No file changes were proposed.");
  }
  if (fix.changes.length > config.maxFixFiles) {
    problems.push(`Too many files changed: ${fix.changes.length}/${config.maxFixFiles}.`);
  }

  for (const change of fix.changes) {
    problems.push(...validateChange(config, change.path, change.content));
  }

  if (problems.length > 0) {
    return {
      ok: false,
      details: [
        "Lightweight verification failed; Code Cat did not create a fix PR.",
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    };
  }

  return {
    ok: true,
    details: [
      "Lightweight verification passed.",
      "Checked file paths, excluded globs, file count, file size, binary content, base64-like blobs, generated directories, and common secret patterns.",
      "Tests and build commands were not run in this GitHub App runtime.",
    ].join("\n"),
  };
}

function validateChange(config: CodeCatConfig, path: string, content: string): string[] {
  const problems: string[] = [];
  const normalized = path.replaceAll("\\", "/");
  const byteLength = Buffer.byteLength(content, "utf8");

  if (normalized.startsWith("/") || normalized.includes("../") || normalized.includes("..\\")) {
    problems.push(`Unsafe path traversal or absolute path: ${path}.`);
  }
  if (!shouldIncludeFile(normalized, config)) {
    problems.push(`Path is excluded by CODECAT_EXCLUDE_GLOBS: ${path}.`);
  }
  if (GENERATED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    problems.push(`Generated or dependency output is not safe to edit automatically: ${path}.`);
  }
  if (byteLength === 0) {
    problems.push(`Empty replacement content is not allowed: ${path}.`);
  }
  if (byteLength > config.maxFixBytes) {
    problems.push(`Replacement content is too large: ${path} is ${byteLength}/${config.maxFixBytes} bytes.`);
  }
  if (content.includes("\0")) {
    problems.push(`Binary-looking content is not allowed: ${path}.`);
  }
  if (looksLikeBase64Blob(content)) {
    problems.push(`Base64-like blob content is not allowed: ${path}.`);
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    problems.push(`Potential secret material detected in generated content: ${path}.`);
  }

  return problems;
}

function looksLikeBase64Blob(content: string): boolean {
  const compact = content.trim().replace(/\s+/g, "");
  if (compact.length < 160 || compact.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

