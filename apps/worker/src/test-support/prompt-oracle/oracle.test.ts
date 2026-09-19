import { describe, expect, it } from "vitest";
import {
  compileEffectivePrompt,
  joinPromptParts,
  type EffectivePromptPart,
} from "@shared/prompts";
import * as base from "./context.base";
import { assembleRepositoryDiscoveryPrompt as baseDiscovery } from "./discovery.base";
import {
  fixConflictNotes,
  genericAgentRuntimeData as baseGenericRuntimeData,
  researchAdditions,
} from "./engine-composition.base";
import {
  discoveryRows,
  fixRows,
  genericRows,
  implementationRows,
  researchRows,
  reviewRows,
  type MatrixRow,
} from "./matrix";
import {
  assembleFixContext,
  assembleImplementationContext,
  assembleResearchPlanContext,
  assembleReviewContext,
  fixContextParts,
  implementationContextParts,
  researchPlanContextParts,
  reviewContextParts,
  type FixContextInput,
  type PreSandboxPromptAddition,
  type ResearchPlanContextInput,
} from "../../sandbox/context.js";
import {
  assembleRepositoryDiscoveryPrompt,
  composeRepositoryDiscoveryPrompt,
} from "../../engine/repository-discovery/runner.js";
import { genericAgentRuntimeData } from "../../engine/blocks/generic-agent/execute.js";

/**
 * What a composer did with one input: the text, or the refusal. Two renderers
 * refuse (a duplicated or escaping workspace path), and the oracle holds the
 * refusal to the same message as the text.
 */
type Outcome = { text: string } | { error: string };

