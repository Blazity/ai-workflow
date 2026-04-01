import { describe, it, expect } from "vitest";
import { buildWrapperScript } from "./wrapper-script.js";

describe("buildWrapperScript", () => {
  it("generates a bash script that runs claude and writes sentinel", () => {
    const script = buildWrapperScript({ model: "claude-opus-4-6" });

    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("claude");
    expect(script).toContain("claude-opus-4-6");
    expect(script).toContain("/tmp/agent-done");
    expect(script).toContain("/tmp/agent-stdout.txt");
    expect(script).toContain("/tmp/agent-stderr.txt");
    expect(script).not.toContain("git commit"); // agent commits via stop hook, not wrapper
  });

  it("includes json-schema flag", () => {
    const script = buildWrapperScript({ model: "claude-opus-4-6" });
    expect(script).toContain("--json-schema");
    expect(script).toContain("--output-format json");
  });
});
