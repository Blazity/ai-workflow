/**
 * What the four repository-working sends are told about repositories.
 *
 * The map is one renderer, but "one renderer" was true of the function and
 * false of what reached the model: research was handed the pull request
 * contexts, implementation both lists, review only the selected repositories,
 * and the fix agent only the checkout paths. These tests observe the seam where
 * it matters, the text each send actually receives.
 */
import { describe, expect, it } from "vitest";
import { joinPromptParts, type EffectivePromptPart } from "@shared/prompts";
import type { RepositoryMapContext } from "../repository-map/map.js";
import {
  fixContextParts,
  implementationContextParts,
  researchPlanContextParts,
  reviewContextParts,
} from "./context.js";
import type { WorkspaceManifest } from "./repo-workspace.js";

/** The compiler cuts one prompt section at this many characters, FROM THE END,
 *  which is where our own rules sit (`packages/prompts/effective-prompt.ts`). */
const MAX_SECTION_LENGTH = 200_000;

const TICKET = {
  identifier: "AWP-1",
  title: "Refund webhooks drop the last event",
  description: "Something in github:acme/api drops the last webhook of a batch.",
  acceptanceCriteria: "No event is dropped.",
  comments: [],
};

const API = { provider: "github" as const, repoPath: "acme/api", defaultBranch: "main" };

const SELECTED = [{ ...API, selectedRationale: "The ticket text names this repository path." }];

const MANIFEST: WorkspaceManifest = {
  version: 2,
  repositories: [
    {
      ...API,
      slug: "github__acme__api",
      localPath: "/vercel/sandbox/repos/github__acme__api",
      branchName: "ai/awp-1",
      access: "write",
      selectedRationale: "The ticket text names this repository path.",
    },
  ],
};

function mapContext(over: Partial<RepositoryMapContext> = {}): RepositoryMapContext {
  return {
    repositories: [
      {
        key: "github:acme/api",
        catalogDescription: "The payments API. It owns the ledger and the webhook fan-out.",
        relationships: [
          { kind: "backend_for", targetKey: "github:acme/web", direction: "outgoing" },
        ],
        enabled: true,
        usable: true,
      },
      {
        key: "github:acme/web",
        catalogDescription: "The customer dashboard.",
        enabled: true,
        usable: true,
      },
    ],
    namedKeys: ["github:acme/api"],
    catalogActivated: true,
    ...over,
  };
}

/**
 * Exactly the map's own parts, so a difference between two sends is a
 * difference in the map rather than in the rest of the prompt.
 *
 * Trailing whitespace is normalized because the composer attaches the blank
 * line BETWEEN two sections to the part before it, so whichever part happens to
 * be last in one send carries a newline it does not carry in another. That is
 * the prompt's frame, not the map.
 */
function mapParts(parts: EffectivePromptPart[]): Array<[string, string]> {
  return parts
    .filter((part) => part.id.startsWith("repository-map"))
    .map((part) => [part.id, part.content.trimEnd()]);
}

function researchParts(map?: RepositoryMapContext): EffectivePromptPart[] {
  return researchPlanContextParts({
    ticket: TICKET,
    prompt: "",
    branchName: "ai/awp-1",
    selectedRepositories: SELECTED,
    workspaceManifest: MANIFEST,
    ...(map ? { repositoryMap: map } : {}),
  });
}

function implementationParts(map?: RepositoryMapContext): EffectivePromptPart[] {
  return implementationContextParts({
    ticket: TICKET,
    prompt: "",
    researchPlanMarkdown: "plan",
    selectedRepositories: SELECTED,
    workspaceManifest: MANIFEST,
    ...(map ? { repositoryMap: map } : {}),
  });
}

function reviewParts(map?: RepositoryMapContext): EffectivePromptPart[] {
  return reviewContextParts({
    ticket: TICKET,
    prompt: "",
    researchPlanMarkdown: "plan",
    selectedRepositories: SELECTED,
    workspaceManifest: MANIFEST,
    ...(map ? { repositoryMap: map } : {}),
  });
}

function fixParts(map?: RepositoryMapContext): EffectivePromptPart[] {
  return fixContextParts({
    ticket: TICKET,
    prComments: [],
    failedChecks: [],
    repositories: SELECTED,
    workspaceManifest: MANIFEST,
    ...(map ? { repositoryMap: map } : {}),
  });
}

