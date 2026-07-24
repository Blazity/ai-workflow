import { describe, expect, it, vi } from "vitest";
import { resolveAgentInput } from "./resolve-agent-input.js";

describe("resolveAgentInput", () => {
  it("uses the assembled fallback when no v2 compiler is present", async () => {
    await expect(
      resolveAgentInput({
        sandboxId: "sandbox",
        blockPrompt: "Authored",
        runtimeData: "Runtime",
        fallbackInput: "Legacy assembled input",
      }),
    ).resolves.toEqual({ ok: true, input: "Legacy assembled input" });
  });

  it("passes prompt sections to the compiler and returns its prompt", async () => {
    const compileEffectivePrompt = vi.fn().mockResolvedValue({
      ok: true,
      prompt: "Compiled prompt",
    });
    await expect(
      resolveAgentInput({
        compileEffectivePrompt,
        sandboxId: "sandbox",
        blockPrompt: "Authored",
        runtimeData: "Runtime",
        fallbackInput: "Legacy",
      }),
    ).resolves.toEqual({ ok: true, input: "Compiled prompt" });
    expect(compileEffectivePrompt).toHaveBeenCalledWith({
      sandboxId: "sandbox",
      blockPrompt: "Authored",
      runtimeData: "Runtime",
    });
  });

  it("propagates compilation failures unchanged", async () => {
    const result = {
      kind: "execution_error" as const,
      error: {
        category: "binding" as const,
        message: "Prompt compilation failed",
      },
    };
    await expect(
      resolveAgentInput({
        compileEffectivePrompt: vi.fn().mockResolvedValue({
          ok: false,
          result,
        }),
        sandboxId: null,
        blockPrompt: "",
        runtimeData: "",
        fallbackInput: "",
      }),
    ).resolves.toEqual({ ok: false, result });
  });
});
