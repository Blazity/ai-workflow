import { describe, it, expect } from "vitest";
import { createAgentAdapter, parseAgentKindOverride } from "./index.js";

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

describe("parseAgentKindOverride", () => {
  it("returns null for empty labels", () => {
    expect(parseAgentKindOverride([])).toBeNull();
  });

  it("returns null when no agent: label present", () => {
    expect(parseAgentKindOverride(["bug", "frontend"])).toBeNull();
  });

  it("recognizes agent:claude", () => {
    expect(parseAgentKindOverride(["agent:claude"])).toBe("claude");
  });

  it("recognizes agent:codex", () => {
    expect(parseAgentKindOverride(["agent:codex"])).toBe("codex");
  });

  it("is case-insensitive", () => {
    expect(parseAgentKindOverride(["Agent:Codex"])).toBe("codex");
    expect(parseAgentKindOverride(["AGENT:CLAUDE"])).toBe("claude");
  });

  it("returns null for unknown agent kinds", () => {
    expect(parseAgentKindOverride(["agent:gemini"])).toBeNull();
  });

  it("returns null when multiple distinct kinds are labeled (ambiguous → fall back to env)", () => {
    expect(
      parseAgentKindOverride(["agent:claude", "agent:codex"]),
    ).toBeNull();
  });

  it("collapses duplicate labels", () => {
    expect(
      parseAgentKindOverride(["agent:codex", "agent:codex"]),
    ).toBe("codex");
  });

  it("ignores labels with the prefix but trailing whitespace is stripped", () => {
    expect(parseAgentKindOverride(["  agent:claude  "])).toBe("claude");
  });
});
