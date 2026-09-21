import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  WORK_SCOPE_ASK_REASONS,
  WORK_SCOPE_ENTRY_STATES,
  WORK_SCOPE_ORIGINS,
  WORK_SCOPE_REFUSAL_REASONS,
  WORK_SCOPE_UNAVAILABLE_REASONS,
  repositoryKeySchema,
  resolveTriggerRepositoryPolicy,
  triggerRepositoryPolicySchema,
  validateTriggerRepositoryPolicy,
  WORK_SCOPE_ANSWER_READING_JSON_SCHEMA,
  workScopeAnswerOutcomeSchema,
  workScopeAskedRepositoriesSchema,
  workScopeAskReasonSchema,
  workScopeEditRequestSchema,
  workScopeQuestionAnswerSchema,
  workScopeEntrySchema,
  workScopeOriginRank,
  workScopeSchema,
  workScopeTrailRowSchema,
  workScopeWritePlanSchema,
} from "@shared/contracts";

const selectedEntry = {
  repositoryKey: "github:blazity/ai-workflow-demo",
  state: "selected",
  origin: "ticket_text",
  rationale: "The ticket names this repository.",
  decidedBy: {
    kind: "run",
    runId: "run-1",
    definitionId: 40,
    definitionVersion: 3,
    model: "gpt-5",
  },
  decidedAt: "2026-09-15T10:00:00.000Z",
};

const PULL_REQUEST_TRIGGER_TYPES = [
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
] as const;

describe("work scope vocabulary", () => {
  it("freezes the states, reasons and origins", () => {
    expect(WORK_SCOPE_ENTRY_STATES).toEqual(["selected", "excluded", "unavailable"]);
    expect(WORK_SCOPE_UNAVAILABLE_REASONS).toEqual(["not_enabled", "unusable"]);
    expect(WORK_SCOPE_ASK_REASONS).toEqual(["not_enabled", "unusable", "outside_policy", "selection"]);
    // The closed set only: precedence is `WORK_SCOPE_ORIGIN_RANKS`, not this
    // order. `delegated` is a decision a person asked for and NOT a guess, so
    // anything that reads `inferred` as "no entry at all" must keep reading
    // this one as an entry.
    expect(WORK_SCOPE_ORIGINS).toEqual([
      "person",
      "delegated",
      "workflow_owned_branch",
      "ticket_text",
      "trigger_policy",
      "inferred",
    ]);
    expect(WORK_SCOPE_REFUSAL_REASONS).toEqual([
      "outside_catalog",
      "outside_policy",
      "unusable",
      "excluded",
      "unavailable",
      "workspace_cap",
      "request_limit",
      "rounds_exhausted",
      "unnamed_in_answer",
    ]);
  });
});

describe("work scope ask reason", () => {
  it("parses each ask reason", () => {
    for (const reason of WORK_SCOPE_ASK_REASONS) {
      expect(workScopeAskReasonSchema.safeParse(reason).success, reason).toBe(true);
    }
  });

  it("refuses an unknown ask reason", () => {
    expect(workScopeAskReasonSchema.safeParse("timed_out").success).toBe(false);
  });
});

