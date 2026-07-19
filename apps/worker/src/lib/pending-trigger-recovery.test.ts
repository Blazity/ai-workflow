import { describe, expect, it, vi } from "vitest";
import {
  recoverAcceptedTriggerDeliveries,
  recoverOrphanedPendingTriggers,
} from "./pending-trigger-recovery.js";

describe("recoverOrphanedPendingTriggers", () => {
  it("drains only pending subjects that have no active owner", async () => {
    const drain = vi.fn().mockResolvedValue({ result: "started", runId: "run-next" });
    const getActive = vi.fn(async (subjectKey: string) =>
      subjectKey === "ticket:jira:ACTIVE-1" ? { subjectKey } : null,
    );

    const recovered = await recoverOrphanedPendingTriggers({
      listSubjects: vi.fn().mockResolvedValue([
        "ticket:jira:ACTIVE-1",
        "pr:github:acme/app#7",
      ]),
      getActive,
      drain,
    });

    expect(recovered).toEqual({
      scanned: 2,
      blocked: 1,
      attempted: 1,
      started: 1,
      errors: 0,
    });
    expect(drain).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledWith("pr:github:acme/app#7");
  });

  it("leaves a capacity/new-owner race pending for the next poll", async () => {
    const drain = vi.fn().mockResolvedValue({ result: "coalesced" });

    const recovered = await recoverOrphanedPendingTriggers({
      listSubjects: vi.fn().mockResolvedValue(["pr:gitlab:group/app#9"]),
      getActive: vi.fn().mockResolvedValue(null),
      drain,
    });

    expect(recovered).toEqual({
      scanned: 1,
      blocked: 0,
      attempted: 1,
      started: 0,
      errors: 0,
    });
    expect(drain).toHaveBeenCalledOnce();
  });

  it("does not drain a clarification-protected subject when no owner is active", async () => {
    const drain = vi.fn();
    const getActive = vi.fn().mockResolvedValue(null);

    const recovered = await recoverOrphanedPendingTriggers({
      listSubjects: vi.fn().mockResolvedValue(["ticket:jira:AWAITING-1"]),
      isProtected: vi.fn().mockReturnValue(true),
      getActive,
      drain,
    });

    expect(recovered).toEqual({
      scanned: 1,
      blocked: 1,
      attempted: 0,
      started: 0,
      errors: 0,
    });
    expect(getActive).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it("counts a retryable drain result as a recovery error", async () => {
    const recovered = await recoverOrphanedPendingTriggers({
      listSubjects: vi.fn().mockResolvedValue(["pr:github:acme/app#7"]),
      getActive: vi.fn().mockResolvedValue(null),
      drain: vi.fn().mockResolvedValue({ result: "error" }),
    });

    expect(recovered).toEqual({
      scanned: 1,
      blocked: 0,
      attempted: 1,
      started: 0,
      errors: 1,
    });
  });

  it("reports list and per-subject recovery failures without aborting the poll", async () => {
    const onError = vi.fn();
    const listFailure = await recoverOrphanedPendingTriggers({
      listSubjects: vi.fn().mockRejectedValue(new Error("database unavailable")),
      getActive: vi.fn(),
      drain: vi.fn(),
      onError,
    });
    expect(listFailure).toEqual({
      scanned: 0,
      blocked: 0,
      attempted: 0,
      started: 0,
      errors: 1,
    });

    const subjectFailure = await recoverOrphanedPendingTriggers({
      listSubjects: vi.fn().mockResolvedValue(["pr:github:acme/app#7"]),
      getActive: vi.fn().mockRejectedValue(new Error("owner read failed")),
      drain: vi.fn(),
      onError,
    });
    expect(subjectFailure).toEqual({
      scanned: 1,
      blocked: 0,
      attempted: 0,
      started: 0,
      errors: 1,
    });
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe("recoverAcceptedTriggerDeliveries", () => {
  const accepted = {
    status: "accepted",
    result: null,
    subjectKey: "pr:github:acme/app#7",
  } as any;

  it("resumes only accepted deliveries whose subjects have no active owner", async () => {
    const resume = vi.fn().mockResolvedValue({ result: "started", runId: "run-next" });
    const recovered = await recoverAcceptedTriggerDeliveries({
      listDeliveries: vi.fn().mockResolvedValue([
        { ...accepted, subjectKey: "ticket:jira:ACTIVE-1" },
        accepted,
      ]),
      getActive: vi.fn(async (subjectKey: string) =>
        subjectKey === "ticket:jira:ACTIVE-1" ? { subjectKey } : null,
      ),
      resume,
    });

    expect(recovered).toEqual({
      scanned: 2,
      blocked: 1,
      attempted: 1,
      started: 1,
      errors: 0,
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(accepted);
  });

  it("resumes received deliveries before a subject has been enriched", async () => {
    const received = { ...accepted, status: "received", subjectKey: null };
    const getActive = vi.fn();
    const resume = vi.fn().mockResolvedValue({ result: "started", runId: "run-next" });

    const recovered = await recoverAcceptedTriggerDeliveries({
      listDeliveries: vi.fn().mockResolvedValue([received]),
      getActive,
      resume,
    });

    expect(recovered).toEqual({
      scanned: 1,
      blocked: 0,
      attempted: 1,
      started: 1,
      errors: 0,
    });
    expect(getActive).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith(received);
  });

  it("does not resume a clarification-protected accepted delivery without an active owner", async () => {
    const resume = vi.fn();
    const getActive = vi.fn().mockResolvedValue(null);

    const recovered = await recoverAcceptedTriggerDeliveries({
      listDeliveries: vi.fn().mockResolvedValue([accepted]),
      isProtected: vi.fn().mockReturnValue(true),
      getActive,
      resume,
    });

    expect(recovered).toEqual({
      scanned: 1,
      blocked: 1,
      attempted: 0,
      started: 0,
      errors: 0,
    });
    expect(getActive).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("counts a retryable resume result as a recovery error", async () => {
    const recovered = await recoverAcceptedTriggerDeliveries({
      listDeliveries: vi.fn().mockResolvedValue([accepted]),
      getActive: vi.fn().mockResolvedValue(null),
      resume: vi.fn().mockResolvedValue({ result: "error" }),
    });

    expect(recovered).toEqual({
      scanned: 1,
      blocked: 0,
      attempted: 1,
      started: 0,
      errors: 1,
    });
  });
});
