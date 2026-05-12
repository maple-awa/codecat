import type { Context } from "probot";
import type { FixResult, ReviewResult } from "./types.js";

export const REVIEW_MARKER = "<!-- codecat:review -->";
export const IGNORE_MARKER = "<!-- codecat:ignore -->";
export const STATUS_MARKER = "<!-- codecat:status -->";
export const EXPLAIN_MARKER = "<!-- codecat:explain -->";

export function isBotSender(context: Context): boolean {
  const sender = (context.payload as { sender?: { type?: string; login?: string } }).sender;
  return sender?.type === "Bot" || sender?.login?.includes("[bot]") === true;
}

export function repoParams(context: Context): { owner: string; repo: string } {
  return context.repo();
}

export async function createIssueComment(
  context: Context,
  issueNumber: number,
  body: string,
): Promise<void> {
  await context.octokit.rest.issues.createComment({
    ...repoParams(context),
    issue_number: issueNumber,
    body,
  });
}

export async function createOrUpdateMarkedComment(
  context: Context,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  const params = { ...repoParams(context), issue_number: issueNumber };
  const comments = await context.octokit.paginate(
    context.octokit.rest.issues.listComments,
    params,
  );
  const existing = comments.find((comment) => comment.body?.includes(marker));
  const markedBody = `${marker}\n${body}`;

  if (existing) {
    await context.octokit.rest.issues.updateComment({
      ...repoParams(context),
      comment_id: existing.id,
      body: markedBody,
    });
    return;
  }

  await context.octokit.rest.issues.createComment({
    ...params,
    body: markedBody,
  });
}

export async function hasMarkedComment(
  context: Context,
  issueNumber: number,
  marker: string,
): Promise<boolean> {
  const comments = await context.octokit.paginate(
    context.octokit.rest.issues.listComments,
    { ...repoParams(context), issue_number: issueNumber, per_page: 100 },
  );
  return comments.some((comment) => comment.body?.includes(marker));
}

export async function createTrackingIssue(
  context: Context,
  title: string,
  body: string,
): Promise<void> {
  await context.octokit.rest.issues.create({
    ...repoParams(context),
    title,
    body,
  });
}

export async function createFixPullRequest(
  context: Context,
  baseBranch: string,
  sourceSha: string,
  fix: FixResult,
): Promise<number> {
  const { owner, repo } = repoParams(context);
  return createFixPullRequestWithOctokit(
    context.octokit,
    owner,
    repo,
    baseBranch,
    sourceSha,
    fix,
  );
}

export async function createFixPullRequestWithOctokit(
  octokit: any,
  owner: string,
  repo: string,
  baseBranch: string,
  sourceSha: string,
  fix: FixResult,
): Promise<number> {
  const safeSha = sourceSha.slice(0, 12);
  const branch = `codecat/fix/${safeSha}-${Date.now()}`;
  const baseRef = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.data.object.sha,
  });

  for (const change of fix.changes) {
    const current = await getFileSha(octokit, owner, repo, change.path, branch);
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: change.path,
      branch,
      message: `fix: ${change.reason}`,
      content: Buffer.from(change.content, "utf8").toString("base64"),
      sha: current,
    });
  }

  const pull = await octokit.rest.pulls.create({
    owner,
    repo,
    title: `Code Cat: ${fix.title}`,
    body: `${fix.body}\n\n${renderFixNotes(fix)}\n\n${renderValidationScope()}`,
    head: branch,
    base: baseBranch,
    maintainer_can_modify: true,
  });

  return pull.data.number;
}

async function getFileSha(
  octokit: any,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    if (!Array.isArray(response.data) && response.data.type === "file") {
      return response.data.sha;
    }
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404) {
      throw error;
    }
  }
  return undefined;
}

function renderFixNotes(fix: FixResult): string {
  if (fix.notes.length === 0) {
    return "_Code Cat prepared this patch automatically. Please review before merging._";
  }
  return [
    "_Code Cat prepared this patch automatically. Please review before merging._",
    "",
    "Notes:",
    ...fix.notes.map((note) => `- ${note}`),
  ].join("\n");
}

function renderValidationScope(): string {
  return [
    "Validation:",
    "- Code Cat performed lightweight safety checks on generated file paths and contents.",
    "- Code Cat did not run the repository test suite or build commands in this App runtime.",
  ].join("\n");
}

export function renderReviewComment(review: ReviewResult): string {
  if (review.findings.length === 0) {
    return [
      "### Code Cat review",
      "",
      `喵，审查完成：${review.summary}`,
      "",
      "No actionable risks found.",
    ].join("\n");
  }

  return [
    "### Code Cat review",
    "",
    `喵，审查完成：${review.summary}`,
    "",
    `Risk level: **${review.riskLevel}**`,
    "",
    ...review.findings.map((finding) =>
      [
        `- **${finding.severity.toUpperCase()}** ${finding.title}`,
        `  ${finding.file ? `File: \`${finding.file}\`` : "File: unknown"}${
          finding.line ? `:${finding.line}` : ""
        }`,
        `  ${finding.description}`,
        `  Recommendation: ${finding.recommendation}`,
      ].join("\n"),
    ),
  ].join("\n");
}

