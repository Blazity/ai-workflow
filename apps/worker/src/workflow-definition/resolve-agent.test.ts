import { describe, it, expect } from "vitest";
import { requiredAgentKinds, resolveBlockAgent, resolveRunDefaultKind } from "./resolve-agent.js";

const defaults = { claude: "claude-default", codex: "codex-default" };

describe("resolveRunDefaultKind", () => {
  it("uses the label override when present", () => {
    expect(resolveRunDefaultKind("codex", "claude")).toBe("codex");
    expect(resolveRunDefaultKind("claude", "codex")).toBe("claude");
  });

  it("falls back to the env kind when no label override", () => {
    expect(resolveRunDefaultKind(null, "codex")).toBe("codex");
    expect(resolveRunDefaultKind(null, "claude")).toBe("claude");
  });
});

describe("resolveBlockAgent", () => {
  it("uses the block provider over the run default", () => {
    expect(resolveBlockAgent({ provider: "codex" }, "claude", defaults).kind).toBe("codex");
    expect(resolveBlockAgent({ provider: "claude" }, "codex", defaults).kind).toBe("claude");
  });

  it("falls back to the default kind when provider is missing or invalid", () => {
    expect(resolveBlockAgent(undefined, "claude", defaults).kind).toBe("claude");
    expect(resolveBlockAgent({}, "codex", defaults).kind).toBe("codex");
    expect(resolveBlockAgent({ provider: "gpt" }, "claude", defaults).kind).toBe("claude");
  });

  it("prefers a non-empty trimmed model param", () => {
    expect(resolveBlockAgent({ model: "  custom  " }, "claude", defaults).model).toBe("custom");
  });

  it("falls back to the resolved kind's default model, not the run default's", () => {
    // provider flips to codex, so the model default must be the codex default.
    expect(resolveBlockAgent({ provider: "codex" }, "claude", defaults).model).toBe("codex-default");
    // empty / whitespace model also falls back per resolved kind.
    expect(resolveBlockAgent({ provider: "codex", model: "   " }, "claude", defaults).model).toBe(
      "codex-default",
    );
    expect(resolveBlockAgent({ model: "" }, "claude", defaults).model).toBe("claude-default");
  });

  it("resolves a pinned built-in Harness Profile at the executor boundary", () => {
    expect(
      resolveBlockAgent(
        {
          harnessProfile: {
            profileId: "builtin-codex",
            version: 1,
          },
        },
        "claude",
        defaults,
      ),
    ).toEqual({ kind: "codex", model: "gpt-5-codex" });
  });
});

describe("requiredAgentKinds", () => {
  const block = (type: string, provider?: string) => ({
    type,
    params: provider ? { provider } : {},
  });

  it("always lists the run default first", () => {
    expect(requiredAgentKinds([], "claude")).toEqual(["claude"]);
    expect(requiredAgentKinds([block("planning_agent")], "codex")).toEqual(["codex"]);
  });

  it("adds a distinct pinned provider after the default", () => {
    expect(
      requiredAgentKinds(
        [block("planning_agent"), block("implementation_agent", "codex")],
        "claude",
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("provisions the provider pinned by a built-in Harness Profile", () => {
    expect(
      requiredAgentKinds(
        [{
          type: "planning_agent",
          params: {
            harnessProfile: {
              profileId: "builtin-codex",
              version: 1,
            },
          },
        }],
        "claude",
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("dedupes repeated kinds", () => {
    expect(
      requiredAgentKinds(
        [
          block("planning_agent", "codex"),
          block("implementation_agent", "codex"),
          block("review_agent", "codex"),
        ],
        "claude",
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("still includes the default when every agent block is pinned away from it", () => {
    expect(
      requiredAgentKinds(
        [block("planning_agent", "codex"), block("implementation_agent", "codex")],
        "claude",
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("ignores non-agent blocks", () => {
    expect(
      requiredAgentKinds(
        [block("trigger_ticket_ai", "codex"), block("open_pr", "codex")],
        "claude",
      ),
    ).toEqual(["claude"]);
  });
});
