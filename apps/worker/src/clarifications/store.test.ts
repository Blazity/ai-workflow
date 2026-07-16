import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { clarificationRequests } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  ClarificationStoreError,
  answerClarification,
  createClarificationRequest,
  getClarification,
  getClarificationForRun,
  getPendingForTicket,
  listAnsweredForTicket,
  serializeClarification,
  setDispatchedRunId,
  supersedePendingForTicket,
} from "./store.js";

function seed(ticketKey = "AWT-1") {
  return {
    ticketKey,
    runId: "run-asked",
    blockId: "human_question_1",
    definitionId: 1,
    definitionVersion: 4,
    questions: ["Which environment?", "Ship behind a flag?"],
  };
}

describe("createClarificationRequest", () => {
  it("inserts a pending row with the supplied questions and defaults", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    expect(row.status).toBe("pending");
    expect(row.questions).toEqual(["Which environment?", "Ship behind a flag?"]);
    expect(row.suggestedAnswers).toBeNull();
    expect(row.blockId).toBe("human_question_1");
    expect(row.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("stores suggested answers when supplied", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, {
      ...seed(),
      suggestedAnswers: ["staging", "yes"],
    });
    expect(row.suggestedAnswers).toEqual(["staging", "yes"]);
    const stored = await getClarification(db, row.id);
    expect(stored?.suggestedAnswers).toEqual(["staging", "yes"]);
  });

  it("tolerates a null definition (built-in default graph)", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, {
      ...seed(),
      blockId: null,
      definitionId: null,
      definitionVersion: null,
    });
    expect(row.blockId).toBeNull();
    expect(row.definitionId).toBeNull();
    expect(row.definitionVersion).toBeNull();
  });

  it("supersedes an existing pending row for the same ticket", async () => {
    const db = await createTestDb();
    const first = await createClarificationRequest(db, seed());
    const second = await createClarificationRequest(db, {
      ...seed(),
      questions: ["Second time around?"],
    });

    const firstAfter = await getClarification(db, first.id);
    expect(firstAfter?.status).toBe("superseded");
    expect(second.status).toBe("pending");
    expect(second.questions).toEqual(["Second time around?"]);

    const pending = await getPendingForTicket(db, "AWT-1");
    expect(pending?.id).toBe(second.id);
  });
});

describe("partial unique index", () => {
  it("cannot be violated through the store API", async () => {
    const db = await createTestDb();
    const first = await createClarificationRequest(db, seed());
    const second = await createClarificationRequest(db, seed());
    // Two creates for one ticket leave exactly one pending row (the first was
    // superseded first), so the store never trips the partial unique index.
    expect((await getClarification(db, first.id))?.status).toBe("superseded");
    expect(second.status).toBe("pending");
  });

  it("rejects a second raw pending row for the same ticket", async () => {
    const db = await createTestDb();
    await createClarificationRequest(db, seed());
    await expect(
      db.insert(clarificationRequests).values({
        id: randomUUID(),
        ticketKey: "AWT-1",
        runId: "run-other",
        questions: ["x"],
      }),
    ).rejects.toThrow();
  });
});