describe("the repository map in every send", () => {
  it("describes the same repositories the same way for research, implementation, review and the fix agent", () => {
    const map = mapContext();
    const research = mapParts(researchParts(map));
    expect(research.length).toBeGreaterThan(0);
    expect(mapParts(implementationParts(map))).toEqual(research);
    expect(mapParts(reviewParts(map))).toEqual(research);
    expect(mapParts(fixParts(map))).toEqual(research);
  });

  it("tells every send the operator's words and the relationship", () => {
    for (const parts of [researchParts, implementationParts, reviewParts, fixParts]) {
      const text = joinPromptParts(parts(mapContext()));
      expect(text).toContain(
        "What it is: The payments API. It owns the ledger and the webhook fan-out.",
      );
      expect(text).toContain("is the backend for `github:acme/web`");
      expect(text).toContain("The customer dashboard.");
    }
  });

  it("says the map was not available rather than showing an empty catalog", () => {
    const text = joinPromptParts(researchParts());
    expect(text).toContain("The repository map was not available for this send");
    // And still says where the workspace is, which is what the prompt always had.
    expect(text).toContain("`github:acme/api` at `/vercel/sandbox/repos/github__acme__api` (write)");
  });

  it("keeps our own rules a platform part, so a reader can tell them from the catalog", () => {
    const parts = researchParts(mapContext());
    const rules = parts.filter(
      (part) => part.id.startsWith("repository-map") && part.origin.kind === "platform",
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.map((part) => part.content).join("")).toContain(
      "Only a repository marked (write) may be changed",
    );
    const facts = parts.filter(
      (part) => part.id.startsWith("repository-map") && part.origin.kind === "repository_catalog",
    );
    expect(facts.length).toBeGreaterThan(0);
  });
});

describe("a catalog large enough to cut the prompt", () => {
  /** One repository wired to 150 neighbours, each carrying a 5 KB description.
   *  Nothing in the contract forbids this shape, and before the map was bounded
   *  it would have pushed the section past its cap. */
  const wide = (): RepositoryMapContext => {
    const neighbours = Array.from({ length: 150 }, (_, index) => ({
      key: `github:acme/neighbour-${String(index).padStart(3, "0")}`,
      catalogDescription: "x".repeat(5 * 1024),
      enabled: true,
      usable: true,
    }));
    return {
      repositories: [
        {
          key: "github:acme/api",
          catalogDescription: "y".repeat(5 * 1024),
          relationships: neighbours.map((neighbour) => ({
            kind: "depends_on" as const,
            targetKey: neighbour.key,
            direction: "outgoing" as const,
          })),
          enabled: true,
          usable: true,
        },
        ...neighbours,
      ],
      namedKeys: ["github:acme/api"],
      catalogActivated: true,
    };
  };

  it("leaves our last platform rule inside the section the compiler keeps", () => {
    const parts = researchParts(wide());
    const text = joinPromptParts(parts);
    const last = [...parts].reverse().find((part) => part.origin.kind === "platform");
    expect(last?.id).toBe("resolution-check");
    expect(text).toContain("## Resolution Check");
    // The compiler slices a section at MAX_SECTION_LENGTH, so a rule that sits
    // past that index is a rule the agent never receives.
    expect(text.indexOf("## Resolution Check")).toBeLessThan(MAX_SECTION_LENGTH);
    expect(text.length).toBeLessThan(MAX_SECTION_LENGTH);
  });

  it("still names the neighbourhood and says how many it left out", () => {
    const text = joinPromptParts(researchParts(wide()));
    expect(text).toContain("`github:acme/neighbour-000`");
    expect(text).toMatch(/\d+ further repositories are in the catalog and not listed here\./);
  });
});

