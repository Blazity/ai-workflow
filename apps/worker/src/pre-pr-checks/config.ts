import { z } from "zod";

export interface PrePrCheckRepositoryConfig {
  provider: "github" | "gitlab";
  repoPath: string;
  commands: string[];
}

export interface PrePrCheckConfig {
  repositories: PrePrCheckRepositoryConfig[];
}

export const emptyPrePrCheckConfig: PrePrCheckConfig = { repositories: [] };

const prePrCheckConfigSchema = z
  .object({
    repositories: z.array(
      z
        .object({
          provider: z.enum(["github", "gitlab"]),
          repoPath: z.string().trim().min(1),
          commands: z.array(z.string().trim().min(1)).min(1),
        })
        .strict(),
    ).default([]),
  })
  .strict();

export function parsePrePrCheckConfig(raw: string | undefined | null): PrePrCheckConfig {
  if (!raw?.trim()) return emptyPrePrCheckConfig;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid PRE_PR_CHECKS: ${errorMessage(err)}`);
  }

  const result = prePrCheckConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      "Invalid PRE_PR_CHECKS:\n" +
        result.error.issues
          .map((issue) => `  ${formatPath(issue.path)}: ${issue.message}`)
          .join("\n"),
    );
  }

  return result.data;
}

function formatPath(path: Array<string | number>): string {
  return path.length > 0 ? path.join(".") : "root";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
