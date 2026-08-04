import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { activeRuns, workflowRuns } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { ActiveRunOwnerError } from "../lib/run-control-errors.js";
import { getHookClarification, prepareHookClarification, publishHookClarification } from "./hook-store.js";
import { reconcileClarificationPickupState } from "./store.js";

const TICKET = "AWT-1";
const SUBJECT = `ticket:jira:${TICKET}`;

const owner = {
  subjectKey: SUBJECT,
  ownerToken: "owner-fresh",
  runId: "run-fresh",
};

async function bindFreshRun(db: Db): Promise<void> {
  await db.insert(activeRuns).values({
    subjectKey: SUBJECT,
    ticketKey: TICKET,
    ownerToken: owner.ownerToken,
    runId: owner.runId,
    state: "bound",
    runKind: "ticket",
  });
}

async function parkPredecessor(db: Db, runId: string, ticketKey = TICKET) {
  const prepared = await prepareHookClarification(db, {
    ticketKey,
    subjectKey: `ticket:jira:${ticketKey}`,
    runId,
    blockId: "question",
    definitionId: 1,
    definitionVersion: 4,
    questions: ["Which repository?"],
  });
  await publishHookClarification(db, prepared.id);
  await db.insert(workflowRuns).values({
    runId,
    subjectKey: `ticket:jira:${ticketKey}`,
    ticketKey,
    status: "awaiting",
  });
  return prepared.id;
}

const runStatus = (db: Db, runId: string) =>
  db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .then((r) => r[0]?.status);

describe("reconcileClarificationPickupState", () => {
  it("supersedes the predecessor's question and takes its run off awaiting", async () => {
    const db = await createTestDb();
    await bindFreshRun(db);
    const parked = await parkPredecessor(db, "run-parked");

    const result = await reconcileClarificationPickupState(db, {
      ticketKey: TICKET,
      currentRunId: owner.runId,
      owner,
    });

    expect(result).toEqual({ superseded: 1, resolvedAwaiting: 1 });
    expect((await getHookClarification(db, parked))?.status).toBe("superseded");
    expect(await runStatus(db, "run-parked")).toBe("blocked");
  });

  it("never touches the picking-up run or another ticket's parked run", async () => {
    const db = await createTestDb();
    await bindFreshRun(db);
    await db.insert(workflowRuns).values({
      runId: owner.runId,
      subjectKey: SUBJECT,
      ticketKey: TICKET,
      status: "awaiting",
    });
    await parkPredecessor(db, "run-other-ticket", "AWT-2");

    const result = await reconcileClarificationPickupState(db, {
      ticketKey: TICKET,
      currentRunId: owner.runId,
      owner,
    });

    expect(result).toEqual({ superseded: 0, resolvedAwaiting: 0 });
    expect(await runStatus(db, owner.runId)).toBe("awaiting");
    expect(await runStatus(db, "run-other-ticket")).toBe("awaiting");
  });

  it("is safe to repeat after a step retry", async () => {
    const db = await createTestDb();
    await bindFreshRun(db);
    await parkPredecessor(db, "run-parked");

    const first = await reconcileClarificationPickupState(db, {
      ticketKey: TICKET,
      currentRunId: owner.runId,
      owner,
    });
    const second = await reconcileClarificationPickupState(db, {
      ticketKey: TICKET,
      currentRunId: owner.runId,
      owner,
    });

    expect(first).toEqual({ superseded: 1, resolvedAwaiting: 1 });
    expect(second).toEqual({ superseded: 0, resolvedAwaiting: 0 });
    expect(await runStatus(db, "run-parked")).toBe("blocked");
  });

  it("refuses to reconcile without the exact bound owner", async () => {
    const db = await createTestDb();
    await bindFreshRun(db);
    await parkPredecessor(db, "run-parked");

    await expect(
      reconcileClarificationPickupState(db, {
        ticketKey: TICKET,
        currentRunId: owner.runId,
        owner: { ...owner, ownerToken: "owner-foreign" },
      }),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);
    expect(await runStatus(db, "run-parked")).toBe("awaiting");
  });
});