describe("a settled repository the budget cannot list", () => {
  /** Two hundred repositories a person excluded from this work, which is the
   *  shape a long-lived ticket on a large catalog reaches. */
  const manyExcluded = (): RepositoryMapContext => {
    const excluded = Array.from({ length: 200 }, (_, index) => ({
      key: `github:acme/old-${String(index).padStart(3, "0")}`,
      catalogDescription: "A service nobody works on any more.",
      enabled: true,
      usable: true,
    }));
    return {
      repositories: [
        { key: "github:acme/api", catalogDescription: "The payments API.", enabled: true, usable: true },
        ...excluded,
      ],
      entries: excluded.map((repository) => ({
        repositoryKey: repository.key,
        state: "excluded" as const,
        origin: "person" as const,
        rationale: "Out of scope for this work.",
        decidedBy: { kind: "person" as const, actorId: "u1", actorLabel: "Ada" },
        decidedAt: "2026-09-01T10:00:00.000Z",
      })),
      namedKeys: ["github:acme/api"],
      catalogActivated: true,
      expansionOpen: true,
    };
  };

  it("never advertises a repository somebody excluded as one the agent may ask for", () => {
    const text = joinPromptParts(researchParts(manyExcluded()));
    const listed = [...text.matchAll(/- `(github:acme\/old-\d{3})`/g)].map((match) => match[1]);
    // Whatever the budget can afford, the ones it cannot are counted under
    // their OWN sentence. The catalog's closing line is an invitation, and
    // extending it to a repository a person excluded is how the run pays a
    // pass to be told no.
    const unlisted = 200 - listed.length;
    expect(unlisted).toBeGreaterThan(0);
    expect(text).toContain(
      `${unlisted} further repositories were already decided for this work and did not fit here.`,
    );
    expect(text).toContain("do not request them.");
    const catalogClosing = /(\d+) further repositor(?:y is|ies are) in the catalog and not listed here/.exec(text);
    // If the catalog's own closing line appears at all, it must not be counting
    // the excluded ones in with the repositories it invites a request for.
    if (catalogClosing) expect(Number(catalogClosing[1])).toBeLessThan(unlisted);
  });

  it("still describes the neighbourhood when the settled group is enormous", () => {
    const context = manyExcluded();
    const text = joinPromptParts(
      researchParts({
        ...context,
        repositories: [
          {
            key: "github:acme/api",
            catalogDescription: "The payments API.",
            relationships: [
              { kind: "backend_for", targetKey: "github:acme/web", direction: "outgoing" },
            ],
            enabled: true,
            usable: true,
          },
          { key: "github:acme/web", catalogDescription: "The customer dashboard.", enabled: true, usable: true },
          ...context.repositories!.slice(1),
        ],
      }),
    );
    // The point of this map is the neighbour the agent would otherwise spend a
    // pass looking for. Two hundred exclusions must not swallow it, and it must
    // arrive with its reason and its relationship, not as a bare key.
    expect(text).toContain("### Related to this work, not in the workspace");
    expect(text).toContain("- `github:acme/web`");
    expect(text).toContain("Why it is here: `github:acme/api` is the backend for `github:acme/web`.");
    expect(text).toContain("What it is: The customer dashboard.");
  });
});

