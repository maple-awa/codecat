import type { Context } from "probot";
import { parseCodeCatCommand, renderHelp } from "./commands.js";
import {
  collectDailyInput,
  collectPullRequestInput,
  collectPullRequestInputByNumber,
  collectPushInput,
  readPullRequestSummary,
} from "./context.js";
import {
  EXPLAIN_MARKER,
  IGNORE_MARKER,
  REVIEW_MARKER,
  STATUS_MARKER,
  createFixPullRequest,
  createFixPullRequestWithOctokit,
  createIssueComment,
  createOrUpdateMarkedComment,
  createTrackingIssue,
  hasMarkedComment,
  isBotSender,
  renderReviewComment,
} from "./github.js";
import { verifyFix } from "./verification.js";
import type { CodeCatAI } from "./openai.js";
import { renderProxySummary } from "./proxy.js";
import type { CodeCatConfig, ReviewInput, ReviewResult } from "./types.js";

export async function handleIssueOpened(
  context: Context<"issues.opened">,
  ai: CodeCatAI,
): Promise<void> {
  if (isBotSender(context)) {
    return;
  }

  const { owner, repo } = context.repo();
  const issue = context.payload.issue;
  const reply = await ai.replyToIssue({
    owner,
    repo,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    author: issue.user?.login ?? "unknown",
  });

  await createIssueComment(context, issue.number, reply.body);
}

export async function handleIssueComment(
  context: Context<"issue_comment.created">,
  ai: CodeCatAI,
  config: CodeCatConfig,
): Promise<void> {
  if (isBotSender(context)) {
    return;
  }

  const parsed = parseCodeCatCommand(context.payload.comment.body);
  if (!parsed) {
    return;
  }

  const issueNumber = context.payload.issue.number;
  const isPullRequest = Boolean(context.payload.issue.pull_request);

  switch (parsed.command) {
    case "help":
      await createIssueComment(context, issueNumber, renderHelp());
      return;
    case "status":
      await createOrUpdateMarkedComment(context, issueNumber, STATUS_MARKER, renderStatus(config));
      return;
    case "config":
      await createOrUpdateMarkedComment(context, issueNumber, STATUS_MARKER, renderConfig(config));
      return;
    case "ignore":
      await createOrUpdateMarkedComment(
        context,
        issueNumber,
        IGNORE_MARKER,
        "Code Cat will skip future automatic reviews for this thread. Manual commands still work.",
      );
      return;
    case "review":
      await requirePullRequestCommand(context, isPullRequest, async () => {
        await runManualReview(context, ai, config, issueNumber);
      });
      return;
    case "deep":
      await requirePullRequestCommand(context, isPullRequest, async () => {
        await runManualReview(context, ai, deepConfig(config), issueNumber);
      });
      return;
    case "explain":
      await requirePullRequestCommand(context, isPullRequest, async () => {
        const input = await collectPullRequestInputByNumber(context, issueNumber, config);
        const review = await ai.reviewCode(input);
        const explanation = await ai.explainReview(input, review);
        await createOrUpdateMarkedComment(context, issueNumber, EXPLAIN_MARKER, explanation.body);
      });
      return;
    case "fix":
      if (!isPullRequest) {
        await createIssueComment(
          context,
          issueNumber,
          "喵，issue 上的自动修复需要明确文件路径、风险描述和期望改动。请补充这些信息后再让我尝试。",
        );
        return;
      }
      await runManualFix(context, ai, config, issueNumber);
      return;
  }
}

export async function handlePullRequest(
  context: Context<"pull_request.opened" | "pull_request.reopened" | "pull_request.synchronize">,
  ai: CodeCatAI,
  config: CodeCatConfig,
): Promise<void> {
  const pull = context.payload.pull_request;
  if (
    isBotSender(context) ||
    isCodeCatBranch(pull.head.ref) ||
    (await hasMarkedComment(context, pull.number, IGNORE_MARKER))
  ) {
    return;
  }

  const input = await collectPullRequestInput(context, config);
  const review = await ai.reviewCode(input);
  await createOrUpdateMarkedComment(
    context,
    pull.number,
    REVIEW_MARKER,
    renderReviewComment(review),
  );
}

