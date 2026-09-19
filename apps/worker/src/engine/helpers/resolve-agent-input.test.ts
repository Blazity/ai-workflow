import { describe, expect, it, vi } from "vitest";
import type { EffectivePromptCompilation, EffectivePromptPart } from "@shared/prompts";
import { resolveAgentInput } from "./resolve-agent-input.js";

const runtimeData: EffectivePromptPart[] = [
  { id: "ticket", title: "Ticket", content: "Runtime", origin: { kind: "ticket" } },
];

describe("resolveAgentInput", () => {
  it("uses the assembled fallback when no v2 compiler is present, with nothing compiled", async () => {
    await expect(
      resolveAgentInput({
        sandboxId: "sandbox",
        blockPrompt: "Authored",
        runtimeData,
        fallbackInput: "Legacy assembled input",
      }),
    ).resolves.toEqual({ ok: true, input: "Legacy assembled input", compilation: null });
  });

  it("passes the runtime parts to the compiler and returns its prompt with the compilation", async () => {
    const compilation = {
      prompt: "Compiled prompt",
      hash: "h",
      sections: [],
      provenance: [],
      unresolvedSources: [],
      issues: [],
      profileContext: null,
    } satisfies EffectivePromptCompilation;
    const compileInvocationPrompt = vi.fn().mockResolvedValue({ ok: true, compilation });
    await expect(
      resolveAgentInput({
        compileInvocationPrompt,
        sandboxId: "sandbox",
        blockPrompt: "Authored",
        runtimeData,
        fallbackInput: "Legacy",
      }),
    ).resolves.toEqual({ ok: true, input: "Compiled prompt", compilation });
    expect(compileInvocationPrompt).toHaveBeenCalledWith({
      sandboxId: "sandbox",
      blockPrompt: "Authored",
      runtimeData,
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
        compileInvocationPrompt: vi.fn().mockResolvedValue({
          ok: false,
          result,
        }),
        sandboxId: null,
        blockPrompt: "",
        runtimeData: [],
        fallbackInput: "",
      }),
    ).resolves.toEqual({ ok: false, result });
  });
});
