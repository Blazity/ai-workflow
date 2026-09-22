/**
 * Readable inputs for the prompt goldens: one realistic send per kind, so a
 * reviewer can open __golden__/<name>.txt and read what the model receives.
 * The generated matrix (matrix.ts) is what proves byte identity; these are
 * what a person reads.
 */
import type { EffectivePromptRepositorySource } from "@shared/prompts";
import type { ReviewThreadFeed } from "../../adapters/vcs/types.js";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type {
  FixContextInput,
  PreSandboxPromptAddition,
  SelectedRepositoryPromptContext,
} from "../../sandbox/context.js";
import type { WorkspaceManifest } from "../../sandbox/repo-workspace.js";
import type { RepositoryMapContext } from "../../repository-map/map.js";

export const GOLDEN_TICKET = {
  identifier: "AIW-512",
  title: "Session refresh drops the user after a deploy",
  description:
    "After every deploy, users with an open tab are logged out on their next request.\n\nThe refresh token should survive a deploy.",
  acceptanceCriteria: "- A deploy does not log anybody out.\n- The refresh path has a regression test.",
  comments: [
    { author: "Anna Nowak", body: "Seen on web and on the mobile app. Łódź office reports it too." },
    { author: "Piotr", body: "Probably the signing key rotation in acme/api, see src/auth/keys.ts." },
  ],
  clarifications: [
    {
      questions: ["Should existing sessions survive a key rotation, or only a deploy?"],
      answer: "Only a deploy. A key rotation may log people out.",
      answeredBy: "Anna Nowak",
      answeredAt: "2026-09-18T09:12:00.000Z",
    },
  ],
};

const api: SelectedRepository = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "the ticket names the signing keys in acme/api",
};
const web: SelectedRepository = {
  provider: "github",
  repoPath: "acme/web",
  defaultBranch: "main",
  selectedRationale: "frontend for acme/api",
};
const sdk: SelectedRepository = {
  provider: "github",
  repoPath: "acme/sdk",
  defaultBranch: "main",
  selectedRationale: "sibling pull request of the same run",
  reviewPullRequest: {
    id: 88,
    url: "https://github.com/acme/sdk/pull/88",
    branch: "ai-workflow/aiw-512",
    headSha: "9f1c2d3",
  },
};

export const GOLDEN_REPOSITORIES = { api, web, sdk };

/**
 * What the pre-sandbox step gathered about the repositories: the operator's
 * descriptions, the relationships they recorded, and the record's own state for
 * one repository a person excluded. This is what every repository-working send
 * now renders as its repository map.
 */
export const GOLDEN_REPOSITORY_MAP: RepositoryMapContext = {
  repositories: [
    {
      key: "github:acme/api",
      catalogDescription:
        "The session and billing API. It owns key rotation, the refresh path and the webhook fan-out.",
      relationships: [
        { kind: "backend_for", targetKey: "github:acme/web", direction: "outgoing" },
        { kind: "depends_on", targetKey: "github:acme/sdk", direction: "incoming" },
      ],
      enabled: true,
      usable: true,
    },
    {
      key: "github:acme/web",
      catalogDescription: "The customer dashboard. Sign-in and the account screens live here.",
      providerDescription: "acme web",
      enabled: true,
      usable: true,
    },
    {
      key: "github:acme/sdk",
      providerDescription: "Client SDK for the acme API",
      enabled: true,
      usable: true,
    },
    {
      key: "github:acme/legacy-auth",
      catalogDescription: "The retired auth monolith. Read only, kept for its migration history.",
      enabled: true,
      usable: true,
    },
    {
      key: "github:acme/infra",
      catalogDescription: "Terraform for every environment.",
      enabled: false,
      usable: true,
    },
    {
      key: "github:acme/docs",
      catalogDescription: "The public developer documentation.",
      enabled: true,
      usable: true,
    },
  ],
  namedKeys: ["github:acme/api"],
  entries: [
    {
      repositoryKey: "github:acme/legacy-auth",
      state: "excluded",
      origin: "person",
      rationale: "not part of this ticket",
      decidedBy: { kind: "person", actorId: "u-anna", actorLabel: "Anna Nowak" },
      decidedAt: "2026-09-17T11:04:00.000Z",
    },
  ],
  leftOut: [
    {
      repositoryKey: "github:acme/legacy-auth",
      reason:
        "github:acme/legacy-auth was excluded on this ticket by Anna Nowak on 2026-09-17.",
    },
  ],
  catalogActivated: true,
};

