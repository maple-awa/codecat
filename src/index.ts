import { Probot } from "probot";
import { loadConfig } from "./config.js";
import {
  handleIssueComment,
  handleIssueOpened,
  handlePullRequest,
  handlePush,
} from "./handlers.js";
import { CodeCatAI } from "./openai.js";
import { configureHttpProxy } from "./proxy.js";
import { scheduleDailyReview } from "./scheduler.js";

export default (app: Probot) => {
  const config = loadConfig();
  if (configureHttpProxy(config)) {
    app.log.info("Code Cat HTTP proxy is enabled for GitHub and AI API requests.");
  }
  const ai = new CodeCatAI(config);

  app.on("issues.opened", async (context) => handleIssueOpened(context, ai));
  app.on("issue_comment.created", async (context) => handleIssueComment(context, ai, config));
  app.on(
    ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
    async (context) => handlePullRequest(context, ai, config),
  );
  app.on("push", async (context) => handlePush(context, ai, config));

  scheduleDailyReview(app, ai, config);
};
