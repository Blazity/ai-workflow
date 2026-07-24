import type {
  BlockExecutionContext,
  BlockExecutionResult,
} from "../workflow-definition/interpreter.js";

type PromptCompiler = NonNullable<
  BlockExecutionContext["compileEffectivePrompt"]
>;

type AgentInputResult =
  | { ok: true; input: string }
  | {
      ok: false;
      result: Extract<BlockExecutionResult, { kind: "execution_error" }>;
    };

export async function resolveAgentInput(input: {
  compileEffectivePrompt?: PromptCompiler;
  sandboxId: string | null;
  blockPrompt: string;
  runtimeData: string;
  fallbackInput: string;
}): Promise<AgentInputResult> {
  if (!input.compileEffectivePrompt) {
    return { ok: true, input: input.fallbackInput };
  }
  const compiled = await input.compileEffectivePrompt({
    blockPrompt: input.blockPrompt,
    runtimeData: input.runtimeData,
    sandboxId: input.sandboxId,
  });
  return compiled.ok
    ? { ok: true, input: compiled.prompt }
    : { ok: false, result: compiled.result };
}
