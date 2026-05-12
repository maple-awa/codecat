import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseCodeCatCommand } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import myProbotApp from "../src/index.js";
import { verifyFix } from "../src/verification.js";
import payload from "./fixtures/issues.opened.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(
  path.join(__dirname, "fixtures/mock-cert.pem"),
  "utf-8",
);

function createProbot(): Probot {
  const probot = new Probot({
    appId: 123,
    privateKey,
    Octokit: ProbotOctokit.defaults((instanceOptions: {}) => ({
      ...instanceOptions,
      retry: { enabled: false },
      throttle: { enabled: false },
    })),
  });
  probot.load(myProbotApp);
  return probot;
}

function mockInstallationToken(permissions: Record<string, string> = {}): nock.Scope {
  return nock("https://api.github.com")
    .post("/app/installations/2/access_tokens")
    .reply(200, {
      token: "test",
      permissions,
    });
}

function mockOpenAI(output: object): nock.Scope {
  return nock("https://api.openai.com")
    .post("/v1/responses", (body: { model?: string; text?: unknown }) => {
      expect(body.model).toBe("gpt-5.5");
      expect(body.text).toBeTruthy();
      return true;
    })
    .reply(200, {
      id: "resp_test",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          id: "msg_test",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(output),
            },
          ],
        },
      ],
    });
}

function reviewOutput() {
  return {
    summary: "The change is small, but it leaves noisy logging.",
    riskLevel: "low",
    findings: [
      {
        severity: "low",
        title: "Debug logging left in entrypoint",
        file: "src/index.ts",
        line: null,
        description: "The new console output may pollute production logs.",
        recommendation: "Remove or gate the log statement.",
        fixable: true,
      },
    ],
    shouldOpenIssue: false,
    issueTitle: null,
    issueBody: null,
  };
}

function fixOutput(path = "src/index.ts", content = "export default function app() {}\n") {
  return {
    canFix: true,
    confidence: "high",
    title: "Remove debug log",
    body: "This PR removes an unnecessary debug log.",
    changes: [
      {
        path,
        content,
        reason: "Remove debug log",
      },
    ],
    notes: [],
  };
}

function prPayload(action = "opened") {
  return {
    action,
    number: 2,
    pull_request: {
      number: 2,
      title: "Refactor startup",
      head: { ref: "feature/startup", sha: "head-sha" },
      base: { ref: "main" },
      user: { login: "hiimbex" },
    },
    repository: {
      name: "testing-things",
      owner: { login: "hiimbex" },
    },
    installation: { id: 2 },
    sender: { login: "hiimbex", type: "User" },
  };
}

function issueCommentPayload(body: string, isPullRequest = true) {
  return {
    action: "created",
    issue: {
      number: 2,
      title: "Refactor startup",
      body: "",
      pull_request: isPullRequest ? { url: "https://api.github.com/repos/hiimbex/testing-things/pulls/2" } : undefined,
      user: { login: "hiimbex" },
    },
    comment: {
      id: 99,
      body,
      user: { login: "hiimbex" },
    },
    repository: {
      name: "testing-things",
      owner: { login: "hiimbex" },
    },
    installation: { id: 2 },
    sender: { login: "hiimbex", type: "User" },
  };
}

function mockPullContext(scope: nock.Scope): nock.Scope {
  return scope
    .get("/repos/hiimbex/testing-things/pulls/2")
    .reply(200, {
      number: 2,
      title: "Refactor startup",
      head: { ref: "feature/startup", sha: "head-sha" },
      base: { ref: "main" },
    })
    .get("/repos/hiimbex/testing-things/pulls/2")
    .reply(200, "diff --git a/src/index.ts b/src/index.ts\n+console.log('x')\n")
    .get("/repos/hiimbex/testing-things/pulls/2/files")
    .query(true)
    .reply(200, [
      {
        filename: "src/index.ts",
        status: "modified",
        patch: "+console.log('x')",
      },
    ]);
}

