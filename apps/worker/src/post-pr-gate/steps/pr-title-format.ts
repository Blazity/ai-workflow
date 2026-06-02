import { z } from "zod";
import type { PostPrGateStepHandler } from "../types.js";

const DEFAULT_PATTERN =
  "^(feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(\\([^)]+\\))?: .+";

const withSchema = z
  .object({
    pattern: z.string().min(1).default(DEFAULT_PATTERN),
  })
  .default({});

export const prTitleFormat: PostPrGateStepHandler = async ({ context, config }) => {
  const { pattern } = withSchema.parse(config ?? {});
  const regex = new RegExp(pattern);
  if (regex.test(context.pr.title)) {
    return {
      conclusion: "success",
      summary: "PR title matches the required format.",
    };
  }
  return {
    conclusion: "failure",
    summary: "PR title does not match Conventional Commits format.",
    details:
      "**Expected pattern:**\n\n" +
      "```\n" +
      pattern +
      "\n```\n\n" +
      "**Got:** `" +
      context.pr.title +
      "`",
  };
};
