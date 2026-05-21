import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../env.js", () => ({ env: {} }));

const mockGetPromptByTag = vi.fn();
vi.mock("../sandbox/arthur-client.js", () => ({
  ArthurClient: {
    fromTraceEndpoint: vi.fn(() => ({ getPromptByTag: mockGetPromptByTag })),
  },
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: vi.fn(), stat: vi.fn(), lstat: vi.fn(), realpath: vi.fn() },
  readFile: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
}));

import { loadPrompts, loadReviewPrompt } from "./prompts-step.js";
import { PROMPT_FALLBACKS, BUILTIN_REVIEW_PROMPTS } from "../lib/prompts.js";
import * as fsPromises from "node:fs/promises";

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

describe("loadReviewPrompt", () => {
  beforeEach(async () => {
    mockGetPromptByTag.mockReset();
    (fsPromises.readFile as unknown as ReturnType<typeof vi.fn>).mockReset();
    (fsPromises.stat as unknown as ReturnType<typeof vi.fn>).mockReset();
    (fsPromises.lstat as unknown as ReturnType<typeof vi.fn>).mockReset();
    (fsPromises.realpath as unknown as ReturnType<typeof vi.fn>).mockReset();
    // Default: stat returns a small regular file. Individual tests override.
    (fsPromises.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
      size: 100,
    });
    (fsPromises.lstat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isSymbolicLink: () => false,
    });
    (fsPromises.realpath as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (p: string) => p,
    );
    await setEnv({
      GENAI_ENGINE_API_KEY: undefined,
      GENAI_ENGINE_TRACE_ENDPOINT: undefined,
      GENAI_ENGINE_PROMPT_TASK_ID: undefined,
    });
  });

  it("loads a builtin prompt", async () => {
    const r = await loadReviewPrompt({ source: "builtin", name: "pr-review" });
    expect(r.body).toBe(BUILTIN_REVIEW_PROMPTS["pr-review"]);
    expect(r.source_kind).toBe("builtin");
    expect(r.source_id).toBe("builtin:pr-review");
    expect(r.fallback_used).toBe(false);
    expect(r.hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("throws for unknown builtin", async () => {
    await expect(
      loadReviewPrompt({ source: "builtin", name: "nope" }),
    ).rejects.toThrow(/unknown builtin/);
  });

  it("loads a local prompt with a valid relative path", async () => {
    const path = await import("node:path");
    (fsPromises.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce("local body");
    const r = await loadReviewPrompt({ source: "local", path: "prompts/review.md" });
    expect(r.body).toBe("local body");
    expect(r.source_kind).toBe("local");
    expect(r.source_id).toBe(`local:${path.resolve(process.cwd(), "prompts/review.md")}`);
    expect(r.fallback_used).toBe(false);
  });

  it("rejects a path-traversal attempt", async () => {
    await expect(
      loadReviewPrompt({ source: "local", path: "../../etc/passwd" }),
    ).rejects.toThrow(/escapes deployment repo root/);
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it("rejects an absolute path outside the repo root", async () => {
    await expect(
      loadReviewPrompt({ source: "local", path: "/etc/passwd" }),
    ).rejects.toThrow(/escapes deployment repo root/);
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it("rejects a missing file with a clear error", async () => {
    (fsPromises.stat as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    await expect(
      loadReviewPrompt({ source: "local", path: "prompts/missing.md" }),
    ).rejects.toThrow(/prompt file not found at/);
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it("rejects a file larger than the 256 KB cap", async () => {
    (fsPromises.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      isFile: () => true,
      size: 256 * 1024 + 1,
    });
    await expect(
      loadReviewPrompt({ source: "local", path: "prompts/huge.md" }),
    ).rejects.toThrow(/exceeds 262144 byte cap/);
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it("arthur source: falls back to builtin when Arthur env not configured", async () => {
    const r = await loadReviewPrompt({ source: "arthur", name: "style-review", tag: "production" });
    expect(r.fallback_used).toBe(true);
    expect(r.source_kind).toBe("builtin");
    expect(r.source_id).toBe("builtin:pr-review");
  });

  it("arthur source: returns Arthur body when available", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "task-uuid",
    });
    mockGetPromptByTag.mockResolvedValueOnce("arthur body");
    const r = await loadReviewPrompt({ source: "arthur", name: "style-review", tag: "production" });
    expect(r.body).toBe("arthur body");
    expect(r.source_kind).toBe("arthur");
    expect(r.source_id).toBe("arthur:style-review@production");
    expect(r.fallback_used).toBe(false);
  });

  it("arthur source: falls back to builtin when client throws", async () => {
    await setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "task-uuid",
    });
    mockGetPromptByTag.mockRejectedValueOnce(new Error("boom"));
    const r = await loadReviewPrompt({ source: "arthur", name: "style-review" });
    expect(r.fallback_used).toBe(true);
    expect(r.source_kind).toBe("builtin");
  });
});
