# codecat

> A GitHub App built with [Probot](https://github.com/probot/probot) that reviews code, triages issues, and helps maintain repositories with a tiny Code Cat personality.

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Features

- Reviews pull requests with OpenAI Responses API structured output.
- Replies to new issues with a friendly, context-aware Code Cat response.
- Reviews push diffs and opens a tracking issue when risks need attention.
- Prepares fix PRs only when a proposed patch passes the configured safety gate.
- Runs a daily repository review on the configured cron schedule.
- Supports `/codecat` commands in PR and issue comments.

## Configuration

Copy `.env.example` to `.env` and set at least:

```sh
OPENAI_API_KEY=<your-openai-api-key>
OPENAI_MODEL=gpt-5.5
CODECAT_DAILY_CRON="0 3 * * *"
CODECAT_TIMEZONE=Asia/Shanghai
```

Set `CODECAT_PROXY_URL` when outbound GitHub and OpenAI API traffic must go through a proxy:

```sh
CODECAT_PROXY_URL=http://127.0.0.1:7890
CODECAT_NO_PROXY=localhost,127.0.0.1
```

`CODECAT_HTTP_PROXY` and `CODECAT_HTTPS_PROXY` can be used when the two protocols need separate proxies. Standard `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` variables are also honored.

Keep `CODECAT_EXCLUDE_GLOBS` pointed at secrets and generated output. Code Cat will not send excluded files to OpenAI.

## Commands

- `/codecat help` - show command help.
- `/codecat review` - rerun an incremental PR review.
- `/codecat deep` - rerun a deeper PR review.
- `/codecat fix` - try a lightweight-gated automatic fix.
- `/codecat explain` - explain review findings.
- `/codecat status` - show runtime status.
- `/codecat ignore` - skip future automatic reviews for this PR or issue.
- `/codecat config` - show read-only effective config.

## Safety

Code Cat uses lightweight verification before opening automatic fix PRs. It checks excluded paths, generated output, file count, file size, binary-looking content, base64-like blobs, and common secret patterns. It does not run tests or builds inside the GitHub App runtime.

## Docker

```sh
# 1. Build container
docker build -t codecat .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> -e OPENAI_API_KEY=<openai-api-key> codecat
```

## Contributing

If you have suggestions for how codecat could be improved, or want to report a bug, open an issue. We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) (c) 2026 MapleLeaf