describe("a ticket large enough to fill the section on its own", () => {
  /** 191,000 characters of ticket description: a pasted log, a stack trace, a
   *  support thread. Nothing refuses it, and with the map rendered before our
   *  rules it was enough to delete the Resolution Check. */
  const hugeTicket = { ...TICKET, description: "d".repeat(191_000) };

  /** And a catalog big enough that the map would fill its own 16,000 character
   *  ceiling if nothing told it what the rest of the prompt had already spent.
   *  A small map on a huge ticket happens to fit, which is why the first
   *  version of this test passed with the rule removed. */
  const wideCatalog = (): RepositoryMapContext => {
    const neighbours = Array.from({ length: 150 }, (_, index) => ({
      key: `github:acme/neighbour-${String(index).padStart(3, "0")}`,
      catalogDescription: "A service in the estate. ".repeat(6),
      enabled: true,
      usable: true,
    }));
    return {
      repositories: [
        {
          key: "github:acme/api",
          catalogDescription: "The payments API.",
          relationships: neighbours.map((neighbour) => ({
            kind: "depends_on" as const,
            targetKey: neighbour.key,
            direction: "outgoing" as const,
          })),
          enabled: true,
          usable: true,
        },
        ...neighbours,
      ],
      namedKeys: ["github:acme/api"],
      catalogActivated: true,
      expansionOpen: true,
    };
  };

  const partsFor = (map?: RepositoryMapContext) =>
    researchPlanContextParts({
      ticket: hugeTicket,
      prompt: "",
      branchName: "ai/awp-1",
      selectedRepositories: SELECTED,
      workspaceManifest: MANIFEST,
      ...(map ? { repositoryMap: map } : {}),
    });

  it("gives up its own bytes rather than the rules that follow it", () => {
    const withoutMap = joinPromptParts(partsFor());
    const withMap = joinPromptParts(partsFor(wideCatalog()));
    // Both rules survive the compiler's slice, which is the only thing that
    // matters: a bounded map that still pushes the section over the cap deletes
    // our last rule and nothing turns red.
    for (const text of [withoutMap, withMap]) {
      expect(text.length).toBeLessThanOrEqual(MAX_SECTION_LENGTH);
      expect(text.indexOf("## Repository Access Protocol")).toBeGreaterThan(-1);
      expect(text.indexOf("## Repository Access Protocol")).toBeLessThan(MAX_SECTION_LENGTH);
      expect(text.indexOf("## Resolution Check")).toBeGreaterThan(-1);
      expect(text.indexOf("## Resolution Check")).toBeLessThan(MAX_SECTION_LENGTH);
    }
  });

  it("keeps the workspace and a count rather than vanishing", () => {
    const text = joinPromptParts(partsFor(wideCatalog()));
    // Whatever the map can afford, it never becomes silence: "why did it not
    // look at my repository" has to have an answer in the prompt.
    expect(text).toContain("## Repositories");
    expect(text).toContain("github:acme/api");
  });

  it("still says where the workspace is when there is no room for anything else", () => {
    // A ticket that fills the section on its own leaves the map nothing, not
    // even its own frame. The workspace list is what the prompt carried before
    // this map existed, so losing it here would make the map a REGRESSION on
    // exactly the runs that most need help: an agent that does not know which
    // checkout it is standing in cannot start.
    const text = joinPromptParts(
      researchPlanContextParts({
        ticket: { ...TICKET, description: "d".repeat(199_000) },
        prompt: "",
        branchName: "ai/awp-1",
        selectedRepositories: SELECTED,
        workspaceManifest: MANIFEST,
        repositoryMap: wideCatalog(),
      }),
    );
    expect(text).toContain("## Repositories");
    expect(text).toContain("### In the workspace");
    expect(text).toContain("`github:acme/api`");
  });
});

describe("a send with no way to ask for a repository", () => {
  it("does not tell a review agent it may request one", () => {
    const text = joinPromptParts(reviewParts(mapContext()));
    expect(text).not.toContain("you may request it");
    expect(text).not.toContain("request one of these only when");
    expect(text).toContain("this phase cannot attach them");
  });

  it("tells a research pass with the expansion open that it may", () => {
    const text = joinPromptParts(researchParts({ ...mapContext(), expansionOpen: true }));
    expect(text).toContain("request one of these only when you can name the logic you could not find");
  });

  it("tells a research pass whose expansion has closed that it may not", () => {
    const text = joinPromptParts(researchParts(mapContext()));
    expect(text).toContain("this phase cannot attach them");
    expect(text).not.toContain("you may request it");
  });
});

describe("a run whose catalog read failed", () => {
  const unreadable = (): RepositoryMapContext => ({
    repositories: [
      {
        key: "github:acme/api",
        providerDescription: "acme/api on GitHub",
        enabled: true,
        usable: true,
      },
    ],
    namedKeys: ["github:acme/api"],
    catalogActivated: true,
    silence: "catalog_unreadable",
    relationshipsUnreadable: true,
  });

  it("does not tell the operator nobody wrote a description", () => {
    const text = joinPromptParts(researchParts(unreadable()));
    // Somebody may have written three paragraphs on the Repositories page. We
    // could not read the row, so we cannot say they did not.
    expect(text).not.toContain("nobody here wrote a description");
    expect(text).toContain("the catalog could not be read on this run");
  });

  it("says what it could not read before the list it qualifies, not after", () => {
    const text = joinPromptParts(researchParts(unreadable()));
    const note = text.indexOf("The repository catalog could not be read for this run");
    const firstGroup = text.indexOf("### In the workspace");
    expect(note).toBeGreaterThan(-1);
    expect(firstGroup).toBeGreaterThan(-1);
    expect(note).toBeLessThan(firstGroup);
    expect(text).toContain("The repository relationships could not be read for this run");
  });
});