export async function handlePush(
  context: Context<"push">,
  ai: CodeCatAI,
  config: CodeCatConfig,
): Promise<void> {
  const branch = context.payload.ref.replace("refs/heads/", "");
  if (
    isBotSender(context) ||
    isCodeCatBranch(branch) ||
    context.payload.deleted ||
    context.payload.after.match(/^0+$/)
  ) {
    return;
  }

  const input = await collectPushInput(context, config);
  const review = await ai.reviewCode(input);
  await handleReviewOutcome(context, ai, config, input, review, branch, context.payload.after);
}

export async function handleDailyRepository(
  octokit: any,
  owner: string,
  repo: string,
  defaultBranch: string,
  ai: CodeCatAI,
  config: CodeCatConfig,
): Promise<void> {
  const input = await collectDailyInput(octokit, owner, repo, defaultBranch, config);
  const review = await ai.reviewCode(input);
  if (review.findings.length === 0) {
    return;
  }

  const hasFixableRisk = review.findings.some((finding) => finding.fixable);
  if (config.autoFixEnabled && hasFixableRisk) {
    const fix = await ai.proposeFix(input, review);
    const verification = await verifyFix(config, fix);
    if (fix.canFix && verification.ok) {
      await createFixPullRequestWithOctokit(
        octokit,
        owner,
        repo,
        defaultBranch,
        input.headRef ?? defaultBranch,
        fix,
      );
      return;
    }

    await octokit.rest.issues.create({
      owner,
      repo,
      title: review.issueTitle ?? "Code Cat daily review needs attention",
      body: renderSkippedFixBody(review, verification.details, fix.notes),
    });
    return;
  }

  await octokit.rest.issues.create({
    owner,
    repo,
    title: review.issueTitle ?? "Code Cat daily review findings",
    body: review.issueBody ?? renderReviewIssueBody(review),
  });
}

async function runManualReview(
  context: Context,
  ai: CodeCatAI,
  config: CodeCatConfig,
  pullNumber: number,
): Promise<void> {
  const input = await collectPullRequestInputByNumber(context, pullNumber, config);
  const review = await ai.reviewCode(input);
  await createOrUpdateMarkedComment(context, pullNumber, REVIEW_MARKER, renderReviewComment(review));
}

async function runManualFix(
  context: Context,
  ai: CodeCatAI,
  config: CodeCatConfig,
  pullNumber: number,
): Promise<void> {
  const pull = await readPullRequestSummary(context, pullNumber);
  const input = await collectPullRequestInputByNumber(context, pullNumber, config, pull);
  const review = await ai.reviewCode(input);
  await handleReviewOutcome(context, ai, config, input, review, pull.baseRef, pull.headSha, pullNumber);
}

async function handleReviewOutcome(
  context: Context,
  ai: CodeCatAI,
  config: CodeCatConfig,
  input: ReviewInput,
  review: ReviewResult,
  baseBranch: string,
  sourceSha: string,
  commentIssueNumber?: number,
): Promise<void> {
  if (review.findings.length === 0) {
    if (commentIssueNumber) {
      await createIssueComment(context, commentIssueNumber, "喵，未发现需要自动修复的风险。");
    }
    return;
  }

  const hasFixableRisk = review.findings.some((finding) => finding.fixable);
  if (config.autoFixEnabled && hasFixableRisk) {
    const fix = await ai.proposeFix(input, review);
    const verification = await verifyFix(config, fix);
    if (fix.canFix && verification.ok) {
      const pullNumber = await createFixPullRequest(context, baseBranch, sourceSha, fix);
      if (commentIssueNumber) {
        await createIssueComment(
          context,
          commentIssueNumber,
          `喵，轻量校验通过，我已经打开修复 PR #${pullNumber}。`,
        );
      }
      return;
    }

    const body = renderSkippedFixBody(review, verification.details, fix.notes);
    if (commentIssueNumber) {
      await createIssueComment(context, commentIssueNumber, body);
      return;
    }

    await createTrackingIssue(
      context,
      review.issueTitle ?? "Code Cat found risks but did not open a fix PR",
      body,
    );
    return;
  }

  if (review.shouldOpenIssue || review.findings.length > 0) {
    await createTrackingIssue(
      context,
      review.issueTitle ?? "Code Cat review findings",
      review.issueBody ?? renderReviewIssueBody(review),
    );
  }
}