export const GOLDEN_MANIFEST: WorkspaceManifest = {
  version: 2,
  repositories: [
    {
      provider: "github",
      repoPath: "acme/api",
      slug: "github__acme__api",
      localPath: "/vercel/sandbox/repos/github__acme__api",
      defaultBranch: "main",
      branchName: "ai-workflow/aiw-512",
      selectedRationale: api.selectedRationale,
      access: "write",
    },
    {
      provider: "github",
      repoPath: "acme/web",
      slug: "github__acme__web",
      localPath: "/vercel/sandbox/repos/github__acme__web",
      defaultBranch: "main",
      branchName: "ai-workflow/aiw-512",
      selectedRationale: web.selectedRationale,
      access: "read",
    },
    {
      provider: "github",
      repoPath: "acme/sdk",
      slug: "github__acme__sdk",
      localPath: "/vercel/sandbox/repos/github__acme__sdk",
      defaultBranch: "main",
      branchName: "ai-workflow/aiw-512",
      selectedRationale: sdk.selectedRationale,
      access: "read",
    },
  ],
};

/** What the pre-sandbox step returns for a ticket naming two repositories and
 *  a third that a person excluded earlier. */
export const GOLDEN_PRE_SANDBOX_ADDITIONS: PreSandboxPromptAddition[] = [
  // The "Selected Repositories" addition that used to lead this list is gone:
  // the repository map says everything it said, in the one shape every send
  // renders, and two lists of the same repositories is how they drifted.
  {
    target: ["research", "implementation", "review"],
    title: "Repositories left out",
    content: "- github:acme/legacy-auth was excluded on this ticket by Anna Nowak on 2026-09-17.",
  },
];

/** What discovery adds mid-run when it leaves a named repository out. */
export const GOLDEN_DISCOVERY_LEFT_OUT: PreSandboxPromptAddition = {
  target: ["research", "implementation", "review"],
  title: "Repositories left out",
  content: "- github:acme/mobile is not enabled in the repository catalog, so this run did not open it.",
  producedBy: "repository_discovery",
};

/** The review change set a pull request review run fetches before any block. */
export const GOLDEN_REVIEW_CHANGE_SET: PreSandboxPromptAddition = {
  target: ["review"],
  producedBy: "review_change_set",
  title: "Pull request change set",
  content: [
    "- Provider: github",
    "- Repository: acme/api",
    "- Pull request: #41",
    "- URL: https://github.com/acme/api/pull/41",
    "- Head: ai-workflow/aiw-512 at 7a7b7c7",
    "- Base: main",
    "",
    "The review checkout is a detached snapshot of the head commit with no base branch, so it cannot produce this diff itself. Treat the change set below as the definition of what this pull request changed.",
    "",
    "### src/auth/keys.ts (modified, +4 -1)",
    "",
    "```diff",
    "-const ROTATE_ON_BOOT = true;",
    "+const ROTATE_ON_BOOT = false;",
    "```",
  ].join("\n"),
};

export const GOLDEN_RESEARCH_LOOP = {
  priorRequests: [
    { provider: "github", repoPath: "acme/web", rationale: "the logout is observed in the web client" },
  ],
  refusals: [
    {
      repositoryKey: "github:acme/legacy-auth",
      sentence:
        "github:acme/legacy-auth: Anna Nowak excluded it on this ticket on 2026-09-17, so this run will not attach it.",
    },
    {
      repositoryKey: "github:acme/mobile",
      sentence: "github:acme/mobile: nobody enabled it in the repository catalog, so no run can attach it.",
    },
  ],
  ledgerCorrectionNote:
    "Your previous answer marked T1 as already_addressed, but the quoted excerpt does not appear in src/auth/session.ts. Answer T1 again: either quote the line as it is on the branch, or mark it actionable.",
};

const ledgerNote = (author: string, body: string) => ({
  author,
  body,
  createdAt: "2026-09-18T08:00:00.000Z",
  isLedgerReply: false,
});

const GOLDEN_REVIEW_FEED: ReviewThreadFeed = {
  threads: [
    {
      threadId: "PRRT_1",
      alias: "T1",
      source: "human",
      resolvable: true,
      awaitingHuman: false,
      filePath: "src/auth/session.ts",
      line: 88,
      notes: [ledgerNote("Piotr", "The refresh path still reads the rotated key. Please read the previous key too.")],
    },
    {
      threadId: "PRRT_2",
      alias: "T2",
      source: "third_party",
      resolvable: true,
      awaitingHuman: false,
      notes: [ledgerNote("coderabbitai", "Consider caching the key set.")],
    },
  ],
  truncated: 0,
  contextTruncated: 0,
  snapshotAt: "2026-09-18T08:05:00.000Z",
};

