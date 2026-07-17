import { describe, expect, it, vi } from "vitest";
import { recoverOrphanedPendingTriggers } from "./pending-trigger-recovery.js";

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

    expect(recovered).toBe(1);
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

    expect(recovered).toBe(0);
    expect(drain).toHaveBeenCalledOnce();
  });
});
