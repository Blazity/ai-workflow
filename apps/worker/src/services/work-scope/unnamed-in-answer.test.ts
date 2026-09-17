/**
 * Row A7 walked through the store: a person who leaves a repository out of an
 * answer to the which-of-these question has declined it, and no guess takes it
 * back afterwards, even one an earlier run already recorded.
 *
 * The pure decision tests prove each half on its own (the answer removes a
 * guessed selection, a guess refuses a key an answer left unnamed). This one
 * proves the halves meet where production meets them: the answer's removal goes
 * through the same single statement every answer write takes, the answered set
 * the next run reads is built from the trail that statement wrote, and the next
 * run's guess is decided against exactly what the store returns.
 *
 * It goes red if the answer stops removing the guess, if the statement drops the
 * removal, if the answered set stops naming the repository, or if the rule stops
 * reading the pair.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { WorkScopeOrigin } from "@shared/contracts";
import {
  appendWorkScopeQuestionAsked,
  applyAnswerWorkScopePlan,
  applyRunWorkScopePlan,
  readWorkScopeFacts,
} from "../../db/repositories/work-scope.js";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/types.js";
import {
  decideWorkScope,
  type WorkScopeDecisionContext,
  type WorkScopeDecisionEvent,
} from "../../engine/work-scope/decide.js";

const SUBJECT = "ticket:jira:AWT-402";
const API = "github:acme/api";
const WEB = "github:acme/web";
const RUN = { kind: "run", runId: "run-1", definitionId: 40, definitionVersion: 3 } as const;
const PERSON = { kind: "person", actorId: "user_member", actorLabel: "Ada Lovelace" } as const;
const CLARIFICATION = "clarification-1";

let db: Db;

function context(overrides: Partial<WorkScopeDecisionContext>): WorkScopeDecisionContext {
  return {
    scope: null,
    carriesRecord: true,
    catalog: { activated: true, enabledKeys: [API, WEB], unusableKeys: [] },
    pinnedProviders: null,
    pinnedKeys: null,
    policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
    eventRelatedKeys: [],
    attachedKeys: [],
    selectionAnswered: false,
    answeredRepositoryKeys: [],
    postAnswerMentionedKeys: [],
    actor: RUN,
    now: "2026-09-17T09:00:00.000Z",
    ...overrides,
  };
}

/** An earlier run derives API under `origin`, and the store keeps what it wrote. */
async function earlierRunDerives(origin: Extract<WorkScopeOrigin, "inferred" | "ticket_text">) {
  const event: WorkScopeDecisionEvent = {
    kind: "derived",
    origin,
    repositoryKeys: [API],
    rationale: "an earlier run's reason",
  };
  const decision = decideWorkScope(context({}), event);
  expect(decision.attach).toEqual([API]);
  await applyRunWorkScopePlan(db, { subjectKey: SUBJECT, runId: "run-1", plan: decision.plan });
}

/** The which-of-these question names both repositories, and the answer is
 *  "none". `keepTheGuessEntry` writes the same answer the way a deployment
 *  without the removal wrote it, which is the shape every record answered
 *  before this rule is in: the delete is stripped, so the earlier guess's entry
 *  stays. */
async function askedAndAnsweredNone(keepTheGuessEntry = false) {
  await appendWorkScopeQuestionAsked(db, {
    subjectKey: SUBJECT,
    runId: "run-2",
    clarificationId: CLARIFICATION,
    asked: [
      { repositoryKey: API, askedBecause: "selection", named: true },
      { repositoryKey: WEB, askedBecause: "selection", named: true },
    ],
  });
  const { scope } = await readWorkScopeFacts(db, SUBJECT);
  const answered = decideWorkScope(context({ scope, actor: PERSON, policy: null, attachedKeys: null }), {
    kind: "answered",
    clarificationId: CLARIFICATION,
    asked: [
      { repositoryKey: API, askedBecause: "selection", named: true },
      { repositoryKey: WEB, askedBecause: "selection", named: true },
    ],
    answer: { kind: "none" },
  });
  const plan = keepTheGuessEntry
    ? {
        ...answered.plan,
        deletes: [],
        trail: answered.plan.trail.filter((event) => event.kind !== "entry_removed"),
      }
    : answered.plan;
  await applyAnswerWorkScopePlan(db, {
    subjectKey: SUBJECT,
    runId: "run-2",
    clarificationId: CLARIFICATION,
    plan,
  });
}

/** The next run guesses API again, against exactly what the store now holds.
 *  `postAnswerMentionedKeys` is what a run would pass having found API's full
 *  path in a comment written after the instant the store reports. */
