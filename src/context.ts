import type { Context } from "probot";
import { shouldIncludeFile, truncateText } from "./filters.js";
import type { CodeCatConfig, ReviewInput, ReviewedFile } from "./types.js";

export async function collectPullRequestInput(
  context: Context<"pull_request.opened" | "pull_request.reopened" | "pull_request.synchronize">,
  config: CodeCatConfig,
): Promise<ReviewInput> {
  const pull = context.payload.pull_request;
  return collectPullRequestInputByNumber(context, pull.number, config, {
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    title: pull.title,
  });
}

export async function collectPullRequestInputByNumber(
  context: Context,
  pullNumber: number,
  config: CodeCatConfig,
  known?: { baseRef?: string; headRef?: string; title?: string },
): Promise<ReviewInput> {
  const { owner, repo } = context.repo();
  const pull =
    known?.baseRef && known.headRef && known.title
      ? known
      : await readPullRequestSummary(context, pullNumber);
  const diff = await context.octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner,
      repo,
      pull_number: pullNumber,
      headers: { accept: "application/vnd.github.v3.diff" },
    },
  );
  const changedFiles = await context.octokit.paginate(
    context.octokit.rest.pulls.listFiles,
    { owner, repo, pull_number: pullNumber, per_page: 100 },
  );

  return {
    event: "pull_request",
    owner,
    repo,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    title: pull.title,
    diff: truncateText(String(diff.data), config.maxBytes),
    files: changedFiles
      .filter((file) => shouldIncludeFile(file.filename, config))
      .slice(0, config.maxFiles)
      .map((file) => ({
        path: file.filename,
        status: file.status,
        patch: file.patch,
      })),
  };
}

export async function readPullRequestSummary(
  context: Context,
  pullNumber: number,
): Promise<{ baseRef: string; headRef: string; headSha: string; title: string }> {
  const { owner, repo } = context.repo();
  const pull = await context.octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return {
    baseRef: pull.data.base.ref,
    headRef: pull.data.head.ref,
    headSha: pull.data.head.sha,
    title: pull.data.title,
  };
}

export async function collectPushInput(
  context: Context<"push">,
  config: CodeCatConfig,
): Promise<ReviewInput> {
  const { owner, repo } = context.repo();
  const basehead = `${context.payload.before}...${context.payload.after}`;
  const comparison = await context.octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead,
  });
  const files = (comparison.data.files ?? [])
    .filter((file) => shouldIncludeFile(file.filename, config))
    .slice(0, config.maxFiles)
    .map((file) => ({
      path: file.filename,
      status: file.status,
      patch: file.patch,
    }));

  return {
    event: "push",
    owner,
    repo,
    baseRef: context.payload.ref.replace("refs/heads/", ""),
    headRef: context.payload.after,
    diff: truncateText(JSON.stringify(files), config.maxBytes),
    files,
  };
}

export async function collectDailyInput(
  octokit: any,
  owner: string,
  repo: string,
  defaultBranch: string,
  config: CodeCatConfig,
): Promise<ReviewInput> {
  const branch = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch: defaultBranch,
  });
  const tree = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: branch.data.commit.sha,
    recursive: "1",
  });
  const candidates = tree.data.tree
    .filter((item: { type?: string; path?: string }) => item.type === "blob" && item.path)
    .map((item: { path: string }) => item.path)
    .filter((path: string) => shouldIncludeFile(path, config))
    .filter(isReviewCandidate)
    .slice(0, config.maxFiles);

  const files: ReviewedFile[] = [];
  for (const path of candidates) {
    const content = await readFileContent(octokit, owner, repo, path, defaultBranch);
    if (content !== undefined) {
      files.push({ path, content: truncateText(content, config.maxBytes) });
    }
  }

  return {
    event: "daily",
    owner,
    repo,
    baseRef: defaultBranch,
    headRef: branch.data.commit.sha,
    files,
  };
}

async function readFileContent(
  octokit: any,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(response.data) || response.data.type !== "file" || !response.data.content) {
    return undefined;
  }
  return Buffer.from(response.data.content, "base64").toString("utf8");
}

function isReviewCandidate(path: string): boolean {
  return (
    path === "package.json" ||
    path === "app.yml" ||
    path === "Dockerfile" ||
    path.startsWith("src/") ||
    path.startsWith("test/") ||
    path.endsWith(".ts") ||
    path.endsWith(".js") ||
    path.endsWith(".yml") ||
    path.endsWith(".yaml")
  );
}
