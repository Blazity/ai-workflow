import { describe, expect, it } from "vitest";
import { WORK_SCOPE_REFUSAL_REASONS, type WorkScopeRefusalReason } from "@shared/contracts";
import { REQUEST_REPOSITORIES_MAX } from "./decide.js";
import {
  MAX_WORKSPACE_REPOSITORIES,
  workScopeCommentSaidNoSentence,
  workScopeRefusalParts,
  workScopeRefusalSentence,
  workScopeUnnamedSentence,
  type WorkScopeRefusalSurface,
} from "./refusal-sentence.js";

/**
 * The defect this module exists to end: the same fact about the same repository
 * was composed twice, once for the run start and once for the mid run
 * expansion, and the two copies disagreed on FACTS. Only one named who excluded
 * a repository and when; one spelled the workspace cap as a word while the
 * other interpolated the constant.
 *
 * So every test below asserts the same shape: the WHY is identical on both
 * surfaces, the consequence clause is the only thing that differs, and neither
 * sentence carries a way back, because a way back is addressed to a person and
 * these sentences reach the model.
 */
const KEY = "github:acme/api";
const PERSON = { kind: "person" as const, actorId: "p-1", actorLabel: "Ada Lovelace" };
const DECISION = { decidedBy: PERSON, decidedAt: "2026-09-10T08:30:00.000Z" };

const SURFACES: WorkScopeRefusalSurface[] = ["run_start", "expansion"];

/**
 * Every reason, and the compiler enforces the list.
 *
 * A `Record` keyed by the contract's union: a member added to
 * `WorkScopeRefusalReason` without a line here does not compile, and the
 * runtime check below proves the contract's own list and this one hold the same
 * members, so the map cannot fall behind by carrying a stale key instead.
 */
const REASONS: Record<WorkScopeRefusalReason, true> = {
  outside_catalog: true,
  outside_policy: true,
  unusable: true,
  excluded: true,
  unavailable: true,
  workspace_cap: true,
  request_limit: true,
  rounds_exhausted: true,
  unnamed_in_answer: true,
};

/**
 * What a way back looks like, asserted as concepts rather than as one phrase.
 *
 * Pinning a single sentence would let the next author move the way back into
 * the model's channel simply by rewording it, which is how
 * "Enable it on the Repositories page and start a new run." sat on the
 * expansion surface for as long as it did.
 */
const WAY_BACK_PATTERNS = [
  /not final/iu,
  /repositories page/iu,
  /start a new run/iu,
  /new run/iu,
  /changed list/iu,
  /change the list/iu,
  /changing the list/iu,
  /put it back/iu,
  /new ticket/iu,
  /ask (?:for it|again)/iu,
];

function partsOf(reason: WorkScopeRefusalReason, surface: WorkScopeRefusalSurface) {
  return workScopeRefusalParts({ repositoryKey: KEY, reason }, surface, DECISION);
}

describe("workScopeRefusalParts", () => {
  for (const reason of Object.keys(REASONS) as WorkScopeRefusalReason[]) {
    it(`says the same why on both surfaces for ${reason}, and differs only in the consequence`, () => {
      const runStart = partsOf(reason, "run_start");
      const expansion = partsOf(reason, "expansion");

      expect(runStart.why).toBe(expansion.why);
      // The one part a surface owns, and it really does differ: an assertion
      // that only pinned the equality above would pass on two identical
      // sentences that had lost the distinction entirely.
      expect(runStart.consequence).toBe("so the run started without it");
      expect(expansion.consequence).toBe("so it is not attached");
      expect(runStart.consequence).not.toBe(expansion.consequence);

      const runStartSentence = workScopeRefusalSentence(
        { repositoryKey: KEY, reason },
        "run_start",
        DECISION,
      );
      const expansionSentence = workScopeRefusalSentence(
        { repositoryKey: KEY, reason },
        "expansion",
        DECISION,
      );
      expect(runStartSentence).toContain(runStart.why);
      expect(expansionSentence).toContain(expansion.why);
      expect(runStartSentence).not.toBe(expansionSentence);
    });
  }

  it("renders a why for every member the contract holds", () => {
    // The map above is what the compiler checks; this is what stops the two
    // lists drifting apart at runtime, which a Record with a stale extra key
    // would otherwise allow.
    expect([...WORK_SCOPE_REFUSAL_REASONS].sort()).toEqual(Object.keys(REASONS).sort());

    for (const reason of WORK_SCOPE_REFUSAL_REASONS) {
      for (const surface of SURFACES) {
        const parts = workScopeRefusalParts({ repositoryKey: KEY, reason }, surface, DECISION);
        expect(parts.why.length).toBeGreaterThan(0);
        expect(parts.why).toContain(KEY);
        expect(parts.consequence.length).toBeGreaterThan(0);
      }
    }
  });

  it("puts every cap in the sentence as the constant's value and never as a word", () => {
    const cap = workScopeRefusalSentence(
      { repositoryKey: KEY, reason: "workspace_cap" },
      "run_start",
    );
    const request = workScopeRefusalSentence(
      { repositoryKey: KEY, reason: "request_limit" },
      "expansion",
    );

    expect(cap).toContain(String(MAX_WORKSPACE_REPOSITORIES));
    expect(request).toContain(String(REQUEST_REPOSITORIES_MAX));
    // The defect exactly: the run start used to say "eight" while the expansion
    // interpolated the constant, so moving the constant made one of them lie.
    // Whole words, so "another" is not read as a numeral.
    const spelled = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/iu;
    expect(cap).not.toMatch(spelled);
    expect(request).not.toMatch(spelled);
    expect(
      workScopeRefusalSentence({ repositoryKey: KEY, reason: "workspace_cap" }, "expansion"),
    ).toContain(String(MAX_WORKSPACE_REPOSITORIES));
  });
});

