import type { CodeCatConfig } from "./types.js";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function matchesPattern(path: string, pattern: string): boolean {
  const normalized = normalizePath(path);
  const name = basename(normalized);

  if (pattern === ".env*") {
    return name.startsWith(".env");
  }
  if (pattern === "**/*.pem") {
    return name.endsWith(".pem");
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }
  if (pattern.includes("*")) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", ".*")
      .replaceAll("*", "[^/]*");
    return new RegExp(`^${escaped}$`).test(normalized);
  }
  return normalized === pattern;
}

export function shouldIncludeFile(path: string, config: CodeCatConfig): boolean {
  return !config.excludeGlobs.some((pattern) => matchesPattern(path, pattern));
}

export function truncateText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n\n[Code Cat truncated this context to stay within configured limits.]`;
}

