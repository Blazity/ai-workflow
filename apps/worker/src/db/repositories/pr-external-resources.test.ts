import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client.js";
import { createTestDb } from "../test-db.js";
import { workflowPrReviewPublications, workflowRuns } from "../schema.js";
import {
  insertPrReviewPublication,
  listPrReviewPublicationsForRound,
  markPrReviewPublicationPublished,
} from "./pr-external-resources.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowRuns).values([{ runId: "run-webhook" }, { runId: "run-manual" }]);
});

function publication(runId: string, repository: string) {
  return {
    id: `pub-${runId}`,
    runId,
    nodeId: "review",
    attempt: 1,
    activationScope: "root",
    provider: "github",
    repository,
    prNumber: 42,
    headSha: "abc123",
    contentHash: `hash-${runId}`,
    decision: "approve",
    summary: "Looks right.",
    inlineCommentCount: 0,
    summaryFallbackCount: 0,
    commentContentHashes: [],
  };
}

describe("the review publication ledger", () => {
  it("finds the review a head already has, whatever case its repository was spelled in", async () => {
    // One head is one review. The webhook's run published under GitHub's
    // spelling; a run dispatched from a pasted URL probes under the person's.
    // Red while the probe compares the spelling: it finds nothing and a second
    // review of the same head is posted beside the first.
    await insertPrReviewPublication(db, publication("run-webhook", "Acme/API"));
    await markPrReviewPublicationPublished(db, {
      id: "pub-run-webhook",
      providerReference: "review-1",
      commentProviderReferences: [],
    });

    await expect(
      listPrReviewPublicationsForRound(db, {
        provider: "github",
        repository: "acme/api",
        prNumber: 42,
        headSha: "abc123",
      }),
    ).resolves.toMatchObject([{ id: "pub-run-webhook", state: "published" }]);
    await expect(db.select().from(workflowPrReviewPublications)).resolves.toMatchObject([
      { repository: "acme/api" },
    ]);
  });
});
