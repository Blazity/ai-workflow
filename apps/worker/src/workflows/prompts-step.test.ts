import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../env.js", () => ({ env: {} }));

const mockGetPromptByTag = vi.fn();
vi.mock("../sandbox/arthur-client.js", () => ({
  ArthurClient: {
    fromTraceEndpoint: vi.fn(() => ({ getPromptByTag: mockGetPromptByTag })),
  },
}));

import { loadPrompts } from "./prompts-step.js";
import { PROMPT_FALLBACKS } from "../lib/prompts.js";

async function setEnv(partial: Record<string, string | undefined>) {
  const mod = (await import("../../env.js")) as unknown as { env: Record<string, string | undefined> };
  mod.env = { ...mod.env, ...partial };
}

describe("loadPrompts", () => {
  beforeEach(async () => {
    mockGetPromptByTag.mockReset();
    await setEnv({
      GENAI_ENGINE_API_KEY: undefined,
      GENAI_ENGINE_TRACE_ENDPOINT: undefined,
      GENAI_ENGINE_PROMPT_TASK_ID: undefined,
    });
  });

  it("returns fallbacks when no Arthur env is set", async () => {
    const result = await loadPrompts();
    expect(result.research).toBe(PROMPT_FALLBACKS["research-plan"]);
    expect(result.implement).toBe(PROMPT_FALLBACKS["implement"]);
    expect(result.review).toBe(PROMPT_FALLBACKS["review"]);
    expect(mockGetPromptByTag).not.toHaveBeenCalled();
  });

  it("returns fallbacks when PROMPT_TASK_ID is missing even if key+endpoint are set", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: undefined,
    });
    const result = await loadPrompts();
    expect(result.research).toBe(PROMPT_FALLBACKS["research-plan"]);
    expect(mockGetPromptByTag).not.toHaveBeenCalled();
  });

  it("returns Arthur prompts when all three are present", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "prompt-task-uuid",
    });
    mockGetPromptByTag
      .mockResolvedValueOnce("arthur research")
      .mockResolvedValueOnce("arthur implement")
      .mockResolvedValueOnce("arthur review");
    const result = await loadPrompts();
    expect(result).toEqual({
      research: "arthur research",
      implement: "arthur implement",
      review: "arthur review",
    });
    expect(mockGetPromptByTag).toHaveBeenCalledTimes(3);
    const names = mockGetPromptByTag.mock.calls.map((c) => c[1]);
    expect(names).toEqual(["research-plan", "implement", "review"]);
  });

  it("falls back per-prompt when Arthur returns null or throws", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "prompt-task-uuid",
    });
    mockGetPromptByTag
      .mockResolvedValueOnce("arthur research")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("boom"));

    const result = await loadPrompts();
    expect(result.research).toBe("arthur research");
    expect(result.implement).toBe(PROMPT_FALLBACKS["implement"]);
    expect(result.review).toBe(PROMPT_FALLBACKS["review"]);
  });
});