describe("asked repositories", () => {
  const askedRepository = (index: number) => ({
    repositoryKey: `github:blazity/repository-${index}`,
    askedBecause: "not_enabled",
  });

  it("refuses an asked repository with an extra key", () => {
    expect(
      workScopeAskedRepositoriesSchema.safeParse([{ ...askedRepository(1), extra: true }]).success,
    ).toBe(false);
  });

  it("accepts an ask that listed no repository, which is not the same as no ask at all", () => {
    // The plain "which repository should this ticket modify?" lists none, and a
    // person who answers it with a path has decided about that path all the
    // same. A clarification that was not about repositories carries no list at
    // all, and its answer decides nothing. Two different facts, and the schema
    // has to be able to say the first one.
    expect(workScopeAskedRepositoriesSchema.safeParse([]).success).toBe(true);
  });

  it("holds asked repositories to eight at most, unique", () => {
    expect(
      workScopeAskedRepositoriesSchema.safeParse(
        Array.from({ length: 8 }, (_, index) => askedRepository(index)),
      ).success,
    ).toBe(true);
    expect(
      workScopeAskedRepositoriesSchema.safeParse(
        Array.from({ length: 9 }, (_, index) => askedRepository(index)),
      ).success,
    ).toBe(false);
  });

  it("refuses duplicate repository keys", () => {
    expect(
      workScopeAskedRepositoriesSchema.safeParse([askedRepository(1), askedRepository(1)]).success,
    ).toBe(false);
  });

  it("carries whether the question named the repository, and accepts an ask written without it", () => {
    // A person has decided about a repository only if the question put its name
    // in front of them, so the ask records that fact rather than leaving a
    // reader to assume it. Optional because an ask written before the field
    // existed is still a valid ask; it reads as NOT named, which costs a
    // question asked again rather than a decision nobody made.
    expect(
      workScopeAskedRepositoriesSchema.safeParse([{ ...askedRepository(1), named: true }]).success,
    ).toBe(true);
    expect(
      workScopeAskedRepositoriesSchema.safeParse([{ ...askedRepository(1), named: false }]).success,
    ).toBe(true);
    expect(workScopeAskedRepositoriesSchema.safeParse([askedRepository(1)]).success).toBe(true);
    expect(
      workScopeAskedRepositoriesSchema.safeParse([{ ...askedRepository(1), named: "yes" }]).success,
    ).toBe(false);
  });
});

describe("workScopeOriginRank", () => {
  // Literal values, not positions: every stored row already carries its number,
  // so the five that predate `delegated` keep the ranks they had.
  it("ranks each origin by the number it declares, person first", () => {
    expect(workScopeOriginRank("person")).toBe(0);
    expect(workScopeOriginRank("delegated")).toBe(0);
    expect(workScopeOriginRank("workflow_owned_branch")).toBe(1);
    expect(workScopeOriginRank("ticket_text")).toBe(2);
    expect(workScopeOriginRank("trigger_policy")).toBe(3);
    expect(workScopeOriginRank("inferred")).toBe(4);
  });

  // The stored rank is what the write statement compares, so a guess, a policy,
  // a text match and a workflow-owned branch must never take a delegated entry
  // back. The tie with `person` is refused in one direction by the store.
  it("puts everything derived below a decision the workflow was asked to make", () => {
    for (const origin of ["workflow_owned_branch", "ticket_text", "trigger_policy", "inferred"] as const) {
      expect(workScopeOriginRank("delegated") < workScopeOriginRank(origin)).toBe(true);
    }
    expect(workScopeOriginRank("delegated")).toBe(workScopeOriginRank("person"));
  });
});

/**
 * A PERSON WHO HANDS THE DECISION BACK IS ANSWERING.
 *
 * "whatever you think is best" asked us to choose, so the reading says so and
 * the record writes what the workflow then took. It is not `unclear`, which
 * records nothing and parks the run, and it is not `repositories`, which would
 * claim the person named them.
 */
describe("a delegated answer", () => {
  it("reads as its own outcome, separate from unclear", () => {
    expect(workScopeAnswerOutcomeSchema.safeParse({ kind: "delegated" }).success).toBe(true);
  });

  it("carries no repository keys of its own: what was taken is the record's business", () => {
    expect(
      workScopeAnswerOutcomeSchema.safeParse({
        kind: "delegated",
        repositoryKeys: ["github:acme/api"],
      }).success,
    ).toBe(false);
  });

  it("is a word the provider may return", () => {
    const outcomes: readonly string[] = WORK_SCOPE_ANSWER_READING_JSON_SCHEMA.properties.outcome.enum;
    expect(outcomes.includes("delegated")).toBe(true);
  });

  // What the trail says: the person delegated, and these are the repositories
  // the workflow took at their request. Readable afterwards on the dashboard and
  // over MCP without replaying anything.
  it("records in the trail which repositories the workflow took", () => {
    expect(
      workScopeQuestionAnswerSchema.safeParse({
        kind: "delegated",
        repositoryKeys: ["github:acme/api", "github:acme/web"],
      }).success,
    ).toBe(true);
  });

  // A delegation on a question the run cannot honour takes none, and that is a
  // delegation too: it continues without the repository and says so.
  it("accepts a delegation that took nothing", () => {
    expect(
      workScopeQuestionAnswerSchema.safeParse({ kind: "delegated", repositoryKeys: [] }).success,
    ).toBe(true);
  });

  it("refuses a delegation that took the same repository twice", () => {
    expect(
      workScopeQuestionAnswerSchema.safeParse({
        kind: "delegated",
        repositoryKeys: ["github:acme/api", "github:acme/api"],
      }).success,
    ).toBe(false);
  });
});

