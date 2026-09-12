/**
 * The exact words the expansion refusals use (matrix rows R06, R08, R09, R10).
 *
 * `runner.test.ts` next door proves the DECISIONS: which branch each input
 * reaches, and that the round limit wins over the already-attached no-op. What
 * it mostly does not pin is the TEXT, and the text is the whole product here:
 * every one of these refusals is rendered into a Jira clarification a person
 * reads and answers. A branch that is reached with the wrong sentence is a run
 * parked on a question nobody can act on.
 *
 * Asserted with `toContain` on the stable half of each sentence rather than
 * `toBe` on the whole: these strings are edited (a parallel lane is appending a
 * sentence to one of them right now), and a test that breaks on every wording
 * change gets its expectation pasted over rather than read. What must not move
 * without somebody noticing is the part that tells the reader what went wrong
 * and what to send back.
 *
 * Pure functions, no database, no mocks: the runner imports nothing but types
 * and one key helper, which is why its refusals are cheap to pin at all.
 */
import { describe, expect, it } from "vitest";
import {
  EXPANSION_LIMIT_CLARIFICATION_PREFIX,
  isExpansionLimitClarification,
  validateRepositoryExpansionRequests,
} from "./runner.js";
import type { RepositoryCatalogEntry } from "./catalog.js";

function entry(
  repoPath: string,
  overrides: Partial<RepositoryCatalogEntry> = {},
): RepositoryCatalogEntry {
  return {
    provider: "github",
    repoPath,
    name: repoPath.split("/").at(-1) ?? repoPath,
    defaultBranch: "main",
    description: "",
    topics: [],
    usable: true,
    ...overrides,
  };
}

function request(repoPath: string, provider: "github" | "gitlab" = "github") {
  return { provider, repoPath, rationale: "needs it" };
}

/** The questions a clarification decision carries, or a failure naming what
 *  came back instead. */
function questionsOf(
  decision: ReturnType<typeof validateRepositoryExpansionRequests>,
): string[] {
  if (decision.kind !== "clarification_needed") {
    throw new Error(`expected a clarification, got ${decision.kind}`);
  }
  return decision.questions;
}

describe("a repository research named that the catalog cannot reach", () => {
  it("R06: asks which accessible repository to use, naming the one it could not get", () => {
    const decision = validateRepositoryExpansionRequests({
      requests: [request("acme/nope")],
      catalog: [entry("acme/api")],
      attached: [],
      completedRounds: 0,
    });

    // Names the repository, says why, and asks a question with an answer. The
    // provider prefix is part of it: a bare "acme/nope" would not tell a reader
    // which installation was asked.
    expect(questionsOf(decision)[0]).toContain(
      "Research requested unavailable repository github:acme/nope",
    );
    expect(questionsOf(decision)[0]).toContain(
      "Which accessible repository should be used?",
    );
  });

  it("R06: a repository that IS in the catalog but is not usable takes the same path", () => {
    // The branch is `!repository?.usable`, so a catalog miss and an entry the
    // directory marked unusable produce the same sentence. Worth pinning
    // separately: the second case is a repository an operator can SEE on the
    // Repositories page, and being told it is "unavailable" is only fair if the
    // reason is discoverable elsewhere (the entry carries `unusableReason`).
    const decision = validateRepositoryExpansionRequests({
      requests: [request("acme/api")],
      catalog: [entry("acme/api", { usable: false, unusableReason: "missing_default_branch" })],
      attached: [],
      completedRounds: 0,
    });

    expect(questionsOf(decision)[0]).toContain(
      "Research requested unavailable repository github:acme/api",
    );
  });
});

describe("more repositories than one round may attach", () => {
  it("R08: names the 3-per-round bound and asks which 3 matter", () => {
    const catalog = ["acme/a", "acme/b", "acme/c", "acme/d"].map((path) => entry(path));

    const decision = validateRepositoryExpansionRequests({
      requests: catalog.map((candidate) => request(candidate.repoPath)),
      catalog,
      attached: [],
      completedRounds: 0,
    });

    // The number is in the sentence, because "too many" without the bound
    // cannot be answered in one reply.
    expect(questionsOf(decision)[0]).toContain(
      "Research requested more than 3 repositories in one round",
    );
    expect(questionsOf(decision)[0]).toContain("Which 3 are essential?");
  });

  it("R08: the bound counts requests, not fresh repositories", () => {
    // Four requests, three of them already attached. The round check runs
    // BEFORE the already-attached filter, so this is still a refusal, and a
    // reader is asked to pick 3 out of a set that mostly did not need
    // attaching. Pinned as it behaves, not as it reads: the alternative
    // (filter first, then count) would let a planner walk the workspace up
    // three at a time while asking for four.
    const catalog = ["acme/a", "acme/b", "acme/c", "acme/d"].map((path) => entry(path));

    const decision = validateRepositoryExpansionRequests({
      requests: catalog.map((candidate) => request(candidate.repoPath)),
      catalog,
      attached: [
        { provider: "github", repoPath: "acme/a" },
        { provider: "github", repoPath: "acme/b" },
        { provider: "github", repoPath: "acme/c" },
      ],
      completedRounds: 0,
    });

    expect(questionsOf(decision)[0]).toContain("more than 3 repositories in one round");
  });
});

