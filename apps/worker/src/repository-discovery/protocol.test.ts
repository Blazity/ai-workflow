import { describe, expect, it } from "vitest";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { RepositoryCatalogEntry } from "./catalog.js";
import { validateRepositoryDiscoveryResult } from "./protocol.js";

const catalog: RepositoryCatalogEntry[] = [
  {
    provider: "github",
    repoPath: "acme/app",
    name: "app",
    defaultBranch: "main",
    description: "Web application",
    topics: ["frontend"],
    usable: true,
  },
  {
    provider: "gitlab",
    repoPath: "group/shared",
    name: "shared",
    defaultBranch: "main",
    description: "Shared components",
    topics: [],
    usable: true,
  },
];

const mandatory: SelectedRepository[] = [
  {
    provider: "github",
    repoPath: "acme/app",
    defaultBranch: "main",
    selectedRationale: "PR trigger repository",
  },
];

describe("validateRepositoryDiscoveryResult", () => {
  it("accepts high-confidence catalog identities and force-includes mandatory repositories", () => {
    expect(validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "high",
      repositories: [
        {
          provider: "gitlab",
          repoPath: "GROUP/SHARED",
          rationale: "Ticket references shared UI primitives",
        },
      ],
      questions: null,
      error: null,
    }, catalog, mandatory)).toEqual({
      kind: "selected",
      repositories: [
        mandatory[0],
        {
          provider: "gitlab",
          repoPath: "group/shared",
          defaultBranch: "main",
          selectedRationale: "Ticket references shared UI primitives",
        },
      ],
      confidence: "high",
    });
  });

  it.each([
    ["low confidence", {
      status: "selected",
      confidence: "low",
      repositories: [{ provider: "github", repoPath: "acme/app", rationale: "guess" }],
      questions: null,
      error: null,
    }],
    ["unknown repository", {
      status: "selected",
      confidence: "high",
      repositories: [{ provider: "github", repoPath: "acme/secret", rationale: "guess" }],
      questions: null,
      error: null,
    }],
    ["duplicate identity", {
      status: "selected",
      confidence: "high",
      repositories: [
        { provider: "github", repoPath: "acme/app", rationale: "one" },
        { provider: "github", repoPath: "ACME/APP", rationale: "two" },
      ],
      questions: null,
      error: null,
    }],
    ["invalid schema", { status: "selected", confidence: "high", repositories: [] }],
  ])("falls back to clarification for %s", (_label, raw) => {
    expect(validateRepositoryDiscoveryResult(raw, catalog, [])).toMatchObject({
      kind: "clarification_needed",
    });
  });

  it("falls back to clarification when a high-confidence selection targets an unusable catalog repository", () => {
    // Archived repositories never reach the protocol (buildRepositoryCatalog drops
    // them, covered in catalog.test.ts). A repository with no default branch DOES
    // reach it, flagged usable:false, and must be rejected here rather than
    // attached.
    const catalogWithUnusable: RepositoryCatalogEntry[] = [
      ...catalog,
      {
        provider: "github",
        repoPath: "acme/uninitialized",
        name: "uninitialized",
        defaultBranch: "",
        description: "No default branch yet",
        topics: [],
        usable: false,
        unusableReason: "missing_default_branch",
      },
    ];
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            { provider: "github", repoPath: "acme/uninitialized", rationale: "guess" },
          ],
          questions: null,
          error: null,
        },
        catalogWithUnusable,
        [],
      ),
    ).toMatchObject({ kind: "clarification_needed" });
  });

  it("does not gate the allowlist itself; off-allowlist filtering happens downstream at attach and publish", () => {
    // The discovery protocol has no allowlist parameter, and the catalog handed to
    // it (buildRepositoryCatalog) is not allowlist-filtered, so an off-allowlist
    // repository present on the catalog is admitted here. It is blocked downstream
    // instead: at attachResearchRepositoriesStep (agent.ts, isRepoAllowed re-check
    // before any clone), in validateHumanRepositoryExpansion (isAllowed, covered in
    // runner.test.ts) for human answers, and again at push in the trusted workspace
    // publisher. This test documents that layering: selection is a catalog concern,
    // not an allowlist concern.
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            {
              provider: "github",
              repoPath: "acme/app",
              rationale: "on catalog; allowlist is enforced later, not here",
            },
          ],
          questions: null,
          error: null,
        },
        catalog,
        [],
      ),
    ).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/app" }],
    });
  });

  it("turns medium confidence into a clarification listing every proposed candidate", () => {
    const decision = validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "medium",
      repositories: [
        { provider: "github", repoPath: "acme/app", rationale: "ticket names the app" },
        { provider: "gitlab", repoPath: "group/shared", rationale: "shared UI primitives" },
      ],
      questions: null,
      error: null,
    }, catalog, []);
    expect(decision.kind).toBe("clarification_needed");
    if (decision.kind === "clarification_needed") {
      const [question] = decision.questions;
      expect(question).toContain("github:acme/app");
      expect(question).toContain("ticket names the app");
      expect(question).toContain("gitlab:group/shared");
      expect(question).toContain("shared UI primitives");
    }
  });

  it("keeps the proposed candidates in a low-confidence clarification", () => {
    const decision = validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "low",
      repositories: [
        { provider: "github", repoPath: "acme/app", rationale: "weak guess" },
      ],
      questions: null,
      error: null,
    }, catalog, []);
    expect(decision.kind).toBe("clarification_needed");
    if (decision.kind === "clarification_needed") {
      expect(decision.questions[0]).toContain("github:acme/app");
      expect(decision.questions[0]).toContain("weak guess");
    }
  });

  it("rejects more than three discovered repositories", () => {
    const largeCatalog = Array.from({ length: 4 }, (_, index) => ({
      ...catalog[0],
      repoPath: `acme/app-${index}`,
    }));
    expect(validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "medium",
      repositories: largeCatalog.map((entry) => ({
        provider: entry.provider,
        repoPath: entry.repoPath,
        rationale: "related",
      })),
      questions: null,
      error: null,
    }, largeCatalog, [])).toMatchObject({ kind: "clarification_needed" });
  });

  it("rejects a combined mandatory and discovered selection above three repositories", () => {
    const largeCatalog = Array.from({ length: 4 }, (_, index) => ({
      ...catalog[0],
      repoPath: `acme/app-${index}`,
    }));
    const required = largeCatalog.slice(0, 2).map((entry) => ({
      provider: entry.provider,
      repoPath: entry.repoPath,
      defaultBranch: entry.defaultBranch,
      selectedRationale: "workflow-owned branch",
    }));

    expect(validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "high",
      repositories: largeCatalog.slice(2).map((entry) => ({
        provider: entry.provider,
        repoPath: entry.repoPath,
        rationale: "related",
      })),
      questions: null,
      error: null,
    }, largeCatalog, required)).toMatchObject({ kind: "clarification_needed" });
  });
});
