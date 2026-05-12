import OpenAI from "openai";
import type { ZodType } from "zod";
import {
  ExplanationSchema,
  FixResultSchema,
  IssueReplySchema,
  ReviewResultSchema,
  type CodeCatConfig,
  type Explanation,
  type FixResult,
  type IssueInput,
  type IssueReply,
  type ReviewInput,
  type ReviewResult,
} from "./types.js";

const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    riskLevel: {
      type: "string",
      enum: ["none", "low", "medium", "high", "critical"],
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: {
            type: "string",
            enum: ["info", "low", "medium", "high", "critical"],
          },
          title: { type: "string" },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          description: { type: "string" },
          recommendation: { type: "string" },
          fixable: { type: "boolean" },
        },
        required: [
          "severity",
          "title",
          "file",
          "line",
          "description",
          "recommendation",
          "fixable",
        ],
      },
    },
    shouldOpenIssue: { type: "boolean" },
    issueTitle: { type: ["string", "null"] },
    issueBody: { type: ["string", "null"] },
  },
  required: ["summary", "riskLevel", "findings", "shouldOpenIssue", "issueTitle", "issueBody"],
};

const ISSUE_REPLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    body: { type: "string" },
    needsClarification: { type: "boolean" },
  },
  required: ["body", "needsClarification"],
};

const EXPLANATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    body: { type: "string" },
  },
  required: ["body"],
};

const FIX_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    canFix: { type: "boolean" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    title: { type: "string" },
    body: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          reason: { type: "string" },
        },
        required: ["path", "content", "reason"],
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["canFix", "confidence", "title", "body", "changes", "notes"],
};

export class CodeCatAI {
  private readonly client?: OpenAI;

  public constructor(private readonly config: CodeCatConfig) {
    if (config.openaiApiKey) {
      this.client = new OpenAI({
        apiKey: config.openaiApiKey,
        baseURL: config.openaiBaseURL,
      });
    }
  }

  public async reviewCode(input: ReviewInput): Promise<ReviewResult> {
    return this.requestJson(
      "codecat_review",
      ReviewResultSchema,
      REVIEW_JSON_SCHEMA,
      [
        "You are Code Cat, a careful GitHub App code reviewer.",
        "Find correctness, security, reliability, maintainability, and test risks.",
        "Be warm and concise, with a light cat-like tone only in prose.",
        "Do not invent files or line numbers. Mark fixable only when a safe concrete fix is obvious.",
      ].join("\n"),
      input,
      {
        summary: "Code Cat is configured, but OPENAI_API_KEY is missing, so AI review was skipped.",
        riskLevel: "none",
        findings: [],
        shouldOpenIssue: false,
        issueTitle: null,
        issueBody: null,
      },
    );
  }

  public async replyToIssue(input: IssueInput): Promise<IssueReply> {
    return this.requestJson(
      "codecat_issue_reply",
      IssueReplySchema,
      ISSUE_REPLY_JSON_SCHEMA,
      [
        "You are Code Cat, a friendly GitHub issue triage assistant.",
        "Reply in the issue language when possible. Be helpful, brief, and ask for missing details.",
        "Use a small amount of cat personality, but keep the response professional.",
      ].join("\n"),
      input,
      {
        body: "喵，我已经收到这个 issue 了。当前缺少 `OPENAI_API_KEY`，所以我还不能做智能分析；配置好后我会自动补充更具体的排查建议。",
        needsClarification: true,
      },
    );
  }

  public async explainReview(input: ReviewInput, review: ReviewResult): Promise<Explanation> {
    return this.requestJson(
      "codecat_explain",
      ExplanationSchema,
      EXPLANATION_JSON_SCHEMA,
      [
        "You are Code Cat, explaining code review findings to a maintainer.",
        "Reply in the repository user's language when possible.",
        "Be concise, concrete, and friendly. Keep cat personality light.",
      ].join("\n"),
      { input, review },
      {
        body: "喵，我暂时不能调用 AI 解释审查结果。请先配置 `OPENAI_API_KEY`。",
      },
    );
  }

  public async proposeFix(input: ReviewInput, review: ReviewResult): Promise<FixResult> {
    return this.requestJson(
      "codecat_fix",
      FixResultSchema,
      FIX_JSON_SCHEMA,
      [
        "You are Code Cat, an automated maintainer.",
        "Return complete replacement file contents only for files that are safe to change.",
        "Never include secrets, binary files, generated output, or unrelated refactors.",
        "If the fix is uncertain, set canFix=false and explain in notes.",
      ].join("\n"),
      { input, review },
      {
        canFix: false,
        confidence: "low",
        title: "Code Cat could not prepare an automatic fix",
        body: "OPENAI_API_KEY is missing, so Code Cat cannot prepare a safe patch.",
        changes: [],
        notes: ["Missing OPENAI_API_KEY."],
      },
    );
  }

  private async requestJson<T>(
    name: string,
    schema: ZodType<T>,
    jsonSchema: object,
    system: string,
    payload: unknown,
    fallback: T,
  ): Promise<T> {
    if (!this.client) {
      return fallback;
    }

    const response = await this.client.responses.create({
      model: this.config.openaiModel,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
      text: {
        format: {
          type: "json_schema",
          name,
          strict: true,
          schema: jsonSchema,
        },
      },
    } as any);

    const outputText = extractOutputText(response);
    return schema.parse(JSON.parse(outputText));
  }
}

function extractOutputText(response: unknown): string {
  const typed = response as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };

  if (typed.output_text) {
    return typed.output_text;
  }

  const text = typed.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .find((value): value is string => typeof value === "string");

  if (!text) {
    throw new Error("OpenAI response did not include output_text.");
  }
  return text;
}
