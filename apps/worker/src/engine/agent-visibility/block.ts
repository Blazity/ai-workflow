/**
 * The briefing of a sandbox send made from inside a block executor.
 *
 * `generic_agent` and `fix_agent` reach the same compiler seam as the
 * specialized agents but from their own files, so the decision of what a
 * sandbox send records lives here once rather than twice.
 */
import type { EffectivePromptCompilation } from "@shared/prompts";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";
import type { WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import type { RepositoryMap } from "../../repository-map/map.js";
import type { RunStartWorkScope } from "../steps/run-start-settings.js";
import { briefingHarness } from "./harness.js";
import {
  nextBriefingIdentity,
  planCompiledBriefing,
  planTextBriefing,
  type AgentBriefingCapture,
  type BriefingInvocation,
  type DeferredBriefing,
} from "./plan.js";
import { selectedRepositoryContext } from "./repository-context.js";

/** What a block executor holds of the run, spelled structurally so this file
 *  does not import the block context types that name it. */
export interface BriefingRunContext {
  runId: string;
  settings: { ENABLE_AGENT_BRIEFINGS: boolean };
  selectedRepositories: readonly WorkspaceRepositoryInput[];
  workScope?: RunStartWorkScope;
}

export function planBlockAgentBriefing(input: {
  execution: BriefingInvocation | undefined;
  ctx: BriefingRunContext;
  /** Null on the fallback path, which composed no sections. */
  compilation: EffectivePromptCompilation | null;
  /** The repository map THIS send rendered, handed over by the composer that
   *  rendered it. Null where the send composed none, and the record then keeps
   *  the workspace list it always did rather than inventing facts.
   *
   *  REQUIRED, and null is a decision rather than a default: a send that
   *  forgets to hand its map over records an empty repositories panel beside a
   *  map the agent plainly read, and nothing goes red. A new send has to say
   *  which of the two it is, at compile time. */
  repositoryMap: RepositoryMap | null;
  prompt: string;
  harness: {
    kind: string;
    model: string;
    runtime?: ResolvedHarnessRuntime | undefined;
    schema?: string | undefined;
  };
  passLabel?: string;
}): AgentBriefingCapture | null {
  const identity = nextBriefingIdentity(input.execution, {
    runId: input.ctx.runId,
    enabled: input.ctx.settings.ENABLE_AGENT_BRIEFINGS,
  });
  if (!identity) return null;
  // Where the repositories were written into the prompt, the same way a
  // discovery send says it. Without it a person reading an agent briefing can
  // see which repositories were in scope but not where the agent was told
  // about them, and the two kinds of briefing would answer different
  // questions. The planner drops it again if that part is not there, which is
  // why the id has to be the one the composer actually emits: the map renders
  // `repository-map`, and the "selected-repositories" part it replaced has not
  // existed since the map landed.
  const renderedIn = input.compilation?.sections.findIndex((section) => section.kind === "runtime");
  const common = {
    ...identity,
    ...(input.passLabel === undefined ? {} : { passLabel: input.passLabel }),
    harness: briefingHarness(input.harness),
    repositoryContext: selectedRepositoryContext({
      repositories: input.ctx.selectedRepositories,
      ...(input.repositoryMap ? { map: input.repositoryMap } : {}),
      ...(input.ctx.workScope ? { workScope: input.ctx.workScope } : {}),
      ...(renderedIn !== undefined && renderedIn >= 0
        ? { renderedAt: { sectionIndex: renderedIn, partId: "repository-map" } }
        : {}),
    }),
  };
  return input.compilation
    ? planCompiledBriefing({
        ...common,
        kind: "agent",
        prompt: input.prompt,
        compilation: input.compilation,
      })
    : planTextBriefing({ ...common, kind: "agent", prompt: input.prompt });
}

/**
 * An in-process model call whose PROMPT ONLY EXISTS INSIDE ITS STEP.
 *
 * `leak_review` screens material the step gathers, so the workflow body has
 * nothing to point a byte range at. It still takes the send's place in this
 * Block Attempt's order here, and the step finishes the record.
 */
export function deferredBriefing(input: {
  execution: BriefingInvocation | undefined;
  ctx: Pick<BriefingRunContext, "runId" | "settings">;
  harness: AgentBriefingCapture["harness"];
  passLabel?: string;
}): DeferredBriefing | null {
  const identity = nextBriefingIdentity(input.execution, {
    runId: input.ctx.runId,
    enabled: input.ctx.settings.ENABLE_AGENT_BRIEFINGS,
  });
  if (!identity) return null;
  return {
    identity,
    harness: input.harness,
    ...(input.passLabel === undefined ? {} : { passLabel: input.passLabel }),
  };
}

/**
 * An in-process model call (`call_llm`, `investigate`).
 *
 * Nothing composes these prompts: they come from a bound input, a block
 * parameter or a helper in the block itself, so the record keeps the exact
 * bytes that went, under one unattributed section, with the system prompt as
 * its own. No repository context: these calls are handed no repositories.
 */
export function planLlmBriefing(input: {
  execution: BriefingInvocation | undefined;
  ctx: Pick<BriefingRunContext, "runId" | "settings">;
  prompt: string;
  system?: string | undefined;
  harness: AgentBriefingCapture["harness"];
  passLabel?: string;
}): AgentBriefingCapture | null {
  const identity = nextBriefingIdentity(input.execution, {
    runId: input.ctx.runId,
    enabled: input.ctx.settings.ENABLE_AGENT_BRIEFINGS,
  });
  if (!identity) return null;
  return planTextBriefing({
    ...identity,
    ...(input.passLabel === undefined ? {} : { passLabel: input.passLabel }),
    kind: "llm",
    harness: input.harness,
    prompt: input.prompt,
    system: input.system,
  });
}
