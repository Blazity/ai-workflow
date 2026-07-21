import { createHook } from "workflow";

interface ClarificationState {
  completedBlocks: string[];
  definitionVersion: number;
}

interface ClarificationAnswer {
  answer: string;
}

export async function probeClarificationHook(
  token: string,
  state: ClarificationState,
) {
  "use workflow";

  const hook = createHook<ClarificationAnswer>({ token });
  try {
    const conflict = await hook.getConflict();
    if (conflict) {
      return {
        status: "conflict" as const,
        conflictingRunId: conflict.runId,
      };
    }

    const payload = await hook;
    return {
      status: "resumed" as const,
      answer: payload.answer,
      state,
    };
  } finally {
    hook.dispose();
  }
}
