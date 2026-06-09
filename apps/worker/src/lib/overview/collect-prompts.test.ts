import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../env.js", () => ({ env: {} }));

const mockGetPromptByTag = vi.fn();
const mockListPromptVersions = vi.fn();
vi.mock("../../sandbox/arthur-client.js", () => ({
  ArthurClient: {
    fromTraceEndpoint: vi.fn(() => ({
      getPromptByTag: mockGetPromptByTag,
      listPromptVersions: mockListPromptVersions,
    })),
  },
}));

import { resolvePrompts } from "./collect-prompts.js";
import { PROMPT_FALLBACKS } from "../prompts.js";

async function setEnv(partial: Record<string, string | undefined>) {
  const mod = (await import("../../../env.js")) as unknown as {
    env: Record<string, string | undefined>;
  };
  mod.env = { ...mod.env, ...partial };
}

function arthurVersion(version: number, tags: string[]) {
  return {
    version,
    created_at: `2026-06-0${version}T00:00:00.000Z`,
    deleted_at: null,
    model_provider: "anthropic",
    model_name: "claude-opus-4-6",
    tags,
    num_messages: 1,
    num_tools: 0,
  };
}

describe("resolvePrompts", () => {
  beforeEach(async () => {
    mockGetPromptByTag.mockReset();
    mockListPromptVersions.mockReset();
    await setEnv({
      AGENT_KIND: "claude",
      CLAUDE_MODEL: "claude-opus-4-6",
      CODEX_MODEL: "gpt-5-codex",
      GENAI_ENGINE_API_KEY: undefined,
      GENAI_ENGINE_TRACE_ENDPOINT: undefined,
      GENAI_ENGINE_PROMPT_TASK_ID: undefined,
    });
  });

  it("returns fallbacks with empty versions when Arthur is disabled", async () => {
    const { arthurEnabled, prompts } = await resolvePrompts({ withVersions: true });
    expect(arthurEnabled).toBe(false);
    expect(prompts).toHaveLength(3);
    expect(prompts.map((p) => p.name)).toEqual(["research-plan", "implement", "review"]);
    for (const p of prompts) {
      expect(p.source).toBe("fallback");
      expect(p.versions).toEqual([]);
      expect(p.model).toBe("claude-opus-4-6");
    }
    expect(prompts[0].body).toBe(PROMPT_FALLBACKS["research-plan"]);
    expect(prompts[0].phase).toBe("Research & Plan");
    expect(mockGetPromptByTag).not.toHaveBeenCalled();
  });

  it("returns fallbacks when PROMPT_TASK_ID is missing even if key+endpoint are set", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: undefined,
    });
    const { arthurEnabled, prompts } = await resolvePrompts({ withVersions: true });
    expect(arthurEnabled).toBe(false);
    expect(prompts[0].source).toBe("fallback");
    expect(mockGetPromptByTag).not.toHaveBeenCalled();
  });

  it("resolves Arthur bodies + version history when enabled, attaching the production body", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "00000000-0000-0000-0000-000000000000",
    });
    mockGetPromptByTag.mockResolvedValue("arthur body");
    mockListPromptVersions.mockResolvedValue([
      arthurVersion(2, ["production"]),
      arthurVersion(1, []),
    ]);

    const { arthurEnabled, prompts } = await resolvePrompts({ withVersions: true });
    expect(arthurEnabled).toBe(true);
    expect(mockGetPromptByTag).toHaveBeenCalledTimes(3);
    const research = prompts[0];
    expect(research.source).toBe("arthur");
    expect(research.body).toBe("arthur body");
    expect(research.versions).toHaveLength(2);
    expect(research.versions[0]).toMatchObject({
      version: 2,
      createdAt: "2026-06-02T00:00:00.000Z",
      tags: ["production"],
      modelProvider: "anthropic",
      modelName: "claude-opus-4-6",
      numMessages: 1,
      numTools: 0,
    });
    // production version carries the eager body; the other does not
    expect(research.versions[0].body).toBe("arthur body");
    expect(research.versions[1].body).toBeUndefined();
  });

  it("falls back per-prompt when the production body is missing but keeps versions", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "00000000-0000-0000-0000-000000000000",
    });
    mockGetPromptByTag.mockResolvedValue(null);
    mockListPromptVersions.mockResolvedValue([arthurVersion(1, [])]);

    const { prompts } = await resolvePrompts({ withVersions: true });
    expect(prompts[0].source).toBe("fallback");
    expect(prompts[0].body).toBe(PROMPT_FALLBACKS["research-plan"]);
    expect(prompts[0].versions).toHaveLength(1);
  });

  it("degrades a prompt to fallback with empty versions when the body fetch throws", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "00000000-0000-0000-0000-000000000000",
    });
    mockGetPromptByTag.mockRejectedValue(new Error("boom"));
    mockListPromptVersions.mockResolvedValue([]);

    const { prompts } = await resolvePrompts({ withVersions: true });
    expect(prompts[0].source).toBe("fallback");
    expect(prompts[0].body).toBe(PROMPT_FALLBACKS["research-plan"]);
    expect(prompts[0].versions).toEqual([]);
  });

  it("skips the version fan-out and resolves empty versions when withVersions is false", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "00000000-0000-0000-0000-000000000000",
    });
    mockGetPromptByTag.mockResolvedValue("arthur body");

    const { prompts } = await resolvePrompts({ withVersions: false });
    expect(mockGetPromptByTag).toHaveBeenCalledTimes(3);
    expect(mockListPromptVersions).not.toHaveBeenCalled();
    expect(prompts[0].source).toBe("arthur");
    expect(prompts[0].body).toBe("arthur body");
    expect(prompts[0].versions).toEqual([]);
  });

  it("uses the codex model when AGENT_KIND=codex", async () => {
    await setEnv({ AGENT_KIND: "codex" });
    const { prompts } = await resolvePrompts({ withVersions: true });
    expect(prompts[0].model).toBe("gpt-5-codex");
  });
});