describe("Code Cat commands", () => {
  test("parses the supported command set", () => {
    for (const command of ["help", "review", "deep", "fix", "explain", "status", "ignore", "config"]) {
      expect(parseCodeCatCommand(`/codecat ${command}`)?.command).toBe(command);
    }
    expect(parseCodeCatCommand("hello")).toBeUndefined();
    expect(parseCodeCatCommand("/codecat unknown")?.command).toBe("help");
  });
});

describe("Code Cat config", () => {
  test("loads optional OpenAI base URL", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: " https://openai.example.com/v1 ",
    });

    expect(config.openaiBaseURL).toBe("https://openai.example.com/v1");
  });

  test("uses CODECAT_PROXY_URL for GitHub and AI API outbound traffic", () => {
    const config = loadConfig({
      CODECAT_PROXY_URL: " http://user:pass@127.0.0.1:7890 ",
      CODECAT_NO_PROXY: "localhost,127.0.0.1",
    });

    expect(config.proxy).toStrictEqual({
      httpProxy: "http://user:pass@127.0.0.1:7890",
      httpsProxy: "http://user:pass@127.0.0.1:7890",
      noProxy: "localhost,127.0.0.1",
    });
  });

  test("honors standard proxy environment variables", () => {
    const config = loadConfig({
      HTTP_PROXY: "http://proxy.local:8080",
      HTTPS_PROXY: "http://secure-proxy.local:8443",
      NO_PROXY: "github.internal",
    });

    expect(config.proxy).toStrictEqual({
      httpProxy: "http://proxy.local:8080",
      httpsProxy: "http://secure-proxy.local:8443",
      noProxy: "github.internal",
    });
  });
});

describe("lightweight verification", () => {
  const config = loadConfig({
    CODECAT_VERIFY_COMMANDS: "",
    CODECAT_EXCLUDE_GLOBS: ".env*,**/*.pem,node_modules/**,lib/**,dist/**",
    CODECAT_MAX_FIX_FILES: "2",
    CODECAT_MAX_FIX_BYTES: "100",
  });

  test("accepts small text changes", async () => {
    await expect(verifyFix(config, fixOutput())).resolves.toMatchObject({ ok: true });
  });

  test("rejects excluded files and likely secrets", async () => {
    const result = await verifyFix(config, {
      ...fixOutput(".env", "OPENAI_API_KEY='sk-thislookslikeasecret1234567890'"),
    });

    expect(result.ok).toBe(false);
    expect(result.details).toContain("excluded");
    expect(result.details).toContain("Potential secret");
  });
});

