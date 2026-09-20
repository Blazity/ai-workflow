/**
 * The clarification rounds of a subject, and what a person and an agent are
 * each told about them.
 *
 * The heavy case is the one that decides whether this is usable at all: a
 * ticket whose question was answered three hundred times, which is what a
 * weekend of Jira poll ticks and a few corrections really produce.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { clarificationRoundHeaderSchema, readVisibilityRecord } from "@shared/agent-visibility";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { recordAnswerDelivery } from "./deliveries.js";
import {
  assembleSubjectRounds,
  roundDeliveriesPage,
  roundEffectsPage,
  roundHeadersPage,
  roundReadsOf,
} from "./rounds-read.js";
import { AgentVisibilityReadError, jsonBytes } from "./pages.js";
import {
  CAPTURED_AT,
  detector,
  OTHER_ORG,
  seedClarification,
  seedRun,
  seedTrailEvent,
  seedVisibilityWorld,
  VISIBILITY_ORG,
  type SeededWorld,
} from "../../test-support/agent-visibility.js";

let db: Db;
let world: SeededWorld;
const RUN = "wrun_rounds";
const SUBJECT = "ticket:jira:AWP-235";
const ASK = "cl_first";

function reads() {
  return roundReadsOf(db);
}

function assemble(organizationId = VISIBILITY_ORG) {
  return assembleSubjectRounds(reads(), { subjectKey: SUBJECT, organizationId });
}

beforeEach(async () => {
  db = await createTestDb();
  world = await seedVisibilityWorld(db);
  await seedRun(db, { runId: RUN, world });
}, 120_000);

async function askOnce(questions: string[] = ["Which repository should this ticket use?"]) {
  await seedClarification(db, {
    id: ASK,
    runId: RUN,
    subjectKey: SUBJECT,
    questions,
    askedAt: CAPTURED_AT,
    offered: [{ repositoryKey: "github:acme/api", askedBecause: "selection", named: true }],
  });
  await seedTrailEvent(db, {
    subjectKey: SUBJECT,
    runId: RUN,
    kind: "question_asked",
    event: {
      kind: "question_asked",
      clarificationId: ASK,
      purpose: "which_repository",
      repositoryKeys: ["github:acme/api"],
    },
    at: CAPTURED_AT,
  });
}

describe("a round of three hundred arrivals", () => {
  // Red when: the round is served whole, which is tens of thousands of words
  // in one result, or the count of what a person really said is lost to the
  // merge that keeps a weekend of poll ticks from burying it.
  it("stays well under the MCP cap and pages the rest, with the counts intact", async () => {
    await askOnce();
    // Three distinct answers, each arriving many times: A repeated, then B,
    // then A again, which the store keeps as three deliveries in that order.
    const words = ["the api one", "no, the web one", "the api one"];
    for (const [round, said] of words.entries()) {
      for (let arrival = 0; arrival < 100; arrival += 1) {
        const outcome = await recordAnswerDelivery(
          {
            clarificationId: ASK,
            runId: RUN,
            words: said,
            author: { kind: "person", display: "Ada Lovelace" },
            surface: "jira",
            reading: null,
            note: null,
            at: new Date(CAPTURED_AT.getTime() + round * 100_000 + arrival * 1_000),
          },
          { db, sanitize: detector },
        );
        expect(outcome.outcome).not.toBe("not_recorded");
      }
    }

    const assembled = await assemble();
    const headers = roundHeadersPage(assembled, {});
    const header = headers.items[0]!;

    expect(headers.total).toBe(1);
    expect(header.deliveryCount).toBe(3);
    expect(header.arrivalCount).toBe(300);
    expect(jsonBytes(headers)).toBeLessThan(49_152);

    const deliveries = roundDeliveriesPage(assembled, header.id, {});
    expect(deliveries.total).toBe(3);
    expect(deliveries.items.map((entry) => entry.count)).toEqual([100, 100, 100]);
    expect(jsonBytes(deliveries)).toBeLessThan(49_152);
  }, 300_000);

  // Red when: a round header stops parsing under the schema the dashboard
  // reads it with, so the round vanishes from the panel with a named error.
  it("serves a header the frozen schema accepts", async () => {
    await askOnce();

    const headers = roundHeadersPage(await assemble(), {});

    expect(readVisibilityRecord(clarificationRoundHeaderSchema, headers.items[0]).ok).toBe(true);
  });

  // Red when: a delivery repeated between two pages shifts the order under a
  // positional cursor, so one is served twice and another skipped.
  it("pages deliveries on the delivery, and refuses a cursor it no longer has", async () => {
    await askOnce();
    for (const said of ["one", "two", "three"]) {
      await recordAnswerDelivery(
        {
          clarificationId: ASK,
          runId: RUN,
          words: said.repeat(400),
          author: { kind: "person", display: "Ada Lovelace" },
          surface: "dashboard",
          reading: null,
          note: null,
          at: new Date(CAPTURED_AT.getTime() + said.length * 1_000),
        },
        { db, sanitize: detector },
      );
    }
    const assembled = await assemble();
    const round = assembled.rounds[0]!;

    const first = roundDeliveriesPage(assembled, round.id, { limit: 2_048 });
    const second = roundDeliveriesPage(assembled, round.id, {
      limit: 2_048,
      cursor: first.nextCursor,
    });
    const bad = (() => {
      try {
        return roundDeliveriesPage(assembled, round.id, { cursor: "cl_first|nope|1" });
      } catch (error) {
        return error;
      }
    })();

    expect(first.nextCursor).not.toBeNull();
    expect(first.total).toBe(3);
    const served = [...first.items, ...second.items].map((entry) => entry.words);
    expect(new Set(served).size).toBe(served.length);
    expect(bad).toBeInstanceOf(AgentVisibilityReadError);
    expect((bad as AgentVisibilityReadError).statusCode).toBe(400);
  }, 120_000);

  // Red when: the effects of a round are taken from the caller's trail page,
  // so a round with forty events reports the handful that page happened to
  // hold, or none at all.
  it("counts a round's effects independently of any trail page", async () => {
    await askOnce();
    for (let at = 0; at < 12; at += 1) {
      await seedTrailEvent(db, {
        subjectKey: SUBJECT,
        runId: RUN,
        kind: "entry_written",
        event: {
          kind: "entry_written",
          clarificationId: ASK,
          repositoryKey: `github:acme/service-${at}`,
        },
        at: new Date(CAPTURED_AT.getTime() + at * 1_000),
      });
    }

    const assembled = await assemble();
    const header = roundHeadersPage(assembled, {}).items[0]!;
    const effects = roundEffectsPage(assembled, header.id, {});

    // The question_asked event is the round's own question, not an effect.
    expect(header.effectCount).toBe(12);
    expect(effects.total).toBe(12);
    expect(effects.items.every((effect) => effect.clarificationId === ASK)).toBe(true);
  }, 120_000);

  // Red when: a question composed from a ticket reaches MCP with a colour code
  // or a credential shape in it, so the terminal and the screen show different
  // questions. The question never met the capture detector on the way in.
  it("normalizes the question so both surfaces read the same words", async () => {
    await askOnce([
      "Which repository? The build printed \u001B[31mFAILED\u001B[0m and a token ghp_" +
        "B".repeat(300),
    ]);

    const header = roundHeadersPage(await assemble(), {}).items[0]!;

    expect(header.question.questions[0]).not.toContain("\u001B");
    expect(header.question.questions[0]).not.toContain("ghp_BBBB");
    expect(header.question.questions[0]).toContain("Which repository?");
  }, 120_000);

  // Red when: a round is served to whoever holds a dashboard session, although
  // the question quotes the ticket the asking run was working on.
  it("refuses a subject whose asking run belongs to another organization", async () => {
    await askOnce();

    const error = await assemble(OTHER_ORG).catch((e) => e);

    expect(error).toBeInstanceOf(AgentVisibilityReadError);
    expect((error as AgentVisibilityReadError).statusCode).toBe(404);
  });

  // Red when: one run whose trace lost its organization takes the whole panel
  // down, so a ticket that was asked about all week shows nothing because of a
  // single row. A ticket collects rounds from many runs over months.
  it("serves the rounds it can confirm and names the one it cannot", async () => {
    await askOnce();
    // A second run asked the same subject, and its trace recorded no
    // organization: nothing can say who may read what it asked.
    await seedRun(db, { runId: "wrun_orphan", world, observed: false });
    await seedClarification(db, {
      id: "cl_orphan",
      runId: "wrun_orphan",
      subjectKey: SUBJECT,
      questions: ["Should the web app be in scope too?"],
      askedAt: new Date(CAPTURED_AT.getTime() + 60_000),
    });

    const assembled = await assemble();
    const headers = roundHeadersPage(assembled, {});

    expect(headers.items.map((header) => header.id)).toEqual([ASK]);
    expect(headers.unreadable).toEqual([
      {
        rows: "questions",
        position: 1,
        id: null,
        problem:
          "the run that asked this round recorded no organization for its trace, so who may read it cannot be confirmed",
      },
    ]);
    // The withheld round's own ids stay with whoever may read it.
    expect(JSON.stringify(headers)).not.toContain("cl_orphan");
    expect(JSON.stringify(headers)).not.toContain("wrun_orphan");
  }, 120_000);

  // Red when: the audience read answers for fewer runs than it was asked about
  // and the absence is taken for consent. A row can be missing for reasons that
  // have nothing to do with permission, so a check that reads a present row
  // fails open the day retention, a replica or a bug removes one.
  it("treats a run the audience read did not answer for as unconfirmable", async () => {
    await askOnce();
    const silent = { ...reads(), audiences: async () => new Map<string, string | null>() };

    const error = await assembleSubjectRounds(silent, {
      subjectKey: SUBJECT,
      organizationId: VISIBILITY_ORG,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AgentVisibilityReadError);
    expect((error as AgentVisibilityReadError).statusCode).toBe(404);
  });

  // Red when: a trail event of a round nobody here may read is served with the
  // rounds that are readable, which is the same leak by another door.
  it("leaves out the trail of a round it withheld", async () => {
    await askOnce();
    await seedRun(db, { runId: "wrun_other", world, organizationId: OTHER_ORG });
    await seedClarification(db, {
      id: "cl_other",
      runId: "wrun_other",
      subjectKey: SUBJECT,
      questions: ["Which repository for the other tenant?"],
      askedAt: new Date(CAPTURED_AT.getTime() + 60_000),
    });
    await seedTrailEvent(db, {
      subjectKey: SUBJECT,
      runId: "wrun_other",
      kind: "entry_written",
      event: {
        kind: "entry_written",
        clarificationId: "cl_other",
        repositoryKey: "github:elsewhere/secret",
      },
      at: new Date(CAPTURED_AT.getTime() + 61_000),
    });

    const assembled = await assemble();

    expect(assembled.rounds.map((round) => round.id)).toEqual([ASK]);
    expect(JSON.stringify(assembled.rounds)).not.toContain("github:elsewhere/secret");
    expect(assembled.unreadable[0]!.problem).toContain("another organization");
  }, 120_000);

  // Red when: a subject that never asked anything is an error rather than an
  // empty answer, so a panel cannot tell "no questions" from "broken".
  it("answers a subject with no clarification with no rounds", async () => {
    const headers = roundHeadersPage(await assemble(), {});

    expect(headers.items).toEqual([]);
    expect(headers.total).toBe(0);
    expect(headers.unreadable).toEqual([]);
  });

  // Red when: a round id nobody has answers the same way as a subject nobody
  // has, so a caller cannot tell a stale id from a wrong subject.
  it("names what a round id is when asked for one the subject has not", async () => {
    await askOnce();

    const error = (() => {
      try {
        return roundDeliveriesPage({ rounds: [], unreadable: [], deliveryIds: new Map() }, "cl_nope", {});
      } catch (e) {
        return e;
      }
    })();

    expect((error as AgentVisibilityReadError).statusCode).toBe(404);
    expect((error as AgentVisibilityReadError).message).toContain("FIRST ask");
  });
});
