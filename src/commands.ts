export type CodeCatCommand =
  | "help"
  | "review"
  | "deep"
  | "fix"
  | "explain"
  | "status"
  | "ignore"
  | "config";

const COMMANDS = new Set<CodeCatCommand>([
  "help",
  "review",
  "deep",
  "fix",
  "explain",
  "status",
  "ignore",
  "config",
]);

export interface ParsedCommand {
  command: CodeCatCommand;
  args: string[];
}

export function parseCodeCatCommand(body: string): ParsedCommand | undefined {
  const line = body
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().startsWith("/codecat"));

  if (!line) {
    return undefined;
  }

  const [, rawCommand = "help", ...args] = line.split(/\s+/);
  const command = rawCommand.toLowerCase();
  if (!COMMANDS.has(command as CodeCatCommand)) {
    return { command: "help", args: [rawCommand, ...args].filter(Boolean) };
  }
  return { command: command as CodeCatCommand, args };
}

export function renderHelp(): string {
  return [
    "### Code Cat commands",
    "",
    "- `/codecat help` - show this help.",
    "- `/codecat review` - rerun an incremental PR review.",
    "- `/codecat deep` - rerun a deeper PR review with a larger context budget.",
    "- `/codecat fix` - try a lightweight-gated automatic fix.",
    "- `/codecat explain` - explain the latest review findings in plain language.",
    "- `/codecat status` - show runtime status.",
    "- `/codecat ignore` - skip future automatic reviews for this PR or issue.",
    "- `/codecat config` - show effective read-only Code Cat config.",
  ].join("\n");
}