describe("workScopeRefusalSentence", () => {
  /**
   * The rule the whole module turns on, and the one a well meant edit breaks.
   *
   * These sentences reach the agent's instruction channel. A way back is
   * addressed to a person, has a channel of its own in `context.ts`, and says
   * there what a clause per reason cannot: that a repository can be excluded
   * AND unservable at once. A remedy appended here is that channel's fact,
   * said worse, to a reader who cannot act on it.
   */
  it("carries no way back on either surface, for any reason", () => {
    for (const reason of WORK_SCOPE_REFUSAL_REASONS) {
      for (const surface of SURFACES) {
        const sentence = workScopeRefusalSentence(
          { repositoryKey: KEY, reason },
          surface,
          DECISION,
        );
        // The positive control, so this cannot pass on an empty sentence.
        expect(sentence).toContain(KEY);
        expect(sentence.endsWith(".")).toBe(true);
        for (const pattern of WAY_BACK_PATTERNS) {
          expect(sentence).not.toMatch(pattern);
        }
      }
    }
  });

  it("names who excluded the repository and on what day, on both surfaces", () => {
    for (const surface of SURFACES) {
      const sentence = workScopeRefusalSentence(
        { repositoryKey: KEY, reason: "excluded" },
        surface,
        DECISION,
      );

      expect(sentence).toContain("Ada Lovelace");
      // The DAY, not the instant: a reader given a millisecond is invited to
      // reason about an hour nobody told them the timezone of.
      expect(sentence).toContain("on 2026-09-10,");
      expect(sentence).not.toContain("T08:30:00");
    }
  });

  it("names a run as the decider when a run made the decision", () => {
    const sentence = workScopeRefusalSentence(
      { repositoryKey: KEY, reason: "excluded" },
      "expansion",
      {
        decidedBy: { kind: "run", runId: "wrun_7", definitionId: 4, definitionVersion: 2 },
        decidedAt: "2026-09-10T08:30:00.000Z",
      },
    );

    expect(sentence).toContain("run wrun_7");
  });

  it("stays honest about the actor when the record holds no entry", () => {
    const sentence = workScopeRefusalSentence(
      { repositoryKey: KEY, reason: "excluded" },
      "run_start",
    );

    expect(sentence).toBe(
      "github:acme/api was excluded on this work, so the run started without it.",
    );
  });

  it("leaves a date it cannot read exactly as it found it", () => {
    const sentence = workScopeRefusalSentence(
      { repositoryKey: KEY, reason: "excluded" },
      "expansion",
      { decidedBy: PERSON, decidedAt: "last Tuesday" },
    );

    expect(sentence).toContain("on last Tuesday,");
  });
});

describe("workScopeUnnamedSentence", () => {
  // It reaches the model beside every refusal above, so the same rule binds it:
  // what happened, and no way back. The way back lives in `unnamedRecoveryNotes`.
  it("says what happened on both surfaces and carries no way back", () => {
    expect(workScopeUnnamedSentence(KEY, "run_start")).toBe(
      "github:acme/api was listed in a repository question already answered on this work" +
        " and is not selected on it, so the run started without it.",
    );
    expect(workScopeUnnamedSentence(KEY, "expansion")).toBe(
      "github:acme/api was listed in a repository question already answered on this work" +
        " and is not selected on it, so it is not attached.",
    );
    for (const surface of SURFACES) {
      for (const pattern of WAY_BACK_PATTERNS) {
        expect(workScopeUnnamedSentence(KEY, surface)).not.toMatch(pattern);
      }
    }
  });
});

describe("workScopeCommentSaidNoSentence", () => {
  // Joint gate round 3, C11r. The run stops reading a comment that says no
  // about a repository, so a repository named in one is left behind for a
  // reason no refusal reason covers: nothing is wrong with the repository. The
  // sentence goes where every refusal goes, the agent's prompt included, so it
  // carries what happened and no way back; the way back is the recovery note
  // in `context.ts`, which says what a comment has to look like.
  it("says a comment named it and carries no way back", () => {
    expect(workScopeCommentSaidNoSentence(KEY)).toBe(
      "github:acme/api is named in a ticket comment that also says no about a repository," +
        " so the run read nothing from that comment and started without it.",
    );
    for (const pattern of WAY_BACK_PATTERNS) {
      expect(workScopeCommentSaidNoSentence(KEY)).not.toMatch(pattern);
    }
  });

  // It says a comment named the repository and stops there. WHICH of the paths
  // in that comment the person meant to refuse is the one thing the reader
  // cannot tell, and a sentence that named this repository as the refused one
  // would tell the person they said something they did not.
  it("does not say this repository is the one the comment refused", () => {
    expect(workScopeCommentSaidNoSentence(KEY)).not.toMatch(/said no (?:to|about) github/iu);
    expect(workScopeCommentSaidNoSentence(KEY)).not.toMatch(/you (?:said|asked)/iu);
  });
});