export const GOLDEN_LEDGER_CONTEXTS: SelectedRepositoryPromptContext[] = [
  {
    repository: api,
    prComments: [
      { author: "Piotr", body: "The refresh path still reads the rotated key. Please read the previous key too.", liked: false },
      { author: "Piotr", body: "Changes requested: see the thread on session.ts.", liked: false },
    ],
    checkResults: [
      { name: "unit", status: "completed", conclusion: "failure", logs: "session.test.ts: expected 200, got 401" },
      { name: "lint", status: "completed", conclusion: "success" },
    ],
    hasConflicts: false,
    reviewThreads: GOLDEN_REVIEW_FEED,
  },
];

export const GOLDEN_FLAT_FEEDBACK_CONTEXTS: SelectedRepositoryPromptContext[] = [
  {
    repository: api,
    prComments: [
      { author: "Piotr", body: "Keep the old key for one deploy.", liked: false, filePath: "src/auth/keys.ts", startLine: 10, endLine: 14 },
    ],
    checkResults: [],
    hasConflicts: true,
  },
];

export const GOLDEN_PLAN =
  "## Plan\n\n1. Stop rotating the signing key on boot in `src/auth/keys.ts`.\n2. Read the previous key on refresh in `src/auth/session.ts`.\n3. Add a regression test that deploys twice.";

export const GOLDEN_REPOSITORY_SOURCES: EffectivePromptRepositorySource[] = [
  {
    repository: "acme/api",
    path: "AGENTS.md",
    content: "Run `pnpm test src/auth` before committing. Never log tokens.",
  },
  {
    repository: "acme/api",
    path: "catalog:rules",
    content: "Changes to src/auth need a regression test.",
    version: 3,
  },
];

export const GOLDEN_FIX_INPUT: Omit<FixContextInput, "ticket"> = {
  prComments: [
    { author: "Piotr", body: "Changes requested: see the thread on session.ts.", liked: false },
  ],
  failedChecks: [
    { name: "unit", status: "completed", conclusion: "failure", logs: "session.test.ts: expected 200, got 401" },
    { name: "lint", status: "completed", conclusion: "success" },
  ],
  reviewResults: [
    {
      decision: "request_changes",
      findings: [
        {
          file: "src/auth/session.ts",
          description: "The refresh path ignores the previous key.",
          severity: "Blocker",
        } as never,
      ],
    },
  ],
  conflictRepositories: ["github:acme/api"],
  repositories: [api],
  workspaceManifest: GOLDEN_MANIFEST,
  reviewThreads: GOLDEN_REVIEW_FEED,
};

export const GOLDEN_DISCOVERY_TICKET = {
  id: "10512",
  identifier: "AIW-512",
  projectKey: "AIW",
  title: GOLDEN_TICKET.title,
  description: GOLDEN_TICKET.description,
  acceptanceCriteria: GOLDEN_TICKET.acceptanceCriteria,
  comments: GOLDEN_TICKET.comments,
  labels: ["auth"],
};

export const GOLDEN_DISCOVERY = {
  catalog: [
    {
      provider: "github" as const,
      repoPath: "acme/api",
      name: "api",
      defaultBranch: "main",
      description: "Public API and session service.",
      topics: ["api", "auth"],
      relationships: ["github:acme/web is the frontend for this repository (enabled)"],
      usable: true,
    },
    {
      provider: "github" as const,
      repoPath: "acme/web",
      name: "web",
      defaultBranch: "main",
      description: "Web client.",
      topics: ["frontend"],
      relationships: [],
      usable: true,
    },
  ],
  mandatoryRepositories: [] as SelectedRepository[],
};

export const GOLDEN_GENERIC = {
  blockPrompt:
    "Summarize ticket {{data:steps.entry.output.ticket.key}} for the on-call engineer and list the next three steps.",
  resolvedInputs: {
    plan: GOLDEN_PLAN,
    severity: "high",
  },
  clarificationAnswer: "Focus on the web client; mobile is out of scope for this summary.",
  entryOutput: { status: "fired", ticket: { key: "AIW-512" } },
};
