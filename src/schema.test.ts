import { describe, it, expect } from "vitest";

describe("schema", () => {
  describe("enums", () => {
    it("exports ticket source enum with expected values", async () => {
      const { ticketSourceEnum } = await import("./schema.js");
      expect(ticketSourceEnum.enumValues).toEqual(["jira", "linear"]);
    });

    it("exports ticket status enum with expected values", async () => {
      const { ticketStatusEnum } = await import("./schema.js");
      expect(ticketStatusEnum.enumValues).toEqual([
        "queued",
        "in_progress",
        "clarifying",
        "in_review",
        "done",
        "failed",
      ]);
    });

    it("exports agent run status enum with expected values", async () => {
      const { agentRunStatusEnum } = await import("./schema.js");
      expect(agentRunStatusEnum.enumValues).toEqual([
        "provisioning",
        "running",
        "reviewing",
        "fixing",
        "merging",
        "completed",
        "failed",
        "cancelled",
      ]);
    });

    it("exports agent run trigger enum with expected values", async () => {
      const { agentRunTriggerEnum } = await import("./schema.js");
      expect(agentRunTriggerEnum.enumValues).toEqual([
        "new",
        "review_fix",
        "clarification_answer",
      ]);
    });
  });

  describe("tables", () => {
    it("exports tickets table", async () => {
      const { tickets } = await import("./schema.js");
      expect(tickets).toBeDefined();
    });

    it("exports agentRuns table", async () => {
      const { agentRuns } = await import("./schema.js");
      expect(agentRuns).toBeDefined();
    });
  });
});