describe("a delegated entry", () => {
  it("is an origin an entry may carry", () => {
    expect(
      workScopeEntrySchema.safeParse({ ...selectedEntry, origin: "delegated" }).success,
    ).toBe(true);
  });
});

describe("repository key", () => {
  it("trims and lower-cases a key to the catalog spelling", () => {
    expect(repositoryKeySchema.parse(" GitHub:Blazity/AI-Workflow-Demo ")).toBe(
      "github:blazity/ai-workflow-demo",
    );
  });

  it("accepts a GitLab project inside nested groups", () => {
    expect(repositoryKeySchema.parse("gitlab:group/sub/project")).toBe("gitlab:group/sub/project");
  });

  it("refuses a path with no provider", () => {
    expect(repositoryKeySchema.safeParse("blazity/ai-workflow").success).toBe(false);
  });

  it("refuses without offering a key that names no provider", () => {
    // The message is read by a person on the MCP surface and by a model
    // answering an API refusal, and both act on it. An example key here can
    // only be a guess at which providers a deployment connected, because this
    // package may not read the registry, and a guess is copied back verbatim.
    const refusal = repositoryKeySchema.safeParse("blazity/ai-workflow");
    expect(refusal.success).toBe(false);
    const message = refusal.success ? "" : (refusal.error.issues[0]?.message ?? "");

    expect(message.includes("provider id")).toBe(true);
    // Nothing shaped like a key a reader could paste back.
    expect(/[a-z]+:[a-z]+\/[a-z]+/u.test(message)).toBe(false);
  });

  it("accepts an open provider value and refuses a path with no slash", () => {
    expect(repositoryKeySchema.safeParse("bitbucket:blazity/ai-workflow").success).toBe(true);
    expect(repositoryKeySchema.safeParse("github:blazity").success).toBe(false);
  });
});

