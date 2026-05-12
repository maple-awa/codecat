import type { CodeCatConfig, ProxyConfig, ReviewMode } from "./types.js";

const DEFAULT_EXCLUDES = [
  ".env*",
  "**/*.pem",
  "node_modules/**",
  "lib/**",
  "dist/**",
];

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseReviewMode(value: string | undefined): ReviewMode {
  if (value === "standard" || value === "deep") {
    return value;
  }
  return "incremental";
}

function parseProxyConfig(env: NodeJS.ProcessEnv): ProxyConfig {
  const codecatProxy = firstValue(env.CODECAT_PROXY_URL);
  const allProxy = firstValue(env.all_proxy, env.ALL_PROXY);

  return {
    httpProxy: firstValue(env.CODECAT_HTTP_PROXY, codecatProxy, env.http_proxy, env.HTTP_PROXY, allProxy),
    httpsProxy: firstValue(
      env.CODECAT_HTTPS_PROXY,
      codecatProxy,
      env.https_proxy,
      env.HTTPS_PROXY,
      allProxy,
    ),
    noProxy: firstValue(env.CODECAT_NO_PROXY, env.no_proxy, env.NO_PROXY),
  };
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CodeCatConfig {
  return {
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL || "gpt-5.5",
    openaiBaseURL: firstValue(env.OPENAI_BASE_URL),
    proxy: parseProxyConfig(env),
    timezone: env.CODECAT_TIMEZONE || "Asia/Shanghai",
    dailyCron: env.CODECAT_DAILY_CRON || "0 3 * * *",
    reviewMode: parseReviewMode(env.CODECAT_REVIEW_MODE),
    autoFixEnabled: parseBoolean(env.CODECAT_AUTO_FIX_ENABLED, true),
    verifyMode: "lightweight",
    verifyCommands: parseList(env.CODECAT_VERIFY_COMMANDS, [
      "npm test -- --run",
      "npm run build",
    ]),
    excludeGlobs: parseList(env.CODECAT_EXCLUDE_GLOBS, DEFAULT_EXCLUDES),
    maxFiles: parseNumber(env.CODECAT_MAX_FILES, 30),
    maxBytes: parseNumber(env.CODECAT_MAX_BYTES, 120_000),
    maxFixFiles: parseNumber(env.CODECAT_MAX_FIX_FILES, 5),
    maxFixBytes: parseNumber(env.CODECAT_MAX_FIX_BYTES, 80_000),
    disableScheduler:
      parseBoolean(env.CODECAT_DISABLE_SCHEDULER, false) ||
      env.NODE_ENV === "test" ||
      env.VITEST === "true",
  };
}
