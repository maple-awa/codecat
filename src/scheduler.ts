import cron from "node-cron";
import type { Probot } from "probot";
import { handleDailyRepository } from "./handlers.js";
import type { CodeCatAI } from "./openai.js";
import type { CodeCatConfig } from "./types.js";

export function scheduleDailyReview(
  app: Probot,
  ai: CodeCatAI,
  config: CodeCatConfig,
): void {
  if (config.disableScheduler) {
    app.log.info("Code Cat daily scheduler is disabled.");
    return;
  }

  cron.schedule(
    config.dailyCron,
    async () => {
      app.log.info("Code Cat daily review started.");
      await runDailyReview(app, ai, config);
    },
    { timezone: config.timezone },
  );
}

async function runDailyReview(app: Probot, ai: CodeCatAI, config: CodeCatConfig): Promise<void> {
  const probot = app as any;
  const installations = await probot.octokit.paginate(
    probot.octokit.rest.apps.listInstallations,
    { per_page: 100 },
  );

  for (const installation of installations) {
    const octokit = await probot.auth(installation.id);
    const repositories = await octokit.paginate(
      octokit.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );

    for (const repository of repositories) {
      await handleDailyRepository(
        octokit,
        repository.owner.login,
        repository.name,
        repository.default_branch,
        ai,
        config,
      );
    }
  }
}