describe("work scope entry", () => {
  it("accepts a selected entry decided by a run", () => {
    expect(workScopeEntrySchema.safeParse(selectedEntry).success).toBe(true);
  });

  it("refuses an unavailable entry without a reason", () => {
    expect(
      workScopeEntrySchema.safeParse({ ...selectedEntry, state: "unavailable" }).success,
    ).toBe(false);
  });

  it("accepts an unavailable entry that carries its reason", () => {
    expect(
      workScopeEntrySchema.safeParse({
        ...selectedEntry,
        state: "unavailable",
        unavailableReason: "not_enabled",
      }).success,
    ).toBe(true);
  });

  it("refuses a reason on an entry that is not unavailable", () => {
    expect(
      workScopeEntrySchema.safeParse({ ...selectedEntry, unavailableReason: "unusable" }).success,
    ).toBe(false);
  });

  it("holds the rationale to 500 characters", () => {
    expect(
      workScopeEntrySchema.safeParse({ ...selectedEntry, rationale: "x".repeat(500) }).success,
    ).toBe(true);
    expect(
      workScopeEntrySchema.safeParse({ ...selectedEntry, rationale: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("accepts a person as the actor", () => {
    expect(
      workScopeEntrySchema.safeParse({
        ...selectedEntry,
        origin: "person",
        decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Filip" },
      }).success,
    ).toBe(true);
  });

  it("belongs to a versioned work scope", () => {
    expect(
      workScopeSchema.safeParse({
        subjectKey: "AWP-176",
        version: 1,
        entries: [selectedEntry],
      }).success,
    ).toBe(true);
  });
});

describe("work scope trail row", () => {
  const mapShown = (text: string) => ({
    kind: "map_shown",
    text,
    repositoryKeys: ["github:blazity/ai-workflow-demo"],
  });
  const row = (subjectKey: string | null, runId: string | null, event: unknown) => ({
    id: 1,
    subjectKey,
    runId,
    at: "2026-09-15T10:00:00.000Z",
    event,
  });

  it("refuses a row with neither a subject nor a run", () => {
    expect(workScopeTrailRowSchema.safeParse(row(null, null, mapShown("map"))).success).toBe(false);
  });

  it("accepts a panel edit with no run and a schedule run with no subject", () => {
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", null, { kind: "entry_written", entry: selectedEntry, previousState: null }),
      ).success,
    ).toBe(true);
    expect(workScopeTrailRowSchema.safeParse(row(null, "run-1", mapShown("map"))).success).toBe(true);
  });

  it("holds a shown map to 1600 characters", () => {
    expect(
      workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", mapShown("x".repeat(1600)))).success,
    ).toBe(true);
    expect(
      workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", mapShown("x".repeat(1601)))).success,
    ).toBe(false);
  });

  it("accepts a refusal, including the request_limit reason", () => {
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", {
          kind: "request_refused",
          repositoryKey: "gitlab:group/sub/project",
          reason: "outside_policy",
        }),
      ).success,
    ).toBe(true);
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", {
          kind: "request_refused",
          repositoryKey: "gitlab:group/sub/project",
          reason: "request_limit",
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a question naming asked repositories and one that named none, and still requires the list", () => {
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", {
          kind: "question_asked",
          clarificationId: "clarification-1",
          repositories: [{ repositoryKey: "gitlab:group/sub/project", askedBecause: "not_enabled" }],
        }),
      ).success,
    ).toBe(true);
    // The bare "which repository should this ticket modify?" is a repository
    // question that named none of them, and the trail has to be able to say so:
    // it is what the answer to that question is later read against. The list
    // itself stays required, so a question that named none and an event that
    // forgot to say what it asked never look alike.
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", {
          kind: "question_asked",
          clarificationId: "clarification-1",
          repositories: [],
        }),
      ).success,
    ).toBe(true);
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", { kind: "question_asked", clarificationId: "clarification-1" }),
      ).success,
    ).toBe(false);
  });

  it("carries why a question that could name no repository was asked", () => {
    // A question asking somebody to narrow a set larger than an ask may hold
    // names none of them, so its list is empty and the row is otherwise
    // identical to the bare "which repository should this ticket modify?".
    // The purpose is the only thing that tells them apart, and telling them
    // apart is what stops the narrowing question being asked again.
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", {
          kind: "question_asked",
          clarificationId: "clarification-1",
          repositories: [],
          purpose: "narrowing",
        }),
      ).success,
    ).toBe(true);
    // Absent is the only reading a row written before this field existed can
    // have, and it has to stay parseable.
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", {
          kind: "question_asked",
          clarificationId: "clarification-1",
          repositories: [],
        }),
      ).success,
    ).toBe(true);
    // A purpose nothing reads is worse than none: it would be written, stored
    // and silently never matched.
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", {
          kind: "question_asked",
          clarificationId: "clarification-1",
          repositories: [],
          purpose: "whichever",
        }),
      ).success,
    ).toBe(false);
  });

  it("round-trips entry_removed and refuses it without removedBy", () => {
    const removedBy = { kind: "person", actorId: "user-1", actorLabel: "Filip" };
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", { kind: "entry_removed", entry: selectedEntry, removedBy }),
      ).success,
    ).toBe(true);
    expect(
      workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", { kind: "entry_removed", entry: selectedEntry }))
        .success,
    ).toBe(false);
  });

  it("round-trips each question_answered answer kind", () => {
    const answeredBy = { kind: "person", actorId: "user-1", actorLabel: "Filip" };
    const answered = (answer: unknown) => ({
      kind: "question_answered",
      clarificationId: "clarification-1",
      answer,
      answeredBy,
    });
    expect(
      workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", answered({ kind: "none" }))).success,
    ).toBe(true);
    expect(
      workScopeTrailRowSchema.safeParse(
        row(
          "AWP-176",
          "run-1",
          answered({ kind: "repositories", repositoryKeys: ["gitlab:group/sub/project"] }),
        ),
      ).success,
    ).toBe(true);
    expect(
      workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", answered({ kind: "unrecognised" }))).success,
    ).toBe(true);
    // An answer more than one person wrote is its own answer kind, not a
    // failure to read one: the trail has to be able to say which of the two
    // happened, because only one of them is about the words.
    expect(
      workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", answered({ kind: "unattributed" }))).success,
    ).toBe(true);
  });

  it("holds a repositories answer to one to eight keys and requires answeredBy", () => {
    const answeredBy = { kind: "person", actorId: "user-1", actorLabel: "Filip" };
    const answered = (repositoryKeys: string[]) => ({
      kind: "question_answered",
      clarificationId: "clarification-1",
      answer: { kind: "repositories", repositoryKeys },
      answeredBy,
    });
    const keys = (count: number) =>
      Array.from({ length: count }, (_, index) => `github:blazity/repository-${index}`);
    expect(workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", answered([]))).success).toBe(false);
    expect(workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", answered(keys(8)))).success).toBe(
      true,
    );
    expect(workScopeTrailRowSchema.safeParse(row("AWP-176", "run-1", answered(keys(9)))).success).toBe(
      false,
    );
    expect(
      workScopeTrailRowSchema.safeParse(
        row("AWP-176", "run-1", {
          kind: "question_answered",
          clarificationId: "clarification-1",
          answer: { kind: "none" },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("work scope edit request", () => {
  const change = (index: number) => ({
    repositoryKey: `github:blazity/repository-${index}`,
    action: "select",
  });
  const request = (changes: unknown[], expectedVersion = 0) => ({
    subjectKey: "AWP-176",
    expectedVersion,
    changes,
  });

  it("accepts one to sixteen changes", () => {
    expect(workScopeEditRequestSchema.safeParse(request([change(1)])).success).toBe(true);
    expect(
      workScopeEditRequestSchema.safeParse(
        request(Array.from({ length: 16 }, (_, index) => change(index))),
      ).success,
    ).toBe(true);
  });

  it("refuses an edit with no changes", () => {
    expect(workScopeEditRequestSchema.safeParse(request([])).success).toBe(false);
  });

  it("refuses an edit with seventeen changes", () => {
    expect(
      workScopeEditRequestSchema.safeParse(
        request(Array.from({ length: 17 }, (_, index) => change(index))),
      ).success,
    ).toBe(false);
  });

  it("refuses two changes to the same repository, whatever its casing", () => {
    expect(
      workScopeEditRequestSchema.safeParse(
        request([
          { repositoryKey: "github:blazity/ai-workflow", action: "select" },
          { repositoryKey: "GitHub:Blazity/AI-Workflow", action: "exclude", rationale: "Not this one." },
        ]),
      ).success,
    ).toBe(false);
  });

  it("refuses a negative expected version", () => {
    expect(workScopeEditRequestSchema.safeParse(request([change(1)], -1)).success).toBe(false);
  });
});

describe("work scope write plan", () => {
  const entryFor = (repositoryKey: string, state = "selected") => ({
    ...selectedEntry,
    repositoryKey,
    state,
  });
  const upsert = (repositoryKey: string, replacesExpired = false, state = "selected") => ({
    entry: entryFor(repositoryKey, state),
    replacesExpired,
  });
  const remove = (repositoryKey: string, origin = "inferred") => ({ repositoryKey, origin });
  const keys = (count: number) =>
    Array.from({ length: count }, (_, index) => `github:blazity/repository-${index}`);
  const mapShown = { kind: "map_shown", text: "map", repositoryKeys: [] };
  const plan = (upserts: unknown[], deletes: unknown[], trail: unknown[]) =>
    workScopeWritePlanSchema.safeParse({ upserts, deletes, trail }).success;

  it("accepts an entirely empty plan", () => {
    expect(plan([], [], [])).toBe(true);
  });

  it("accepts upserts, deletes and trail events on different keys", () => {
    expect(
      plan(
        [upsert("github:blazity/ai-workflow-demo")],
        [remove("gitlab:group/sub/project", "ticket_text")],
        [{ kind: "entry_written", entry: entryFor("github:blazity/ai-workflow-demo"), previousState: null }],
      ),
    ).toBe(true);
  });

  it("refuses an upsert and a delete of the same key, whatever its casing", () => {
    expect(
      plan([upsert("github:blazity/ai-workflow")], [remove("GitHub:Blazity/AI-Workflow")], []),
    ).toBe(false);
  });

  it("refuses two deletes of the same key", () => {
    expect(
      plan([], [remove("github:blazity/ai-workflow"), remove("GitHub:Blazity/AI-Workflow", "person")], []),
    ).toBe(false);
  });

  it("refuses a delete that does not name the origin it observed", () => {
    expect(plan([], [{ repositoryKey: "github:blazity/ai-workflow" }], [])).toBe(false);
    expect(plan([], [remove("github:blazity/ai-workflow", "guessed")], [])).toBe(false);
  });

  it("refuses two upserts of the same key", () => {
    expect(
      plan([upsert("github:blazity/ai-workflow"), upsert("GitHub:Blazity/AI-Workflow")], [], []),
    ).toBe(false);
  });

  it("allows replacesExpired only on a selected entry", () => {
    expect(plan([upsert("github:blazity/ai-workflow", true, "selected")], [], [])).toBe(true);
    expect(plan([upsert("github:blazity/ai-workflow", true, "excluded")], [], [])).toBe(false);
    expect(
      plan(
        [
          {
            entry: { ...entryFor("github:blazity/ai-workflow", "unavailable"), unavailableReason: "not_enabled" },
            replacesExpired: true,
          },
        ],
        [],
        [],
      ),
    ).toBe(false);
    expect(plan([upsert("github:blazity/ai-workflow", false, "excluded")], [], [])).toBe(true);
  });

  it("holds upserts and deletes to sixteen and trail events to thirty-two", () => {
    expect(plan(keys(16).map((key) => upsert(key)), [], [])).toBe(true);
    expect(plan(keys(17).map((key) => upsert(key)), [], [])).toBe(false);
    expect(plan([], keys(16).map((key) => remove(key)), [])).toBe(true);
    expect(plan([], keys(17).map((key) => remove(key)), [])).toBe(false);
    expect(plan([], [], Array.from({ length: 32 }, () => mapShown))).toBe(true);
    expect(plan([], [], Array.from({ length: 33 }, () => mapShown))).toBe(false);
  });

  it("accepts a trail carrying an entry_removed event", () => {
    const removedBy = { kind: "person", actorId: "user-1", actorLabel: "Filip" };
    expect(
      plan(
        [],
        [],
        [{ kind: "entry_removed", entry: entryFor("github:blazity/ai-workflow-demo"), removedBy }],
      ),
    ).toBe(true);
  });

  it("accepts a trail carrying a question_answered event", () => {
    const answeredBy = { kind: "person", actorId: "user-1", actorLabel: "Filip" };
    expect(
      plan(
        [],
        [],
        [
          {
            kind: "question_answered",
            clarificationId: "clarification-1",
            answer: { kind: "none" },
            answeredBy,
          },
        ],
      ),
    ).toBe(true);
  });
});

describe("trigger repository policy shape", () => {
  it("accepts each candidate kind", () => {
    for (const candidates of [
      { kind: "enabled_catalog" },
      { kind: "event_repository_and_related" },
      { kind: "listed", repositoryKeys: ["github:blazity/ai-workflow-demo"] },
    ]) {
      expect(
        triggerRepositoryPolicySchema.safeParse({ candidates, expansion: "attach" }).success,
        candidates.kind,
      ).toBe(true);
    }
  });

  it("holds a listed candidate set to one to fifty unique keys", () => {
    const listed = (repositoryKeys: string[]) =>
      triggerRepositoryPolicySchema.safeParse({
        candidates: { kind: "listed", repositoryKeys },
        expansion: "never",
      }).success;
    const keys = (count: number) =>
      Array.from({ length: count }, (_, index) => `github:blazity/repository-${index}`);
    expect(listed([])).toBe(false);
    expect(listed(keys(50))).toBe(true);
    expect(listed(keys(51))).toBe(false);
    expect(listed(["github:blazity/ai-workflow", "GitHub:Blazity/AI-Workflow"])).toBe(false);
  });

  it("refuses a key the policy does not own", () => {
    expect(
      triggerRepositoryPolicySchema.safeParse({
        candidates: { kind: "enabled_catalog" },
        expansion: "attach",
        maxRepositories: 3,
      }).success,
    ).toBe(false);
  });
});

describe("resolveTriggerRepositoryPolicy", () => {
  const pin = {
    repositories: [
      { provider: "github" as const, repoPath: "Blazity/AI-Workflow-Demo" },
      { provider: "gitlab" as const, repoPath: "group/sub/project" },
    ],
  };
  const pinnedKeys = ["github:blazity/ai-workflow-demo", "gitlab:group/sub/project"];

  it("returns a configured policy as it is", () => {
    const configured = {
      candidates: { kind: "listed" as const, repositoryKeys: ["github:blazity/ai-workflow"] },
      expansion: "never" as const,
    };
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_ticket_ai",
        configured,
        webhookHasSubjectPath: false,
      }),
    ).toEqual({
      candidates: { kind: "listed", repositoryKeys: ["github:blazity/ai-workflow"] },
      expansion: "never",
    });
  });

  it("prefers a configured policy over the definition pin", () => {
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_ticket_ai",
        configured: { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
        definitionPin: pin,
        webhookHasSubjectPath: false,
      }),
    ).toEqual({ candidates: { kind: "enabled_catalog" }, expansion: "ask_once" });
  });

  it("lists the pinned repositories as keys and keeps the kind's expansion", () => {
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_ticket_ai",
        definitionPin: pin,
        webhookHasSubjectPath: false,
      }),
    ).toEqual({ candidates: { kind: "listed", repositoryKeys: pinnedKeys }, expansion: "attach" });
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_pr_review",
        definitionPin: pin,
        webhookHasSubjectPath: false,
      }),
    ).toEqual({ candidates: { kind: "listed", repositoryKeys: pinnedKeys }, expansion: "attach" });
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_schedule",
        definitionPin: pin,
        webhookHasSubjectPath: false,
      }),
    ).toEqual({ candidates: { kind: "listed", repositoryKeys: pinnedKeys }, expansion: "never" });
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_webhook",
        definitionPin: pin,
        webhookHasSubjectPath: true,
      }),
    ).toEqual({ candidates: { kind: "listed", repositoryKeys: pinnedKeys }, expansion: "ask_once" });
  });

  it("counts a pin that carries only providers as no pin", () => {
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_ticket_ai",
        definitionPin: { providers: ["github"] },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({ candidates: { kind: "enabled_catalog" }, expansion: "attach" });
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_ticket_ai",
        definitionPin: { repositories: [], providers: ["gitlab"] },
        webhookHasSubjectPath: false,
      }),
    ).toEqual({ candidates: { kind: "enabled_catalog" }, expansion: "attach" });
  });

  it("attaches over the enabled catalog for a ticket by default", () => {
    expect(
      resolveTriggerRepositoryPolicy({ triggerType: "trigger_ticket_ai", webhookHasSubjectPath: false }),
    ).toEqual({ candidates: { kind: "enabled_catalog" }, expansion: "attach" });
  });

  for (const triggerType of PULL_REQUEST_TRIGGER_TYPES) {
    it(`attaches the event repository and its related repositories for ${triggerType} by default`, () => {
      expect(resolveTriggerRepositoryPolicy({ triggerType, webhookHasSubjectPath: false })).toEqual({
        candidates: { kind: "event_repository_and_related" },
        expansion: "attach",
      });
    });
  }

  it("never expands a schedule by default", () => {
    expect(
      resolveTriggerRepositoryPolicy({ triggerType: "trigger_schedule", webhookHasSubjectPath: false }),
    ).toEqual({ candidates: { kind: "enabled_catalog" }, expansion: "never" });
  });

  it("asks once for a webhook with a subject path and never without one", () => {
    expect(
      resolveTriggerRepositoryPolicy({ triggerType: "trigger_webhook", webhookHasSubjectPath: true }),
    ).toEqual({ candidates: { kind: "enabled_catalog" }, expansion: "ask_once" });
    expect(
      resolveTriggerRepositoryPolicy({ triggerType: "trigger_webhook", webhookHasSubjectPath: false }),
    ).toEqual({ candidates: { kind: "enabled_catalog" }, expansion: "never" });
  });

  it("returns nothing for an approved plan, which carries its own frozen scope", () => {
    expect(
      resolveTriggerRepositoryPolicy({
        triggerType: "trigger_plan_approved",
        definitionPin: pin,
        webhookHasSubjectPath: false,
      }),
    ).toBe(null);
  });
});

