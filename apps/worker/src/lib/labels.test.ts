import { describe, it, expect } from "vitest";
import { RUN_LABEL_PREFIX, runLabel } from "./labels.js";

describe("runLabel", () => {
  it("prefixes the run id with the run-label prefix", () => {
    expect(runLabel("run_123")).toBe("run:run_123");
    expect(runLabel("run_123").startsWith(RUN_LABEL_PREFIX)).toBe(true);
  });
});
