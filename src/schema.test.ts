import { describe, it, expect } from "vitest";

describe("schema", () => {
  describe("enums", () => {
    it("exports ticket source enum with expected values", async () => {
      const { ticketSourceEnum } = await import("./schema.js");
      expect(ticketSourceEnum.enumValues).toEqual(["jira", "linear"]);
    });

    it("exports workflow state enum with expected values", async () => {
      const { workflowStateEnum } = await import("./schema.js");
      expect(workflowStateEnum.enumValues).toEqual([
        "queued",
        "implementing",
        "clarification_pending",
        "awaiting_review",
        "fixing_feedback",
        "completed",
        "failed",
      ]);
    });

    it("exports run status enum with expected values", async () => {
      const { runStatusEnum } = await import("./schema.js");
      expect(runStatusEnum.enumValues).toEqual([
        "pending",
        "preparing_sandbox",
        "running",
        "succeeded",
        "failed",
        "timed_out",
        "clarification_needed",
      ]);
    });

    it("exports run type enum with expected values", async () => {
      const { runTypeEnum } = await import("./schema.js");
      expect(runTypeEnum.enumValues).toEqual([
        "implementation",
        "review_fix",
        "conflict_resolution",
      ]);
    });
  });

  describe("tables", () => {
    it("exports tickets table", async () => {
      const { tickets } = await import("./schema.js");
      expect(tickets).toBeDefined();
    });

    it("exports runAttempts table", async () => {
      const { runAttempts } = await import("./schema.js");
      expect(runAttempts).toBeDefined();
    });
  });
});