function outcome(compose: () => string): Outcome {
  try {
    return { text: compose() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function mismatchesOf<T>(
  rows: MatrixRow<T>[],
  oracle: (input: T) => string,
  current: (input: T) => string,
): string[] {
  return rows.flatMap((row) => {
    const expected = outcome(() => oracle(row.input));
    const actual = outcome(() => current(row.input));
    return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [row.name];
  });
}

/**
 * THE ONE DECLARED CHANGE. An addition the run makes after the pre-sandbox
 * phase (a planning note, discovery's left-out repositories, the review change
 * set) no longer carries the "Pre-Sandbox" label and the sentence claiming it
 * was produced before sandbox creation, which was false of it. Applied to the
 * oracle's text addition by addition, in render order, and each rewrite must
 * find its exact block, so this can take away that label and nothing else.
 */
function withoutFalsePreSandboxLabel(
  text: string,
  midRunAdditions: readonly PreSandboxPromptAddition[],
): string {
  let cursor = 0;
  let result = text;
  for (const addition of midRunAdditions) {
    const labelled = `## Pre-Sandbox: ${addition.title}\n\nThis information was produced before sandbox creation.\n\n${addition.content}`;
    const at = result.indexOf(labelled, cursor);
    if (at < 0) throw new Error(`the oracle text has no labelled block for "${addition.title}"`);
    const unlabelled = `## ${addition.title}\n\n${addition.content}`;
    result = result.slice(0, at) + unlabelled + result.slice(at + labelled.length);
    cursor = at + unlabelled.length;
  }
  return result;
}

const midRun = (additions: readonly PreSandboxPromptAddition[] | undefined) =>
  (additions ?? []).filter((addition) => addition.producedBy !== undefined);

/** The base research prompt: the loop's notes were additions then, pushed after
 *  the pre-sandbox ones, and every one of them is a mid-run addition. */
function baseResearch(input: ResearchPlanContextInput): string {
  const notes = input.researchNotes;
  const preSandbox = input.preSandboxAdditions ?? [];
  const additions = notes
    ? researchAdditions(preSandbox, {
        priorRequests: [...notes.priorRequests],
        expansionRefusals: notes.refusals.map((refusal) => refusal.sentence),
        expansionClosed: notes.expansionClosed,
        ledgerCorrectionNote: notes.ledgerCorrectionNote,
        noChangeRetryUsed: notes.noChangeRetry,
      })
    : input.preSandboxAdditions;
  const text = base.assembleResearchPlanContext({ ...input, preSandboxAdditions: additions });
  return withoutFalsePreSandboxLabel(text, [
    ...midRun(preSandbox),
    ...(additions ?? []).slice(preSandbox.length),
  ]);
}

/** The base fix prompt: the fix agent wrote its conflict note itself then. */
function baseFix(input: FixContextInput): string {
  const { conflictRepositories, ...rest } = input;
  return base.assembleFixContext({ ...rest, ...fixConflictNotes(conflictRepositories ?? []) });
}

describe("prompt oracle: the composers render the bytes they rendered at the base commit", () => {
  it("covers refusals as well as text, so a refusal cannot hide a mismatch", () => {
    const refused = researchRows().filter(
      (row) => "error" in outcome(() => base.assembleResearchPlanContext(row.input)),
    );
    expect(refused.length).toBeGreaterThan(0);
  });

  it("research, including the planning loop's notes", () => {
    const rows = researchRows();
    expect(mismatchesOf(rows, baseResearch, assembleResearchPlanContext)).toEqual([]);
    expect(
      mismatchesOf(rows, baseResearch, (input) =>
        joinPromptParts(researchPlanContextParts(input))),
    ).toEqual([]);
  });

  it("implementation", () => {
    const oracle = (input: Parameters<typeof base.assembleImplementationContext>[0]) =>
      withoutFalsePreSandboxLabel(
        base.assembleImplementationContext(input),
        midRun(input.preSandboxAdditions),
      );
    const rows = implementationRows();
    expect(mismatchesOf(rows, oracle, assembleImplementationContext)).toEqual([]);
    expect(
      mismatchesOf(rows, oracle, (input) => joinPromptParts(implementationContextParts(input))),
    ).toEqual([]);
  });

  it("review", () => {
    const oracle = (input: Parameters<typeof base.assembleReviewContext>[0]) =>
      withoutFalsePreSandboxLabel(
        base.assembleReviewContext(input),
        midRun(input.preSandboxAdditions),
      );
    const rows = reviewRows();
    expect(mismatchesOf(rows, oracle, assembleReviewContext)).toEqual([]);
    expect(
      mismatchesOf(rows, oracle, (input) => joinPromptParts(reviewContextParts(input))),
    ).toEqual([]);
  });

  it("fix", () => {
    const rows = fixRows();
    expect(mismatchesOf(rows, baseFix, assembleFixContext)).toEqual([]);
    expect(
      mismatchesOf(rows, baseFix, (input) => joinPromptParts(fixContextParts(input))),
    ).toEqual([]);
  });

  it("discovery, with the ticket stringified as the engine passes it", () => {
    type DiscoveryInput = Parameters<typeof assembleRepositoryDiscoveryPrompt>[0];
    const rows = discoveryRows();
    expect(
      mismatchesOf(rows, baseDiscovery, (input) =>
        assembleRepositoryDiscoveryPrompt(input as unknown as DiscoveryInput)),
    ).toEqual([]);
    expect(
      mismatchesOf(rows, baseDiscovery, (input) => {
        const composed = composeRepositoryDiscoveryPrompt(input as unknown as DiscoveryInput);
        expect(joinPromptParts(composed.parts)).toBe(composed.prompt);
        return composed.prompt;
      }),
    ).toEqual([]);
  });

  it("generic_agent", () => {
    expect(
      mismatchesOf(
        genericRows(),
        (input) => baseGenericRuntimeData(input.resolvedInputs, input.clarificationAnswer),
        (input) =>
          joinPromptParts(genericAgentRuntimeData(input.resolvedInputs, input.clarificationAnswer)),
      ),
    ).toEqual([]);
  });
});

const PART_ID = /^[a-z0-9_.:-]{1,96}$/u;
const ORIGIN_KIND = /^[a-z][a-z0-9_]*$/u;

/** What is wrong with one composer's parts, in terms a reader of a briefing
 *  would notice. */
function partProblems(parts: readonly EffectivePromptPart[]): string[] {
  const problems: string[] = [];
  const ids = parts.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) problems.push(`duplicate ids ${ids.join(",")}`);
  for (const entry of parts) {
    if (!PART_ID.test(entry.id)) problems.push(`id "${entry.id}" is not a slug`);
    if (!ORIGIN_KIND.test(entry.origin.kind)) problems.push(`"${entry.id}" origin "${entry.origin.kind}" is not a slug`);
    if (entry.origin.kind === "other") problems.push(`"${entry.id}" is attributed to "other"`);
    const markers = [entry.cutBeforeSend, entry.cutCause, entry.originalLengthUtf16];
    if (markers.some((marker) => marker === undefined) && markers.some((marker) => marker !== undefined)) {
      problems.push(`"${entry.id}" is marked cut without its cause or original length`);
    }
    if (entry.withheld) {
      if (entry.content !== "") problems.push(`withheld "${entry.id}" carries text`);
      if (entry.origin.kind !== "platform") problems.push(`withheld "${entry.id}" is not a platform rule`);
    } else if (entry.cutBeforeSend === "whole") {
      if (entry.content !== "") problems.push(`"${entry.id}" is cut whole and carries text`);
    } else if (entry.content.trim().length === 0) {
      problems.push(`"${entry.id}" is whitespace or empty`);
    }
  }
  return problems;
}

function tilingProblemsOf<T>(
  rows: MatrixRow<T>[],
  parts: (input: T) => EffectivePromptPart[],
): string[] {
  return rows.flatMap((row) => {
    let composed: EffectivePromptPart[];
    try {
      composed = parts(row.input);
    } catch {
      return []; // a refused input has no parts; the oracle holds its message
    }
    return partProblems(composed).map((problem) => `${row.name}: ${problem}`);
  });
}

describe("every generated input composes into named, well-formed parts", () => {
  it.each([
    ["research", () => tilingProblemsOf(researchRows(), researchPlanContextParts)],
    ["implementation", () => tilingProblemsOf(implementationRows(), implementationContextParts)],
    ["review", () => tilingProblemsOf(reviewRows(), reviewContextParts)],
    ["fix", () => tilingProblemsOf(fixRows(), fixContextParts)],
    [
      "discovery",
      () =>
        tilingProblemsOf(discoveryRows(), (input) =>
          composeRepositoryDiscoveryPrompt(
            input as unknown as Parameters<typeof composeRepositoryDiscoveryPrompt>[0],
          ).parts),
    ],
    [
      "generic_agent",
      () =>
        tilingProblemsOf(genericRows(), (input) =>
          genericAgentRuntimeData(input.resolvedInputs, input.clarificationAnswer)),
    ],
  ] as const)("%s", (_name, problems) => {
    expect(problems()).toEqual([]);
  });

  it("tiles the compiled runtime section of every research input, cap and sentinels included", async () => {
    const host = {
      inspectSlotSchema: () => ({ ok: true }),
      validateSlotValue: () => [],
      exampleValueForSchema: () => null,
    };
    const problems: string[] = [];
    for (const row of researchRows()) {
      let runtimeData: EffectivePromptPart[];
      try {
        runtimeData = researchPlanContextParts(row.input);
      } catch {
        continue;
      }
      const compilation = await compileEffectivePrompt({
        nodeId: "planning",
        blockPrompt: "Plan.",
        runtimeData,
        ...host,
      });
      const runtime = compilation.sections.find((section) => section.kind === "runtime");
      if (!runtime) {
        problems.push(`${row.name}: no runtime section`);
        continue;
      }
      if (joinPromptParts(runtime.parts) !== runtime.content) {
        problems.push(`${row.name}: runtime parts do not concatenate to the section as sent`);
      }
      const joined = joinPromptParts(runtimeData);
      if (joined.length > 200_000 && !runtime.parts.some((entry) => entry.cutBeforeSend)) {
        problems.push(`${row.name}: the cap cut the section and no part says so`);
      }
    }
    expect(problems).toEqual([]);
  });
});
