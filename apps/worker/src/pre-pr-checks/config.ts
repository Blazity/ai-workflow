import { z } from "zod";

export interface PrePrCheckRepositoryConfig {
  provider: "github" | "gitlab";
  repoPath: string;
  /**
   * Provisioning commands run before this repository's checks: toolchain
   * installs the sandbox image does not ship. Optional and absent from every
   * config stored before this field existed, so it must stay defaultable.
   */
  setup?: string[];
  commands: string[];
}

export interface PrePrCheckConfig {
  repositories: PrePrCheckRepositoryConfig[];
}

export const emptyPrePrCheckConfig: PrePrCheckConfig = { repositories: [] };

export const prePrCheckConfigSchema = z
  .object({
    repositories: z.array(
      z
        .object({
          provider: z.enum(["github", "gitlab"]),
          repoPath: z.string().trim().min(1),
          // No .min(1): a repository without provisioning is the normal case,
          // and every config stored before this field omits the key entirely.
          setup: z.array(z.string().trim().min(1)).default([]),
          commands: z.array(z.string().trim().min(1)).min(1),
        })
        .strict(),
    ).default([]),
  })
  .strict();

export function describePrePrCheckIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}
