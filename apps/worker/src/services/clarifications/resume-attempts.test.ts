import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { clarificationRequests, workflowRuns } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import {
  reserveResumeAttempt,
  terminalizeExhaustedResume,
} from "./resume-attempts.js";

const CLARIFICATION_ID = "clarification-attempts";
const RUN_ID = "run-attempts";
const ANSWERED_AT = new Date("2026-09-09T10:00:00.000Z");

let db: Db;

async function seedAnswered(resumeAttempts: number) {
  await db.insert(clarificationRequests).values({
    id: CLARIFICATION_ID,
    subjectKey: "ticket:jira:AIW-279",
    ticketKey: "AIW-279",
    runId: RUN_ID,
    questions: ["Which option?"],
    status: "answered",
    hookToken: "clarification:attempts",
    answer: "Option A",
    answeredAt: ANSWERED_AT,
    resumeAttempts,
  });
  await db.insert(workflowRuns).values({
    runId: RUN_ID,
    status: "awaiting",
  });
}

beforeEach(async () => {
  db = await createTestDb();
});

describe("clarification resume attempt reservations", () => {
  it("lets exactly one caller reserve the third delivery attempt", async () => {
    await seedAnswered(2);

    expect(
      await reserveResumeAttempt(db, CLARIFICATION_ID, ANSWERED_AT),
    ).toEqual({ attempt: 3, answeredAt: ANSWERED_AT });
    expect(
      await reserveResumeAttempt(db, CLARIFICATION_ID, ANSWERED_AT),
    ).toBeNull();
  });

  it("rejects a stale caller after the answer timestamp changes", async () => {
    await seedAnswered(1);
    const newerAnsweredAt = new Date("2026-09-09T10:01:00.000Z");
    await db
      .update(clarificationRequests)
      .set({ answeredAt: newerAnsweredAt, resumeAttempts: 0 })
      .where(eq(clarificationRequests.id, CLARIFICATION_ID));

    expect(
      await reserveResumeAttempt(db, CLARIFICATION_ID, ANSWERED_AT),
    ).toBeNull();

    const [stored] = await db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.id, CLARIFICATION_ID));
    expect(stored?.answeredAt).toEqual(newerAnsweredAt);
    expect(stored?.resumeAttempts).toBe(0);
  });
});

describe("clarification resume answer generation race", () => {
  it("does not terminalize a newer answer generation from a stale third reservation", async () => {
    await seedAnswered(2);
    const reservation = await reserveResumeAttempt(db, CLARIFICATION_ID, ANSWERED_AT);
    expect(reservation).toEqual({ attempt: 3, answeredAt: ANSWERED_AT });

    const newerAnsweredAt = new Date("2026-09-09T10:01:00.000Z");
    await db
      .update(clarificationRequests)
      .set({
        answeredAt: newerAnsweredAt,
        status: "answered",
        resumeAttempts: 0,
      })
      .where(eq(clarificationRequests.id, CLARIFICATION_ID));

    const subject = {
      id: CLARIFICATION_ID,
      runId: RUN_ID,
      ticketKey: "AIW-279",
      subjectKey: "ticket:jira:AIW-279",
    };
    expect(
      await terminalizeExhaustedResume(
        db,
        subject,
        reservation!.answeredAt,
        "stale transport failure",
      ),
    ).toBe(false);

    const [clarification] = await db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.id, CLARIFICATION_ID));
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, RUN_ID));
    expect(clarification?.answeredAt).toEqual(newerAnsweredAt);
    expect(clarification?.status).toBe("answered");
    expect(clarification?.resumeAttempts).toBe(0);
    expect(run?.status).toBe("awaiting");
    expect(run?.statusReason).toBe(null);
  });
});

describe("clarification resume terminal transition", () => {
  it("changes the clarification and run exactly once when applied twice", async () => {
    await seedAnswered(3);
    const subject = {
      id: CLARIFICATION_ID,
      runId: RUN_ID,
      ticketKey: "AIW-279",
      subjectKey: "ticket:jira:AIW-279",
    };

    expect(
      await terminalizeExhaustedResume(db, subject, ANSWERED_AT, "transport failed"),
    ).toBe(true);
    expect(
      await terminalizeExhaustedResume(db, subject, ANSWERED_AT, "different error"),
    ).toBe(false);

    const [clarification] = await db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.id, CLARIFICATION_ID));
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, RUN_ID));
    expect(clarification?.status).toBe("resume_failed");
    expect(run?.status).toBe("failed");
    expect(run?.statusReason).toContain("transport failed");
    expect(run?.statusReason).not.toContain("different error");
  });
});

describe("clarification resume terminal run race", () => {
  it("terminalizes the clarification without overwriting an already cancelled run", async () => {
    await seedAnswered(3);
    await db
      .update(workflowRuns)
      .set({ status: "blocked", statusReason: "Cancelled by Ada." })
      .where(eq(workflowRuns.runId, RUN_ID));
    const subject = {
      id: CLARIFICATION_ID,
      runId: RUN_ID,
      ticketKey: "AIW-279",
      subjectKey: "ticket:jira:AIW-279",
    };

    expect(
      await terminalizeExhaustedResume(db, subject, ANSWERED_AT, "transport failed"),
    ).toBe(true);

    const [clarification] = await db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.id, CLARIFICATION_ID));
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, RUN_ID));
    expect(clarification?.status).toBe("resume_failed");
    expect(run?.status).toBe("blocked");
    expect(run?.statusReason).toBe("Cancelled by Ada.");
  });
});
