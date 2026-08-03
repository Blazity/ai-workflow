import type { ReleaseCollection } from "./types.js";

export const collection: ReleaseCollection = {
  repository: "Blazity/ai-workflow",
  previousCommit: "a".repeat(40),
  targetCommit: "b".repeat(40),
  included: [
    {
      number: 7,
      title: "feat: GitLab support",
      body: "## User impact\nGitLab repositories work.\n## Release note\nUse GitLab repositories.",
      labels: ["release:feature"],
      mergedAt: "2026-07-30T10:00:00Z",
      mergeCommitSha: "c".repeat(40),
      url: "https://github.com/Blazity/ai-workflow/pull/7",
      category: "feature",
      customerFacing: true,
      included: true,
      fields: {
        userImpact: "GitLab repositories work.",
        requiredAction: "None",
        releaseNote: "Use GitLab repositories.",
      },
      warnings: [],
    },
  ],
  internal: [],
  skipped: [],
  warnings: [],
};
