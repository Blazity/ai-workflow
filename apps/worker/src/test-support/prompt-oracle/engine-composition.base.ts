/**
 * TEST-ONLY ORACLE. Do not import from production code, and do not edit.
 *
 * Two pieces of runtime prompt composition that lived inline in engine code at
 * 57dc151bbadadffebafceec7768f669b1dd6d0ed, lifted out verbatim into functions
 * so the oracle tests can call them:
 *
 * - `researchAdditions`: the planning loop's notes, pushed after the
 *   pre-sandbox additions in engine/agent-workflow.ts:2770-2829.
 * - `genericAgentRuntimeData`: the runtime data of a generic_agent block,
 *   engine/blocks/generic-agent/execute.ts:356-373.
 * - `fixConflictNotes`: the fix agent's conflict note,
 *   engine/blocks/fix-agent/execute.ts:581-585, which the base passed to
 *   assembleFixContext as `conflictNotes`.
 *
 * Each note was rendered by the base assemblers as a pre-sandbox addition, so
 * the oracle returns additions, and the tests render them through
 * context.base.ts exactly as the base code did.
 */
import type { PreSandboxPromptAddition } from "./context.base";

export interface ResearchLoopState {
  priorRequests: unknown[];
  expansionRefusals: string[];
  expansionClosed: boolean;
  ledgerCorrectionNote: string | null;
  noChangeRetryUsed: boolean;
}

export function researchAdditions(
  preSandboxResearchAdditions: PreSandboxPromptAddition[],
  state: ResearchLoopState,
): PreSandboxPromptAddition[] {
  const researchAdditions = [...preSandboxResearchAdditions];
  if (state.priorRequests.length > 0) {
    researchAdditions.push({
      target: ["research" as const],
      title: "Repository expansion history",
      content: [
        "The following repositories were requested and are now attached.",
        "Continue the same research; do not restart from assumptions.",
        JSON.stringify(state.priorRequests),
      ].join("\n"),
    });
  }
  if (state.expansionRefusals.length > 0) {
    researchAdditions.push({
      target: ["research" as const],
      title: "Repository requests this run refused",
      content: [
        ...state.expansionRefusals,
        "Requesting these again changes nothing. Plan with the repositories already attached, and if one of them is genuinely required, say so in the result, naming it and what it is needed for, instead of requesting it.",
      ].join("\n"),
    });
  }
  if (state.expansionClosed) {
    researchAdditions.push({
      target: ["research" as const],
      title: "Repository expansion closed",
      content: [
        "No further repository will be attached to this workspace: requesting one again changes nothing, and repeating the request ends the run.",
        "A repository checked out read-only is checked out again with write access when implementation starts, so needing to write to one is never a reason to request it.",
        "Plan with the repositories already attached. If a repository is genuinely required and is not attached, say so in the result, naming it and what it is needed for, instead of requesting it.",
      ].join("\n"),
    });
  }
  if (state.ledgerCorrectionNote) {
    researchAdditions.push({
      target: ["research" as const],
      title: "Fix the rejected review thread dispositions",
      content: state.ledgerCorrectionNote,
    });
  } else if (state.noChangeRetryUsed) {
    researchAdditions.push({
      target: ["research" as const],
      title: "Do not declare this ticket already resolved",
      content: [
        "A human requested changes in the PR review feedback above, and the previous research pass wrongly concluded no change was needed.",
        "Treat addressing every point of that review feedback as the task: produce an implementation plan for it, declare the writeRepositories it touches, and do not set noChangeNeeded.",
      ].join("\n"),
    });
  }
  return researchAdditions;
}

export function fixConflictNotes(conflictRepos: readonly string[]): { conflictNotes?: string } {
  return conflictRepos.length > 0
    ? {
        conflictNotes: `These repositories have merge conflicts: ${conflictRepos.join(", ")}. Resolve the conflict markers, stage the files, and continue the merge in each repository.`,
      }
    : {};
}

export function genericAgentRuntimeData(
  resolvedInputs: Record<string, unknown>,
  clarificationAnswer: string | undefined,
): string {
  const runtimeInputs = Object.fromEntries(
    Object.entries(resolvedInputs).filter(([name]) => name !== "prompt"),
  );
  const runtimeParts: string[] = [];
  if (Object.keys(runtimeInputs).length > 0) {
    runtimeParts.push(
      `Resolved inputs:\n${JSON.stringify(runtimeInputs, null, 2)}`,
    );
  }
  if (clarificationAnswer) {
    runtimeParts.push(
      `Human clarification answer:\n${clarificationAnswer}`,
    );
  }
  return runtimeParts.join("\n\n");
}
