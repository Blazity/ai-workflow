import type { EffectivePromptCompilation, EffectivePromptPart } from "@shared/prompts";
import type {
  BlockExecutionResult,
  InvocationPromptCompiler,
} from "../blocks/support/types.js";

type AgentInputResult =
  | {
      ok: true;
      /** The prompt to send. */
      input: string;
      /** What `input` was compiled from, section by section and part by part.
       *  Null only on the fallback path, which nothing compiled. */
      compilation: EffectivePromptCompilation | null;
    }
  | {
      ok: false;
      result: Extract<BlockExecutionResult, { kind: "execution_error" }>;
    };

export async function resolveAgentInput(input: {
  compileInvocationPrompt?: InvocationPromptCompiler;
  sandboxId: string | null;
  blockPrompt: string;
  runtimeData: readonly EffectivePromptPart[];
  fallbackInput: string;
}): Promise<AgentInputResult> {
  if (!input.compileInvocationPrompt) {
    return { ok: true, input: input.fallbackInput, compilation: null };
  }
  const compiled = await input.compileInvocationPrompt({
    blockPrompt: input.blockPrompt,
    runtimeData: input.runtimeData,
    sandboxId: input.sandboxId,
  });
  return compiled.ok
    ? { ok: true, input: compiled.compilation.prompt, compilation: compiled.compilation }
    : { ok: false, result: compiled.result };
}
