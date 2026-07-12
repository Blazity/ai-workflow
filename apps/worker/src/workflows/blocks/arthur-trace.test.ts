import { describe, expect, it } from "vitest";
import { execute, paramsSchema } from "./arthur-trace.js";
import { makeCtx, makeNode } from "./test-support.js";

describe("arthur_trace paramsSchema", () => {
  it("accepts empty params and an optional taskName", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ taskName: "custom-task" }).success).toBe(true);
    expect(paramsSchema.safeParse({ taskName: "" }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("arthur_trace execute", () => {
  it("is a no-op that continues to the next block", async () => {
    const result = await execute(
      makeNode("arthur_trace", { taskName: "custom-task" }),
      {},
      makeCtx(),
    );
    expect(result).toEqual({ kind: "next", output: { status: "ok" } });
  });
});