describe("validateTriggerRepositoryPolicy", () => {
  it("refuses the event repository outside the pull request triggers", () => {
    expect(
      validateTriggerRepositoryPolicy(
        "trigger_ticket_ai",
        { candidates: { kind: "event_repository_and_related" }, expansion: "attach" },
        { webhookHasSubjectPath: false },
      ),
    ).toEqual([
      {
        code: "event_repository_outside_pull_request",
        path: ["candidates", "kind"],
        message:
          "Only a pull request trigger has an event repository, so this trigger cannot take its candidates from one.",
      },
    ]);
  });

  it("accepts the event repository on every pull request trigger", () => {
    for (const triggerType of PULL_REQUEST_TRIGGER_TYPES) {
      expect(
        validateTriggerRepositoryPolicy(
          triggerType,
          { candidates: { kind: "event_repository_and_related" }, expansion: "attach" },
          { webhookHasSubjectPath: false },
        ),
        triggerType,
      ).toEqual([]);
    }
  });

  it("refuses ask_once on a schedule", () => {
    expect(
      validateTriggerRepositoryPolicy(
        "trigger_schedule",
        { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
        { webhookHasSubjectPath: false },
      ),
    ).toEqual([
      {
        code: "ask_once_on_schedule",
        path: ["expansion"],
        message: "A schedule cannot ask about repositories, because nobody is there to answer.",
      },
    ]);
  });

  it("refuses ask_once on a webhook with no subject path", () => {
    expect(
      validateTriggerRepositoryPolicy(
        "trigger_webhook",
        { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
        { webhookHasSubjectPath: false },
      ),
    ).toEqual([
      {
        code: "ask_once_without_subject_path",
        path: ["expansion"],
        message:
          "A webhook can ask about repositories only when it configures a subject path, because without one every delivery is a new subject.",
      },
    ]);
  });

  it("accepts ask_once on a webhook with a subject path", () => {
    expect(
      validateTriggerRepositoryPolicy(
        "trigger_webhook",
        { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
        { webhookHasSubjectPath: true },
      ),
    ).toEqual([]);
  });

  it("refuses a repository listed twice", () => {
    expect(
      validateTriggerRepositoryPolicy(
        "trigger_ticket_ai",
        {
          candidates: {
            kind: "listed",
            repositoryKeys: [
              "github:blazity/ai-workflow",
              "gitlab:group/sub/project",
              "GitHub:Blazity/AI-Workflow",
            ],
          },
          expansion: "attach",
        },
        { webhookHasSubjectPath: false },
      ),
    ).toEqual([
      {
        code: "duplicate_repository_key",
        path: ["candidates", "repositoryKeys", 2],
        message: 'Repository "github:blazity/ai-workflow" is listed more than once.',
      },
    ]);
  });
});
