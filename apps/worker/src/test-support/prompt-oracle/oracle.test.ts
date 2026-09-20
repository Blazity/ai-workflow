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

function mismatchesOfRaw<T>(
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

/** Every byte outside the repository section, held to the base commit. */
function mismatchesOf<T>(
  rows: MatrixRow<T>[],
  oracle: (input: T) => string,
  current: (input: T) => string,
): string[] {
  return mismatchesOfRaw(
    rows,
    (input) => withoutRepositorySection(oracle(input)),
    (input) => withoutRepositorySection(current(input)),
  );
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

/**
 * THE ONE SECTION THIS DELIVERY REPLACED, removed from both sides.
 *
 * The oracle's job is to catch a change in what a model reads that nobody
 * meant. The repository map is a change somebody did mean: the workspace list
 * ("## Selected Repositories") became the first group of a map that also names
 * the neighbourhood, what is already decided and the rest of the catalog. So
 * the section is cut out of the base text and out of the live text, and every
 * other byte of every send is still pinned to the base commit.
 *
 * Deliberately a whole-section cut rather than a rewrite: the two texts do not
 * correspond line by line, and a rewrite that tried to map one onto the other
 * would be a second implementation of the map inside its own oracle. What the
 * map itself renders is proved by `repository-map/map.test.ts`, by
 * `sandbox/repository-map-context.test.ts` and by the goldens a person reads.
 */
function withoutRepositorySection(text: string): string {
  return [/\n## Selected Repositories\n[\s\S]*?(?=\n## |$)/, /\n## Repositories\n[\s\S]*?(?=\n## |$)/]
    .reduce((carried, pattern) => carried.replace(pattern, "\n"), text);
}

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
  /**
   * THE EXCISION MUST CUT SOMETHING, ON BOTH SIDES.
   *
   * Every assertion below compares the two texts with the repository section
   * removed. If a heading is ever renamed, or a section stops being rendered,
   * the patterns stop matching, the excision quietly becomes a no-op on one
   * side and a whole-file wipe on the other, and the oracle passes because it
   * is comparing two empty strings or two unmodified ones. So the tool is
   * checked before the tools it enables: the base text really carries a
   * "Selected Repositories" section, the live text really carries a
   * "Repositories" one, and taking each away really removes bytes.
   */
  it("removes a real section from the base text and from the live text", () => {
    const texts = researchRows()
      .filter(
        (row) => !("error" in outcome(() => base.assembleResearchPlanContext(row.input))),
      )
      .map((row) => ({
        base: baseResearch(row.input),
        live: assembleResearchPlanContext(row.input),
      }));
    const baseCarries = texts.filter((pair) => pair.base.includes("\n## Selected Repositories\n"));
    const liveCarries = texts.filter((pair) => pair.live.includes("\n## Repositories\n"));
    expect(baseCarries.length).toBeGreaterThan(0);
    expect(liveCarries.length).toBeGreaterThan(0);
    for (const pair of baseCarries) {
      expect(withoutRepositorySection(pair.base).length).toBeLessThan(pair.base.length);
      // And it takes ONE section, not the rest of the prompt with it.
      expect(withoutRepositorySection(pair.base)).toContain("## Repository Access Protocol");
    }
    for (const pair of liveCarries) {
      expect(withoutRepositorySection(pair.live).length).toBeLessThan(pair.live.length);
      expect(withoutRepositorySection(pair.live)).toContain("## Repository Access Protocol");
    }
  });

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
