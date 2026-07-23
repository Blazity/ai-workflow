import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {
    ANTHROPIC_API_KEY: undefined as string | undefined,
    CODEX_API_KEY: undefined as string | undefined,
    CODEX_CHATGPT_OAUTH_TOKEN: undefined as string | undefined,
    GITHUB_APP_ID: undefined as number | undefined,
    GITHUB_APP_PRIVATE_KEY: undefined as string | undefined,
    GITHUB_INSTALLATION_ID: undefined as number | undefined,
    GITLAB_TOKEN: undefined as string | undefined,
    CHAT_SDK_SLACK_TOKEN: undefined as string | undefined,
    CHAT_SDK_CHANNEL_ID: undefined as string | undefined,
    GENAI_ENGINE_API_KEY: undefined as string | undefined,
    GENAI_ENGINE_TRACE_ENDPOINT: undefined as string | undefined,
    AGENT_KIND: "claude" as "claude" | "codex",
    CLAUDE_MODEL: "claude-opus-4-8",
    CODEX_MODEL: "gpt-5-codex",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
  },
}));

vi.mock("../../env.js", () => ({ env: state.env }));

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  state.env.ANTHROPIC_API_KEY = undefined;
  state.env.CODEX_API_KEY = undefined;
  state.env.CODEX_CHATGPT_OAUTH_TOKEN = undefined;
  state.env.GITHUB_APP_ID = undefined;
  state.env.GITHUB_APP_PRIVATE_KEY = undefined;
  state.env.GITHUB_INSTALLATION_ID = undefined;
  state.env.GITLAB_TOKEN = undefined;
  state.env.CHAT_SDK_SLACK_TOKEN = undefined;
  state.env.CHAT_SDK_CHANNEL_ID = undefined;
  state.env.GENAI_ENGINE_API_KEY = undefined;
  state.env.GENAI_ENGINE_TRACE_ENDPOINT = undefined;
  state.env.AGENT_KIND = "claude";
  state.env.CLAUDE_MODEL = "claude-opus-4-8";
  state.env.CODEX_MODEL = "gpt-5-codex";
});

describe("fetchAvailableModels", () => {
  it("falls back when API keys are missing", async () => {
    const { fetchAvailableModels, FALLBACK_MODELS } = await import("./models.js");
    const result = await fetchAvailableModels();
    expect(result.claude).toEqual(FALLBACK_MODELS.claude);
    expect(result.codex).toEqual(FALLBACK_MODELS.codex);
  });

  it("falls back per provider when the fetch rejects", async () => {
    state.env.ANTHROPIC_API_KEY = "sk-ant";
    state.env.CODEX_API_KEY = "sk-openai";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const { fetchAvailableModels, FALLBACK_MODELS } = await import("./models.js");
    const result = await fetchAvailableModels();
    expect(result.claude).toEqual(FALLBACK_MODELS.claude);
    expect(result.codex).toEqual(FALLBACK_MODELS.codex);
  });

  it("keeps gpt-5/codex ids, drops dated snapshots and unrelated ids", async () => {
    state.env.CODEX_API_KEY = "sk-openai";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: "gpt-5" },
            { id: "gpt-5-codex" },
            { id: "gpt-5-2025-01-01" },
            { id: "o3-codex" },
            { id: "gpt-4o" },
            { id: "dall-e-3" },
          ],
        }),
      })),
    );
    const { fetchAvailableModels } = await import("./models.js");
    const result = await fetchAvailableModels();
    expect(result.codex).toEqual(["o3-codex", "gpt-5-codex", "gpt-5"]);
    expect(result.codex).not.toContain("gpt-5-2025-01-01");
    expect(result.codex).not.toContain("gpt-4o");
    expect(result.codex).not.toContain("dall-e-3");
  });

  it("caches results within the TTL and refetches after it expires", async () => {
    state.env.CODEX_API_KEY = "sk-openai";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5-codex" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const { fetchAvailableModels } = await import("./models.js");
    await fetchAvailableModels();
    await fetchAvailableModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(3_600_001);
    await fetchAvailableModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });
});

describe("fetchTicketStatuses", () => {
  it("returns provider statuses and fails closed to the configured fallback path", async () => {
    const { fetchTicketStatuses } = await import("./models.js");
    await expect(
      fetchTicketStatuses({
        listStatuses: vi.fn(async () => [{ id: "1", name: "To Do" }]),
      } as any),
    ).resolves.toEqual([{ id: "1", name: "To Do" }]);
    await expect(
      fetchTicketStatuses({
        listStatuses: vi.fn(async () => {
          throw new Error("Jira unavailable");
        }),
      } as any),
    ).resolves.toEqual([]);
  });
});