describe("Code Cat Probot app", () => {
  beforeEach(() => {
    nock.disableNetConnect();
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_MODEL = "gpt-5.5";
    process.env.CODECAT_DISABLE_SCHEDULER = "true";
    process.env.CODECAT_VERIFY_COMMANDS = "";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.CODECAT_DISABLE_SCHEDULER;
    delete process.env.CODECAT_VERIFY_COMMANDS;
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test("creates an AI issue reply when an issue is opened", async () => {
    const probot = createProbot();
    const tokenMock = mockInstallationToken({ issues: "write" });
    const openaiMock = mockOpenAI({
      body: "喵，我看到了这个启动崩溃问题。请补充 Node 版本和完整错误堆栈。",
      needsClarification: true,
    });
    const commentMock = nock("https://api.github.com")
      .post("/repos/hiimbex/testing-things/issues/1/comments", (body: { body?: string }) => {
        expect(body.body).toContain("启动崩溃");
        return true;
      })
      .reply(200);

    await probot.receive({ name: "issues", payload });

    expect(tokenMock.pendingMocks()).toStrictEqual([]);
    expect(openaiMock.pendingMocks()).toStrictEqual([]);
    expect(commentMock.pendingMocks()).toStrictEqual([]);
  });

  test("reviews a pull request and creates a marked review comment", async () => {
    const probot = createProbot();
    const tokenMock = mockInstallationToken({ issues: "write", pull_requests: "write" });
    const githubMock = nock("https://api.github.com")
      .get("/repos/hiimbex/testing-things/issues/2/comments")
      .query(true)
      .reply(200, [])
      .get("/repos/hiimbex/testing-things/pulls/2")
      .reply(200, "diff --git a/src/index.ts b/src/index.ts\n+console.log('x')\n")
      .get("/repos/hiimbex/testing-things/pulls/2/files")
      .query(true)
      .reply(200, [
        {
          filename: "src/index.ts",
          status: "modified",
          patch: "+console.log('x')",
        },
      ])
      .get("/repos/hiimbex/testing-things/issues/2/comments")
      .query(true)
      .reply(200, [])
      .post("/repos/hiimbex/testing-things/issues/2/comments", (body: { body?: string }) => {
        expect(body.body).toContain("<!-- codecat:review -->");
        expect(body.body).toContain("Code Cat review");
        return true;
      })
      .reply(200);
    const openaiMock = mockOpenAI(reviewOutput());

    await probot.receive({ name: "pull_request", payload: prPayload() });

    expect(tokenMock.pendingMocks()).toStrictEqual([]);
    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(openaiMock.pendingMocks()).toStrictEqual([]);
  });

  test("skips an ignored pull request synchronize event", async () => {
    const probot = createProbot();
    const tokenMock = mockInstallationToken({ issues: "write", pull_requests: "write" });
    const githubMock = nock("https://api.github.com")
      .get("/repos/hiimbex/testing-things/issues/2/comments")
      .query(true)
      .reply(200, [{ id: 1, body: "<!-- codecat:ignore -->" }]);

    await probot.receive({ name: "pull_request", payload: prPayload("synchronize") });

    expect(tokenMock.pendingMocks()).toStrictEqual([]);
    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test("reruns review from /codecat review", async () => {
    const probot = createProbot();
    const tokenMock = mockInstallationToken({ issues: "write", pull_requests: "write" });
    const githubMock = mockPullContext(nock("https://api.github.com"))
      .get("/repos/hiimbex/testing-things/issues/2/comments")
      .query(true)
      .reply(200, [])
      .post("/repos/hiimbex/testing-things/issues/2/comments", (body: { body?: string }) => {
        expect(body.body).toContain("<!-- codecat:review -->");
        return true;
      })
      .reply(200);
    const openaiMock = mockOpenAI(reviewOutput());

    await probot.receive({
      name: "issue_comment",
      payload: issueCommentPayload("/codecat review"),
    });

    expect(tokenMock.pendingMocks()).toStrictEqual([]);
    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(openaiMock.pendingMocks()).toStrictEqual([]);
  });

  test("writes ignore marker from /codecat ignore", async () => {
    const probot = createProbot();
    const tokenMock = mockInstallationToken({ issues: "write" });
    const githubMock = nock("https://api.github.com")
      .get("/repos/hiimbex/testing-things/issues/2/comments")
      .query(true)
      .reply(200, [])
      .post("/repos/hiimbex/testing-things/issues/2/comments", (body: { body?: string }) => {
        expect(body.body).toContain("<!-- codecat:ignore -->");
        return true;
      })
      .reply(200);

    await probot.receive({
      name: "issue_comment",
      payload: issueCommentPayload("/codecat ignore"),
    });

    expect(tokenMock.pendingMocks()).toStrictEqual([]);
    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test("shows status from /codecat status", async () => {
    const probot = createProbot();
    const tokenMock = mockInstallationToken({ issues: "write" });
    const githubMock = nock("https://api.github.com")
      .get("/repos/hiimbex/testing-things/issues/2/comments")
      .query(true)
      .reply(200, [])
      .post("/repos/hiimbex/testing-things/issues/2/comments", (body: { body?: string }) => {
        expect(body.body).toContain("<!-- codecat:status -->");
        expect(body.body).toContain("Code Cat status");
        return true;
      })
      .reply(200);

    await probot.receive({
      name: "issue_comment",
      payload: issueCommentPayload("/codecat status"),
    });

    expect(tokenMock.pendingMocks()).toStrictEqual([]);
    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test("comments instead of opening a PR when /codecat fix fails lightweight verification", async () => {
    const probot = createProbot();
    const tokenMock = mockInstallationToken({
      contents: "write",
      issues: "write",
      pull_requests: "write",
    });
    const githubMock = mockPullContext(nock("https://api.github.com"))
      .post("/repos/hiimbex/testing-things/issues/2/comments", (body: { body?: string }) => {
        expect(body.body).toContain("Lightweight verification failed");
        expect(body.body).toContain("excluded");
        return true;
      })
      .reply(200);
    const reviewMock = mockOpenAI(reviewOutput());
    const fixMock = mockOpenAI(fixOutput(".env", "OPENAI_API_KEY='sk-thislookslikeasecret1234567890'"));

    await probot.receive({
      name: "issue_comment",
      payload: issueCommentPayload("/codecat fix"),
    });

    expect(tokenMock.pendingMocks()).toStrictEqual([]);
    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(reviewMock.pendingMocks()).toStrictEqual([]);
    expect(fixMock.pendingMocks()).toStrictEqual([]);
  });

  test("opens a safe fix pull request for a fixable push finding", async () => {
    const probot = createProbot();
    const pushPayload = {
      ref: "refs/heads/main",
      before: "abc123",
      after: "def456",
      deleted: false,
      repository: {
        name: "testing-things",
        default_branch: "main",
        owner: { login: "hiimbex" },
      },
      installation: { id: 2 },
      sender: { login: "hiimbex", type: "User" },
    };
    const tokenMock = mockInstallationToken({
      contents: "write",
      issues: "write",
      pull_requests: "write",
    });
    const githubMock = nock("https://api.github.com")
      .get(/\/repos\/hiimbex\/testing-things\/compare\/abc123\.\.\.def456/)
      .reply(200, {
        files: [
          {
            filename: "src/index.ts",
            status: "modified",
            patch: "-console.log('debug')\n+console.log('debug')",
          },
        ],
      })
      .get(/\/repos\/hiimbex\/testing-things\/git\/ref\/heads%2Fmain/)
      .reply(200, { object: { sha: "base-sha" } })
      .post("/repos/hiimbex/testing-things/git/refs", (body: { ref?: string; sha?: string }) => {
        expect(body.ref).toMatch(/^refs\/heads\/codecat\/fix\/def456-/);
        expect(body.sha).toBe("base-sha");
        return true;
      })
      .reply(201)
      .get(/\/repos\/hiimbex\/testing-things\/contents\/src%2Findex\.ts/)
      .query(true)
      .reply(200, { type: "file", sha: "file-sha", content: "" })
      .put(/\/repos\/hiimbex\/testing-things\/contents\/src%2Findex\.ts/, (body: { message?: string; content?: string; sha?: string }) => {
        expect(body.message).toContain("Remove debug log");
        expect(body.sha).toBe("file-sha");
        expect(body.content).toBe(Buffer.from("export default function app() {}\n").toString("base64"));
        return true;
      })
      .reply(200)
      .post("/repos/hiimbex/testing-things/pulls", (body: { title?: string; head?: string; base?: string; body?: string }) => {
        expect(body.title).toContain("Code Cat:");
        expect(body.head).toMatch(/^codecat\/fix\/def456-/);
        expect(body.base).toBe("main");
        expect(body.body).toContain("lightweight safety checks");
        return true;
      })
      .reply(201, { number: 3 });
    const reviewMock = mockOpenAI({
      ...reviewOutput(),
      shouldOpenIssue: true,
      issueTitle: "Debug log committed",
      issueBody: "A debug log should be removed.",
    });
    const fixMock = mockOpenAI(fixOutput());

    await probot.receive({ name: "push", payload: pushPayload });

    expect(tokenMock.pendingMocks()).toStrictEqual([]);
    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(reviewMock.pendingMocks()).toStrictEqual([]);
    expect(fixMock.pendingMocks()).toStrictEqual([]);
  });
});
