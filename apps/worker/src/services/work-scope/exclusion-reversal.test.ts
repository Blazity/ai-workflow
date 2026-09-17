/**
 * Rule 4 tied to the sentence that promises it: every recorded decision is
 * reversible in the same delivery, and the person is told how.
 *
 * Three tests already prove the sentence is SAID (the bare question's prefix,
 * the ticket comment, the text a person reads when the run stops). None of them
 * proves the route it names exists, which is rule 6 applied to rule 4: a remedy
 * we offer has to work when the person does it. So this one reads the promise
 * and then walks it, end to end, through the entries a person actually reaches:
 * the run's own decision writes the exclusion, the next run refuses the
 * repository because of it, the record takes the person's change, and the run
 * after that starts from the changed list.
 *
 * It goes red if the edit entry stops accepting the change, if the decision
 * stops honouring an edited entry at run start, or if the sentence starts
 * promising something else.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { WorkScope } from "@shared/contracts";
import { readWorkScope, applyAnswerWorkScopePlan } from "../../db/repositories/work-scope.js";
import { repositories, repositoryCatalogState, user } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/types.js";
import { exclusionRecoveryNotes } from "../../engine/work-scope/context.js";
import { decideWorkScope, type WorkScopeDecisionContext } from "../../engine/work-scope/decide.js";
import { applyWorkScopeEdit, readWorkScopeRecord } from "./index.js";

const SUBJECT = "ticket:jira:AIW-402";
const API = "github:acme/api";
const RUN = "run-1";
const CLARIFICATION = "clarification-1";
const PERSON = { kind: "person", actorId: "user_member", actorLabel: "Ada Lovelace" } as const;
const NOW = new Date("2026-09-16T10:00:00.000Z");

let db: Db;

/** The run's own view: the catalog holds the repository and can serve it, and
 *  the workflow that runs this work is limited to it, which is the bound that
 *  made the run ask about it in the first place. */
function context(overrides: Partial<WorkScopeDecisionContext>): WorkScopeDecisionContext {
  return {
    scope: null,
    carriesRecord: true,
    catalog: { activated: true, enabledKeys: [API], unusableKeys: [] },
    pinnedProviders: null,
    pinnedKeys: null,
    policy: { candidates: { kind: "listed", repositoryKeys: [API] }, expansion: "attach" },
    eventRelatedKeys: [],
    attachedKeys: [],
    selectionAnswered: false,
    answeredRepositoryKeys: [],
    postAnswerMentionedKeys: [],
    actor: PERSON,
    now: NOW.toISOString(),
    ...overrides,
  };
}

async function scopeNow(): Promise<WorkScope | null> {
  return readWorkScope(db, SUBJECT);
}

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(user).values({
    id: "user_member",
    name: "Ada Lovelace",
    email: "ada@example.com",
    emailVerified: true,
  });
  await db
    .insert(repositories)
    .values({ provider: "github", path: "acme/api", source: "manual", enabled: true });
  await db.insert(repositoryCatalogState).values({ id: 1, activated: true });
});

describe("an exclusion a person decided", () => {
  it("is reversible where the run says it is: the record takes the change, and the next run starts from the changed list", async () => {
    // The person answers a question about a repository the trigger policy did
    // not include, and declines it. This is the one refusal a person made
    // themselves, and the only one the sentence below is said for.
    const answered = decideWorkScope(context({}), {
      kind: "answered",
      clarificationId: CLARIFICATION,
      asked: [{ repositoryKey: API, askedBecause: "outside_policy", named: true }],
      answer: { kind: "none" },
    });
    await applyAnswerWorkScopePlan(db, {
      subjectKey: SUBJECT,
      runId: RUN,
      clarificationId: CLARIFICATION,
      plan: answered.plan,
    });
    await expect(scopeNow()).resolves.toMatchObject({
      entries: [{ repositoryKey: API, state: "excluded", origin: "person" }],
    });

    // A later run finds the repository the way the first one did, by reading
    // the ticket, and leaves it out because a person excluded it. This is the
    // moment the sentence is composed and put in front of that person.
    const refusedRun = decideWorkScope(context({ scope: await scopeNow() }), {
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: [API],
      rationale: "named in the ticket",
    });
    expect(refusedRun.refused).toEqual([{ repositoryKey: API, reason: "excluded" }]);
    expect(refusedRun.attach).toEqual([]);

    // The promise, read from the one place every channel composes it.
    const [promise, ...rest] = exclusionRecoveryNotes(
      refusedRun.refused
        .filter((refusal) => refusal.reason === "excluded")
        .map((refusal) => refusal.repositoryKey),
      { enabledKeys: [API], unusableKeys: [] },
    );
    expect(rest).toEqual([]);
    expect(promise).toContain("this work's repository list can be changed");
    expect(promise).toContain("the next run starts from the changed list");

    // Half one of the promise: the list takes the change, on this subject, with
    // no new ticket and nothing else to ask for.
    const view = await readWorkScopeRecord(db, { subjectKey: SUBJECT });
    const edited = await applyWorkScopeEdit(db, {
      request: {
        subjectKey: SUBJECT,
        expectedVersion: view.version,
        changes: [{ repositoryKey: API, action: "select", rationale: "we do need it" }],
      },
      editor: { id: "user_member" },
      now: NOW,
    });
    expect(edited).toMatchObject({
      kind: "applied",
      scope: { entries: [{ repositoryKey: API, state: "selected", origin: "person" }] },
    });

    // Half two: the next run starts from the changed list. The route that was
    // refused is taken, and the record alone furnishes the workspace at run
    // start, both decided by the function a run decides with rather than by
    // reading the row back and believing it.
    const changed = await scopeNow();
    const rediscovered = decideWorkScope(context({ scope: changed }), {
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: [API],
      rationale: "named in the ticket",
    });
    expect(rediscovered.refused).toEqual([]);
    expect(rediscovered.attach).toEqual([API]);

    const nextRunStart = decideWorkScope(context({ scope: changed }), { kind: "run_started" });
    expect(nextRunStart.refused).toEqual([]);
    expect(nextRunStart.attach).toEqual([API]);
  });
});