async function nextRunGuesses(
  origin: Extract<WorkScopeOrigin, "inferred" | "ticket_text">,
  postAnswerMentionedKeys: string[] = [],
) {
  const facts = await readWorkScopeFacts(db, SUBJECT);
  return {
    facts,
    decision: decideWorkScope(
      context({
        scope: facts.scope,
        selectionAnswered: facts.selectionAnswered,
        answeredRepositoryKeys: facts.answeredRepositoryKeys,
        postAnswerMentionedKeys,
      }),
      { kind: "derived", origin, repositoryKeys: [API], rationale: "the next run's reason" },
    ),
  };
}

beforeEach(async () => {
  db = await createTestDb();
});

describe("a guess an earlier run recorded, and an answer that left the repository out", () => {
  it("removes the guess when the answer arrives, and the next guess does not take the repository back", async () => {
    await earlierRunDerives("inferred");
    await askedAndAnsweredNone();

    const { facts, decision } = await nextRunGuesses("inferred");

    expect(facts.scope?.entries ?? []).toEqual([]);
    expect(facts.answeredRepositoryKeys).toEqual([API, WEB]);
    expect(decision.attach).toEqual([]);
    expect(decision.unnamed).toEqual([API]);
  });

  // Every subject answered BEFORE the removal shipped is in this state: the
  // guess's entry is still there, because the answer that left the repository
  // out wrote nothing and deleted nothing. Read as an entry it would hand the
  // repository back to every guess forever, which is the whole rule going
  // inert on exactly the records that already exist.
  it("still refuses the guess on a record whose answer never removed the earlier entry", async () => {
    await earlierRunDerives("inferred");
    await askedAndAnsweredNone(true);

    const { facts, decision } = await nextRunGuesses("inferred");

    // The entry an older deployment left behind, still in the record.
    expect(facts.scope?.entries.map((entry) => [entry.repositoryKey, entry.origin])).toEqual([
      [API, "inferred"],
    ]);
    expect(facts.answeredRepositoryKeys).toEqual([API, WEB]);
    expect(decision.attach).toEqual([]);
    expect(decision.unnamed).toEqual([API]);
  });

  // A path somebody typed is not a guess: the answer leaves its entry alone, and
  // the text keeps naming the repository the next run takes.
  it("keeps a typed path's entry, and the next run still takes the path", async () => {
    await earlierRunDerives("ticket_text");
    await askedAndAnsweredNone();

    const { facts, decision } = await nextRunGuesses("ticket_text");

    expect(facts.scope?.entries.map((entry) => [entry.repositoryKey, entry.origin])).toEqual([
      [API, "ticket_text"],
    ]);
    expect(decision.attach).toEqual([API]);
  });

  /**
   * The same walk for the ticket's own words, which the question was asked
   * about and which go on naming every repository afterwards.
   *
   * The store is what makes this provable rather than a matter of opinion: the
   * instant the answer was recorded comes back from the trail the answer itself
   * wrote, and it is what a run compares a comment against. Nothing here writes
   * a comment; the run does that reading (`ticketTextReading` in
   * `engine/pre-sandbox/steps/repo-selection.ts`), and what it finds arrives as
   * the keys below.
   */
  describe("and the text that raised the question still naming it", () => {
    it("takes nothing back from the ticket's own words, and reports the instant to date them against", async () => {
      await askedAndAnsweredNone();

      const { facts, decision } = await nextRunGuesses("ticket_text");

      expect(facts.scope?.entries ?? []).toEqual([]);
      expect(Date.parse(facts.answeredAtByKey[API] ?? "")).not.toBeNaN();
      expect(decision.attach).toEqual([]);
      expect(decision.plan.upserts).toEqual([]);
      expect(decision.plan.trail).toEqual([]);
      expect(decision.refused).toEqual([]);
      expect(decision.unnamed).toEqual([API]);
    });

    it("takes the path once a person wrote it after that instant", async () => {
      await askedAndAnsweredNone();

      const { decision } = await nextRunGuesses("ticket_text", [API]);

      expect(decision.attach).toEqual([API]);
      expect(decision.plan.upserts.map((upsert) => upsert.entry.origin)).toEqual(["ticket_text"]);
      expect(decision.unnamed).toBeUndefined();
    });

    it("reports no instant on a subject nobody has answered", async () => {
      await earlierRunDerives("inferred");

      const facts = await readWorkScopeFacts(db, SUBJECT);

      expect(facts.answeredAtByKey).toEqual({});
    });
  });
});