async function requirePullRequestCommand(
  context: Context,
  isPullRequest: boolean,
  run: () => Promise<void>,
): Promise<void> {
  if (!isPullRequest) {
    await createIssueComment(
      context,
      (context.payload as { issue: { number: number } }).issue.number,
      "喵，这个命令需要在 Pull Request 对话里使用。",
    );
    return;
  }
  await run();
}

function deepConfig(config: CodeCatConfig): CodeCatConfig {
  return {
    ...config,
    reviewMode: "deep",
    maxFiles: Math.max(config.maxFiles, 80),
    maxBytes: Math.max(config.maxBytes, 240_000),
  };
}

function renderStatus(config: CodeCatConfig): string {
  return [
    "### Code Cat status",
    "",
    `- OpenAI: ${config.openaiApiKey ? "configured" : "missing OPENAI_API_KEY"}`,
    `- Model: \`${config.openaiModel}\``,
    `- Proxy: \`${renderProxySummary(config.proxy)}\``,
    `- Review mode: \`${config.reviewMode}\``,
    `- Auto fix: \`${config.autoFixEnabled ? "enabled" : "disabled"}\``,
    `- Verify mode: \`${config.verifyMode}\``,
    `- Daily cron: \`${config.dailyCron}\` (${config.timezone})`,
    `- Scheduler: \`${config.disableScheduler ? "disabled" : "enabled"}\``,
  ].join("\n");
}

function renderConfig(config: CodeCatConfig): string {
  return [
    "### Code Cat config",
    "",
    `- CODECAT_REVIEW_MODE=\`${config.reviewMode}\``,
    `- CODECAT_AUTO_FIX_ENABLED=\`${config.autoFixEnabled}\``,
    `- CODECAT_VERIFY_MODE=\`${config.verifyMode}\``,
    `- CODECAT_PROXY=\`${renderProxySummary(config.proxy)}\``,
    `- CODECAT_MAX_FILES=\`${config.maxFiles}\``,
    `- CODECAT_MAX_BYTES=\`${config.maxBytes}\``,
    `- CODECAT_MAX_FIX_FILES=\`${config.maxFixFiles}\``,
    `- CODECAT_MAX_FIX_BYTES=\`${config.maxFixBytes}\``,
    `- CODECAT_EXCLUDE_GLOBS=\`${config.excludeGlobs.join(",")}\``,
  ].join("\n");
}

function renderSkippedFixBody(
  review: ReviewResult,
  verificationDetails: string,
  notes: string[],
): string {
  return [
    review.issueBody ?? renderReviewIssueBody(review),
    "",
    "Automatic fix was skipped:",
    verificationDetails,
    ...notes.map((note) => `- ${note}`),
  ].join("\n");
}

function renderReviewIssueBody(review: ReviewResult): string {
  return [
    `喵，Code Cat 发现了一些需要人类确认的问题：${review.summary}`,
    "",
    ...review.findings.map((finding) =>
      [
        `- **${finding.severity.toUpperCase()}** ${finding.title}`,
        finding.file ? `  File: \`${finding.file}\`${finding.line ? `:${finding.line}` : ""}` : "",
        `  ${finding.description}`,
        `  Recommendation: ${finding.recommendation}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function isCodeCatBranch(branch: string): boolean {
  return branch.startsWith("codecat/");
}