describe("buildWorkflowEditorOptions", () => {
  it("dedupes the default model already present in the active kind list", async () => {
    state.env.AGENT_KIND = "claude";
    state.env.CLAUDE_MODEL = "claude-opus-4-8";
    const { buildWorkflowEditorOptions } = await import("./models.js");
    const options = buildWorkflowEditorOptions({
      claude: ["claude-opus-4-8", "claude-sonnet-5"],
      codex: ["gpt-5-codex"],
    });
    expect(options.agentKind).toBe("claude");
    expect(options.defaultModel).toBe("claude-opus-4-8");
    expect(options.models.claude).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
    expect(options.models.codex).toEqual(["gpt-5-codex"]);
    expect(options.ticketStatusTargets).toEqual([
      { value: "ai_review", label: "AI Review" },
      { value: "backlog", label: "Backlog" },
    ]);
  });

  it("uses deduplicated provider-backed ticket statuses when discovery succeeds", async () => {
    const { buildWorkflowEditorOptions } = await import("./models.js");
    const options = buildWorkflowEditorOptions(
      { claude: [], codex: [] },
      [
        { id: "3", name: "Done" },
        { id: "2", name: "In Progress" },
        { id: "3", name: "Done duplicate" },
      ],
    );

    expect(options.ticketStatusTargets).toEqual([
      { value: "3", label: "Done" },
      { value: "2", label: "In Progress" },
    ]);
  });

  it("prepends the default model when absent from the active kind list", async () => {
    state.env.AGENT_KIND = "codex";
    state.env.CODEX_MODEL = "gpt-5-codex-high";
    const { buildWorkflowEditorOptions } = await import("./models.js");
    const options = buildWorkflowEditorOptions({
      claude: [],
      codex: ["gpt-5-codex", "gpt-5"],
    });
    expect(options.agentKind).toBe("codex");
    expect(options.defaultModel).toBe("gpt-5-codex-high");
    expect(options.models.codex).toEqual(["gpt-5-codex-high", "gpt-5-codex", "gpt-5"]);
  });

  it("exposes per-provider default models and prepends each to its own list without duplicates", async () => {
    state.env.AGENT_KIND = "claude";
    state.env.CLAUDE_MODEL = "claude-opus-4-8";
    state.env.CODEX_MODEL = "gpt-5-codex";
    const { buildWorkflowEditorOptions } = await import("./models.js");
    const options = buildWorkflowEditorOptions({
      claude: ["claude-opus-4-8", "claude-sonnet-5"],
      codex: ["gpt-5-codex", "gpt-5"],
    });
    expect(options.defaultModels).toEqual({ claude: "claude-opus-4-8", codex: "gpt-5-codex" });
    expect(options.models.claude[0]).toBe("claude-opus-4-8");
    expect(options.models.codex[0]).toBe("gpt-5-codex");
    expect(options.models.claude).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
    expect(options.models.codex).toEqual(["gpt-5-codex", "gpt-5"]);
  });

  it("exposes the complete environment-aware block registry and fixed run schema", async () => {
    state.env.ANTHROPIC_API_KEY = "sk-ant";
    state.env.GITHUB_APP_ID = 1;
    state.env.GITHUB_APP_PRIVATE_KEY = "key";
    state.env.GITHUB_INSTALLATION_ID = 2;
    const { buildWorkflowEditorOptions } = await import("./models.js");
    const options = buildWorkflowEditorOptions({ claude: [], codex: [] });

    expect(options.blockRegistry.planning_agent.availability).toEqual({
      available: true,
      unavailableReason: null,
    });
    expect(options.blockRegistry.send_slack_message.availability).toEqual({
      available: false,
      unavailableReason: "Slack messaging is not configured.",
    });
    expect(options.blockRegistry.arthur_injection_check.availability).toEqual({
      available: false,
      unavailableReason: "Arthur Engine is not configured.",
    });
    expect(Object.keys(options.blockRegistry)).toHaveLength(29);
    expect(options.runBindingSchema).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        branchName: { type: "string" },
        defaultAgent: { type: "object" },
      },
    });
  });

  it("keeps OAuth-only Codex agents available but disables in-process Call LLM", async () => {
    state.env.AGENT_KIND = "codex";
    state.env.CODEX_CHATGPT_OAUTH_TOKEN = "oauth-token";
    const { buildWorkflowEditorOptions } = await import("./models.js");

    const options = buildWorkflowEditorOptions({ claude: [], codex: [] });

    expect(options.blockRegistry.generic_agent.availability).toEqual({
      available: true,
      unavailableReason: null,
    });
    expect(options.blockRegistry.planning_agent.availability).toEqual({
      available: true,
      unavailableReason: null,
    });
    expect(options.blockRegistry.call_llm.availability).toEqual({
      available: false,
      unavailableReason: "Codex API credentials are not configured for Call LLM.",
    });
  });

  it("keeps Claude Code OAuth agents available but disables in-process Call LLM", async () => {
    state.env.AGENT_KIND = "claude";
    state.env.ANTHROPIC_API_KEY = "sk-ant-oat-test";
    const { buildWorkflowEditorOptions } = await import("./models.js");

    const options = buildWorkflowEditorOptions({ claude: [], codex: [] });

    expect(options.blockRegistry.planning_agent.availability).toEqual({
      available: true,
      unavailableReason: null,
    });
    expect(options.blockRegistry.call_llm.availability).toEqual({
      available: false,
      unavailableReason: "Claude API credentials are not configured for Call LLM.",
    });
  });
});