describe("the 8-repository workspace ceiling", () => {
  it("R09: names the ceiling when the attach would cross it", () => {
    // Seven attached plus two fresh. The per-round bound is not the one that
    // refuses this; the workspace total is, and it is checked last, after the
    // fresh set is resolved.
    const catalog = [entry("acme/h"), entry("acme/i")];
    const attached = ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({
      provider: "github" as const,
      repoPath: `acme/${name}`,
    }));

    const decision = validateRepositoryExpansionRequests({
      requests: catalog.map((candidate) => request(candidate.repoPath)),
      catalog,
      attached,
      completedRounds: 0,
    });

    expect(questionsOf(decision)[0]).toContain(
      "would exceed the 8-repository workspace limit",
    );
    expect(questionsOf(decision)[0]).toContain("Which repositories are essential?");
    // Not the round refusal: two requests is inside the per-round bound, so a
    // reader told to "pick 3" here would be given the wrong instruction.
    expect(questionsOf(decision)[0]).not.toContain("more than 3 repositories");
  });

  it("R09: exactly 8 is allowed, 9 is not", () => {
    const attached = ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({
      provider: "github" as const,
      repoPath: `acme/${name}`,
    }));

    const atTheLimit = validateRepositoryExpansionRequests({
      requests: [request("acme/h")],
      catalog: [entry("acme/h")],
      attached,
      completedRounds: 0,
    });
    expect(atTheLimit.kind).toBe("attach");

    const overIt = validateRepositoryExpansionRequests({
      requests: [request("acme/h"), request("acme/i")],
      catalog: [entry("acme/h"), entry("acme/i")],
      attached,
      completedRounds: 0,
    });
    expect(overIt.kind).toBe("clarification_needed");
  });
});

describe("the third expansion round", () => {
  it("R10: refuses with the prefix, the answer format, and the ceiling that still applies", () => {
    const decision = validateRepositoryExpansionRequests({
      requests: [request("acme/api")],
      catalog: [entry("acme/api")],
      attached: [],
      completedRounds: 2,
    });

    const question = questionsOf(decision)[0] ?? "";
    expect(question).toContain(EXPANSION_LIMIT_CLARIFICATION_PREFIX);
    // The three things a reader needs to answer it: how to spell a repository,
    // that only catalog repositories can be attached, and that the workspace
    // ceiling has not gone away because the rounds ran out.
    expect(question).toContain('"github:owner/repo"');
    expect(question).toContain("Only repositories on the accessible catalog can be attached");
    expect(question).toContain("8-repository workspace limit still applies");
    // The recognizer the caller uses to tell this clarification from every
    // other one has to agree with the text that was actually produced.
    expect(isExpansionLimitClarification(questionsOf(decision))).toBe(true);
  });

  it("R10: asks again on a third round even when the only repository is already attached", () => {
    // The T32 loop, pinned as it behaves. A round-2 request naming a repository
    // that is ALREADY attached would be reported as the `already_attached`
    // no-op; past the round limit the limit check runs first, so the same
    // request becomes a question the operator has no new answer to. Answering
    // it does not advance `completedRounds`, which is why production saw the
    // run ask in circles.
    const attachedOnly = validateRepositoryExpansionRequests({
      requests: [request("acme/api")],
      catalog: [entry("acme/api")],
      attached: [{ provider: "github", repoPath: "acme/api" }],
      completedRounds: 1,
    });
    expect(attachedOnly.kind).toBe("already_attached");

    const pastTheLimit = validateRepositoryExpansionRequests({
      requests: [request("acme/api")],
      catalog: [entry("acme/api")],
      attached: [{ provider: "github", repoPath: "acme/api" }],
      completedRounds: 2,
    });
    expect(pastTheLimit.kind).toBe("clarification_needed");
    expect(isExpansionLimitClarification(questionsOf(pastTheLimit))).toBe(true);
  });
});
