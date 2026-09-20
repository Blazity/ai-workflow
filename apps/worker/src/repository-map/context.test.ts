/**
 * THE SEAM NOTHING CROSSED: a pre-sandbox result, through the run's context,
 * into the text a research pass actually receives.
 *
 * The map builder had tests, the prompt composer had tests, and on a real run
 * the agent was told "the repository map was not available for this send" on
 * every one of them. Both halves were green because nothing joined them: the
 * run read its map into a local before the workspace step had assigned it, and
 * a value read too early is not a value a unit test of either half can see.
 *
 * So these start where the run starts, from the object
 * `engine/blocks/prepare-workspace/execute.ts` puts on the context, and finish
 * at the bytes `sandbox/context.ts` composes.
 */
import { describe, expect, it } from "vitest";
import { joinPromptParts } from "@shared/prompts";
import type { WorkScopeEntry } from "@shared/contracts";
import { repositoryMapContext, type RepositoryMapRunFacts } from "./context.js";
import { researchPlanContextParts } from "../sandbox/context.js";

const API = "github:acme/api";
const WEB = "github:acme/web";
const OPS = "github:acme/ops";

const TICKET = {
  identifier: "AWP-1",
  title: "Refunds drop the last webhook",
  description: `Something in ${API} drops the last webhook of a batch.`,
  acceptanceCriteria: "No event is dropped.",
  comments: [],
};

const SELECTED = [
  {
    provider: "github" as const,
    repoPath: "acme/api",
    defaultBranch: "main",
    selectedRationale: "The ticket text names this repository path.",
  },
];

/**
 * What `repoSelectionStep` returns and `ensureWorkspace` assigns, as the real
 * shapes: the catalog profiles it read, with the operator's descriptions and
 * the relationships.
 */
const PRE_SANDBOX_REPOSITORY_MAP = {
  repositories: [
    {
      key: API,
      catalogDescription: "The payments API. It owns the ledger and the webhook fan-out.",
      relationships: [
        { kind: "backend_for", targetKey: WEB, direction: "outgoing" as const },
      ],
      enabled: true,
      usable: true,
    },
    { key: WEB, catalogDescription: "The customer dashboard.", enabled: true, usable: true },
    { key: OPS, catalogDescription: "The deployment pipelines.", enabled: true, usable: true },
  ],
};

function runFacts(over: Partial<RepositoryMapRunFacts> = {}): RepositoryMapRunFacts {
  return {
    repositoryMap: PRE_SANDBOX_REPOSITORY_MAP,
    workScopeTicketText: { matchedKeys: [API] },
    repositories: { activated: true },
    ...over,
  };
}

function researchText(facts: RepositoryMapRunFacts, input: Parameters<typeof repositoryMapContext>[1]) {
  const map = repositoryMapContext(facts, input);
  return joinPromptParts(
    researchPlanContextParts({
      ticket: TICKET,
      prompt: "",
      branchName: "ai/awp-1",
      selectedRepositories: SELECTED,
      ...(map ? { repositoryMap: map } : {}),
    }),
  );
}

describe("what a research pass is told after the pre-sandbox has run", () => {
  it("receives the map, with the neighbourhood the catalog knows about", () => {
    const text = researchText(runFacts(), { expansionOpen: true });
    expect(text).toContain("## Repositories");
    expect(text).toContain("### In the workspace");
    expect(text).toContain("### Related to this work, not in the workspace");
    expect(text).toContain("- `github:acme/web`");
    expect(text).toContain("Why it is here: `github:acme/api` is the backend for `github:acme/web`.");
    // The sentence that reached every real send before this: it must not be
    // here, because the map IS here.
    expect(text).not.toContain("The repository map was not available for this send");
  });

  it("says the map was not available only when the run really holds none", () => {
    const text = researchText(runFacts({ repositoryMap: null }), { expansionOpen: true });
    expect(text).toContain("The repository map was not available for this send");
  });
});

describe("what the pass after a refusal is told", () => {
  /** The two arrays the planning loop grows while the block runs. The run
   *  holds them exactly like this; the point of the test is that the prompt is
   *  built FROM them at each send rather than once before the first. */
  const leftOut: Array<{ repositoryKey: string; reason: string }> = [];
  const refusals: Array<{ repositoryKey: string; reason: "rounds_exhausted" | "request_limit" }> =
    [];

  it("stops inviting a request for the repository the run just refused", () => {
    const first = researchText(runFacts(), { expansionOpen: true, leftOut, refusals });
    expect(first).toContain("- `github:acme/ops`");
    expect(first).toContain("you may request it");

    // Pass one asks for `ops` and the run refuses it for good.
    leftOut.push({
      repositoryKey: OPS,
      reason: "This run has used every repository round it had, so github:acme/ops was not added.",
    });
    refusals.push({ repositoryKey: OPS, reason: "rounds_exhausted" });

    const second = researchText(runFacts(), { expansionOpen: true, leftOut, refusals });
    expect(second).not.toEqual(first);
    expect(second).toContain("### Already decided, do not request these");
    expect(second).toContain(
      "- `github:acme/ops` - this run already refused a request for it, do not request it again",
    );
    // And the record's own sentence, so the model reads why rather than only no.
    expect(second).toContain("This run has used every repository round it had");
  });

  it("leaves a repository requestable when the refusal was about the request, not the repository", () => {
    // "You asked for four at once" refuses this request and nothing else.
    // Closing the door here would be the same lie pointing the other way, and
    // the model would stop asking for a repository it may still have.
    const text = researchText(runFacts(), {
      expansionOpen: true,
      leftOut: [
        {
          repositoryKey: OPS,
          reason: "More than 3 repositories were requested at once, so github:acme/ops was left for a later pass.",
        },
      ],
      refusals: [{ repositoryKey: OPS, reason: "request_limit" }],
    });
    expect(text).not.toContain("this run already refused a request for it");
    expect(text).toContain("- `github:acme/ops`");
  });
});

describe("one builder, so two sends cannot tell two stories", () => {
  it("gives the fix agent the same repository the question offered as research gets", () => {
    const facts = runFacts({
      workScopeAsk: { askedRepositories: [{ repositoryKey: WEB }] },
    });
    const research = repositoryMapContext(facts, { expansionOpen: true });
    const fix = repositoryMapContext(facts, { expansionOpen: false });
    // The hand-written copy the fix agent used to carry had lost `offeredKeys`
    // entirely, so this repository was `offered_by_question` on one send and a
    // plain catalog row on the other, on one run.
    expect(research?.offeredKeys).toEqual([WEB]);
    expect(fix?.offeredKeys).toEqual([WEB]);
  });

  it("carries the record's entries and the failed catalog read alike", () => {
    const entries: WorkScopeEntry[] = [
      {
        repositoryKey: OPS,
        state: "excluded",
        origin: "person",
        rationale: "Out of scope.",
        decidedBy: { kind: "person", actorId: "u1", actorLabel: "Ada" },
        decidedAt: "2026-09-01T10:00:00.000Z",
      },
    ];
    const context = repositoryMapContext(
      runFacts({
        repositoryMap: { ...PRE_SANDBOX_REPOSITORY_MAP, catalogUnreadable: true },
        workScope: { scope: { entries } },
      }),
      { expansionOpen: false },
    );
    expect(context?.entries).toEqual(entries);
    expect(context?.silence).toBe("catalog_unreadable");
  });
});