describe("answerClarification CAS", () => {
  it("transitions pending -> answered and records the actor", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const answered = await answerClarification(db, {
      id: row.id,
      answer: "Use staging, ship behind a flag.",
      actor: { id: "u1", label: "Alice" },
    });
    expect(answered.status).toBe("answered");
    expect(answered.answer).toBe("Use staging, ship behind a flag.");
    expect(answered.answeredById).toBe("u1");
    expect(answered.answeredByLabel).toBe("Alice");
    expect(answered.answeredAt).toBeInstanceOf(Date);
  });

  it("throws 409 already_answered on a second answer", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    await answerClarification(db, { id: row.id, answer: "first", actor: { id: "u1", label: "Alice" } });
    await expect(
      answerClarification(db, { id: row.id, answer: "second", actor: { id: "u2", label: "Bob" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("throws for an unknown id", async () => {
    const db = await createTestDb();
    await expect(
      answerClarification(db, { id: "missing", answer: "x", actor: { id: "u1", label: "Alice" } }),
    ).rejects.toBeInstanceOf(ClarificationStoreError);
  });
});

describe("listAnsweredForTicket", () => {
  it("excludes pending and superseded rows", async () => {
    const db = await createTestDb();
    const answered = await mkAnswered(db, "AWT-1", new Date("2026-01-01T00:00:00Z"));
    // A superseded row plus a fresh pending row: creating twice supersedes the
    // first pending and leaves the second pending.
    const superseded = await createClarificationRequest(db, seed());
    await createClarificationRequest(db, seed());

    const history = await listAnsweredForTicket(db, "AWT-1");
    expect(history.map((r) => r.id)).toEqual([answered]);
    expect((await getClarification(db, superseded.id))?.status).toBe("superseded");
  });

  it("orders multiple answered rows oldest first", async () => {
    const db = await createTestDb();
    const early = await mkAnswered(db, "AWT-1", new Date("2026-01-01T00:00:00Z"));
    const late = await mkAnswered(db, "AWT-1", new Date("2026-02-01T00:00:00Z"));
    const history = await listAnsweredForTicket(db, "AWT-1");
    expect(history.map((r) => r.id)).toEqual([early, late]);
  });
});

describe("getClarificationForRun", () => {
  it("returns the latest clarification a run asked", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const found = await getClarificationForRun(db, "run-asked");
    expect(found?.id).toBe(row.id);
  });

  it("returns null when the run asked nothing", async () => {
    const db = await createTestDb();
    expect(await getClarificationForRun(db, "run-none")).toBeNull();
  });
});

describe("supersedePendingForTicket", () => {
  it("supersedes the pending row and returns the count", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const count = await supersedePendingForTicket(db, "AWT-1");
    expect(count).toBe(1);
    expect((await getClarification(db, row.id))?.status).toBe("superseded");
    expect(await getPendingForTicket(db, "AWT-1")).toBeNull();
  });

  it("returns 0 when there is nothing pending", async () => {
    const db = await createTestDb();
    expect(await supersedePendingForTicket(db, "AWT-1")).toBe(0);
  });
});

describe("setDispatchedRunId", () => {
  it("records the dispatched resume run", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    await setDispatchedRunId(db, row.id, "run-resumed");
    const after = await getClarification(db, row.id);
    expect(after?.dispatchedRunId).toBe("run-resumed");
  });
});

describe("serializeClarification", () => {
  it("maps every field, rendering timestamps as ISO strings", async () => {
    const db = await createTestDb();
    const created = await createClarificationRequest(db, {
      ...seed(),
      suggestedAnswers: ["staging"],
    });
    const answered = await answerClarification(db, {
      id: created.id,
      answer: "Use staging.",
      actor: { id: "u1", label: "Alice" },
    });
    const dto = serializeClarification(answered);
    expect(dto).toMatchObject({
      id: answered.id,
      ticketKey: "AWT-1",
      runId: "run-asked",
      blockId: "human_question_1",
      definitionId: 1,
      definitionVersion: 4,
      questions: ["Which environment?", "Ship behind a flag?"],
      suggestedAnswers: ["staging"],
      status: "answered",
      answer: "Use staging.",
      answeredById: "u1",
      answeredByLabel: "Alice",
      dispatchedRunId: null,
    });
    expect(dto.askedAt).toBe(answered.askedAt.toISOString());
    expect(dto.answeredAt).toBe(answered.answeredAt!.toISOString());
  });

  it("renders answeredAt as null while pending", async () => {
    const db = await createTestDb();
    const row = await createClarificationRequest(db, seed());
    const dto = serializeClarification(row);
    expect(dto.answeredAt).toBeNull();
    expect(dto.answer).toBeNull();
  });
});

async function mkAt(db: Db, ticketKey: string, askedAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(clarificationRequests).values({
    id,
    ticketKey,
    runId: "run-asked",
    questions: ["x"],
    askedAt,
  });
  return id;
}

async function mkAnswered(db: Db, ticketKey: string, askedAt: Date): Promise<string> {
  const id = await mkAt(db, ticketKey, askedAt);
  await answerClarification(db, { id, answer: "a", actor: { id: "u1", label: "Alice" } });
  return id;
}
