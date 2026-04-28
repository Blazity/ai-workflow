import { describe, it, expect } from "vitest";
import { createAgentAdapter } from "./index.js";

describe("createAgentAdapter", () => {
  it("returns ClaudeAgentAdapter for kind=claude", () => {
    const a = createAgentAdapter("claude");
    expect(a.kind).toBe("claude");
  });

  it("returns CodexAgentAdapter for kind=codex", () => {
    const a = createAgentAdapter("codex");
    expect(a.kind).toBe("codex");
  });

  it("throws for unknown kinds (forces exhaustive switch updates)", () => {
    // @ts-expect-error — runtime guard
    expect(() => createAgentAdapter("bogus")).toThrow();
  });
});
