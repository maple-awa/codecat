import { z } from "zod";

export type ReviewMode = "incremental" | "standard" | "deep";
export type VerifyMode = "lightweight";

export interface ProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export interface CodeCatConfig {
  openaiApiKey?: string;
  openaiModel: string;
  openaiBaseURL?: string;
  proxy: ProxyConfig;
  timezone: string;
  dailyCron: string;
  reviewMode: ReviewMode;
  autoFixEnabled: boolean;
  verifyMode: VerifyMode;
  verifyCommands: string[];
  excludeGlobs: string[];
  maxFiles: number;
  maxBytes: number;
  maxFixFiles: number;
  maxFixBytes: number;
  disableScheduler: boolean;
}

export interface ReviewInput {
  event: "pull_request" | "push" | "daily";
  owner: string;
  repo: string;
  baseRef?: string;
  headRef?: string;
  title?: string;
  diff?: string;
  files: ReviewedFile[];
}

export interface ReviewedFile {
  path: string;
  status?: string;
  patch?: string;
  content?: string;
}

export interface IssueInput {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
}

export const FindingSchema = z.object({
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  title: z.string(),
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  description: z.string(),
  recommendation: z.string(),
  fixable: z.boolean(),
});

export const ReviewResultSchema = z.object({
  summary: z.string(),
  riskLevel: z.enum(["none", "low", "medium", "high", "critical"]),
  findings: z.array(FindingSchema),
  shouldOpenIssue: z.boolean(),
  issueTitle: z.string().nullable(),
  issueBody: z.string().nullable(),
});

export const IssueReplySchema = z.object({
  body: z.string(),
  needsClarification: z.boolean(),
});

export const ExplanationSchema = z.object({
  body: z.string(),
});

export const FileChangeSchema = z.object({
  path: z.string(),
  content: z.string(),
  reason: z.string(),
});

export const FixResultSchema = z.object({
  canFix: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
  title: z.string(),
  body: z.string(),
  changes: z.array(FileChangeSchema),
  notes: z.array(z.string()),
});

export type Finding = z.infer<typeof FindingSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type IssueReply = z.infer<typeof IssueReplySchema>;
export type FixResult = z.infer<typeof FixResultSchema>;
export type Explanation = z.infer<typeof ExplanationSchema>;
