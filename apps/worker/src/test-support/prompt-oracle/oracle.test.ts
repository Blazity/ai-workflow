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
  type ImplementationContextInput,
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

/** Every byte outside the repository section, the review siblings and the two
 *  sentences stage 7 rewrote, held to the base commit. */
function mismatchesOf<T>(
  rows: MatrixRow<T>[],
  oracle: (input: T) => string,
  current: (input: T) => string,
): string[] {
  const pinned = (text: string) =>
    withoutPromptAuditRewrites(
      withoutIntegrationRenames(
        withoutStageSevenRewrites(withoutReviewSiblingSection(withoutRepositorySection(text))),
      ),
    );
  return mismatchesOfRaw(rows, (input) => pinned(oracle(input)), (input) => pinned(current(input)));
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

/**
 * THE THIRD DECLARED CHANGE: an implementation agent with no plan gets the
 * ticket's description. The base never sent it to implementation, because the
 * plan was written from it; with an empty plan nothing was written from it,
 * and the agent was left with the title alone. So the section the live text
 * now carries, and only on those rows, is written into the base's text at the
 * one place it goes (before the acceptance criteria), and every other byte of
 * an implementation send stays pinned. Where a plan is present the description
 * is still not sent: it is a zero-byte withheld part, which this text comparison
 * cannot see and `sandbox/context.test.ts` holds.
 */
function withDescriptionWhereNoPlanStandsIn(text: string, input: ImplementationContextInput): string {
  if (input.researchPlanMarkdown.trim() !== "") return text;
  const anchor = "\n## Acceptance Criteria\n\n";
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error("the oracle text has no Acceptance Criteria section to put the description before");
  return `${text.slice(0, at)}\n## Description\n\n${input.ticket.description}\n${text.slice(at)}`;
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

/**
 * THE SECOND DESCRIPTION OF THE REVIEW SIBLINGS, removed from both sides.
 *
 * Same rule as the repository section above, and the same reason: the base
 * described each sibling twice, once in the workspace list and once here with
 * its path, its access, its pull request and its reviewed commit. The map now
 * carries all four on the sibling's own line, and what is left under this
 * heading is the rule about these repositories plus the spelling a finding's
 * `repo` field must use. The two texts no longer correspond line by line, so
 * the section is cut out of both rather than rewritten.
 *
 * WHAT STILL PINS IT: the goldens a person reads (`__golden__/review.txt`), and
 * `sandbox/context.test.ts`, which holds the pull request, the commit and the
 * access to one statement each per prompt.
 */
function withoutReviewSiblingSection(text: string): string {
  return text.replace(/\n## Review Sibling Repositories\n[\s\S]*?(?=\n## |$)/, "\n");
}

/**
 * THE TWO SENTENCES STAGE 7 REWROTE, removed from both sides.
 *
 * Same rule as the repository section above: what somebody meant to change is
 * excised on both sides, so every other byte stays pinned to the base commit.
 * These are narrower, one paragraph each, because that is all that changed.
 *
 * 1. The clarification budget note. One sentence used to explain three
 *    different cuts, and it was false for two of them: it told the model older
 *    rounds had been dropped when the truth was that the newest round's own
 *    question and answer had been shortened in place. It now says which
 *    happened and how much. What the budget KEEPS is byte for byte what it
 *    kept, because the reserve it is paid from stayed at the old note's length;
 *    only the note itself differs, which is why this excision can be one
 *    paragraph rather than the whole section.
 * 2. "repeating the request ends the run", on a closed expansion. True of a
 *    loop that counted absorbed requests and then failed; false once a spent
 *    corrective pass makes the run plan with what it holds instead. A prompt
 *    that threatens a consequence the run does not carry out is the thing this
 *    stage exists to stop.
 *
 * What these DO still pin: that each sentence sits in exactly one place. Both
 * patterns are anchored to their own paragraph, so a change that moved the note
 * somewhere else, or wrote it twice, would leave the second copy in the
 * comparison.
 */
/**
 * THE SECOND DECLARED CHANGE: core stopped naming the tracker.
 *
 * The issue tracker is a capability now, so a deployment can run Jira, Linear
 * or something written next month, and a prompt that says "the Jira ticket"
 * lies to the model on every one of them. The base commit predates that, so
 * this rewrites the base's wording to the live one for the comparison and
 * nothing else: the sentence is anchored to its own line, so a second copy or
 * a moved one would still show up as a mismatch.
 */
function withoutIntegrationRenames(text: string): string {
  return text
    .replace(
      "The following files from the Jira ticket are available in",
      "The following files from the ticket are available in",
    )
    // And the evidence example lost its em dash, which this repository writes
    // nowhere.
    .replace("src/auth.ts:42 \u2014", "src/auth.ts:42,")
    // Its provider is no longer written into the sentence either. The base
    // taught every deployment `github:`, which on a deployment with GitLab and
    // no GitHub asks a model for evidence under a provider it cannot reach; the
    // live example takes the provider from the repositories the run is holding.
    // Only the provider is freed here, so the path, the file, the line and the
    // words around them stay pinned, and which provider it picks is proved by
    // `repository-map/repository-path-example.test.ts`.
    .replace(/`[a-z0-9-]+:acme\/api src\/auth\.ts:42/, "`<provider>:acme/api src/auth.ts:42");
}

/**
 * THE THIRD DECLARED CHANGE: the prompt audit's rewrites, base wording to live.
 *
 * 1. The Repository Access Protocol's opening sentence called the block's Output
 *    Format "older", a prompt version the model never saw.
 * 2. Discovery said "select the smallest set" twice, the second time as an
 *    "Always"; the two lines became one.
 *
 * Each pattern is the exact base sentence, so a copy left behind or moved still
 * shows up as a mismatch.
 */
function withoutPromptAuditRewrites(text: string): string {
  return text
    .replace(
      "This protocol extends and overrides any older Output Format instructions above.",
      "This protocol adds to the Output Format in the block instructions above; where the two differ, follow this protocol.",
    )
    .replace(
      "Select the smallest sufficient repository set for researching this ticket.\n",
      "Select the smallest sufficient repository set for researching this ticket, and always return a best-effort selection: research continues from what is selected.\n",
    )
    .replace(
      "Always select the smallest best-effort set from the catalog; research continues from what is selected.\n",
      "",
    );
}

function withoutStageSevenRewrites(text: string): string {
  return text
    .replace(
      /\[(?:Older clarification rounds omitted to fit the prompt budget\.|Prompt budget: [^\]]*)\]/,
      "[clarification budget note]",
    )
    .replace(
      /No further repository will be attached to this workspace: requesting one again changes nothing[^\n]*/,
      "No further repository will be attached to this workspace: <closed>",
    );
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

  /**
   * THE SIBLING EXCISION MUST CUT SOMETHING, ON BOTH SIDES, for the reason the
   * repository one must: a heading that stopped being rendered would make the
   * cut a no-op on one side and a wipe on the other, and the comparison would
   * pass on two texts nobody wrote.
   */
  it("removes the review sibling section from the base text and from the live text", () => {
    const texts = reviewRows()
      .filter((row) => !("error" in outcome(() => base.assembleReviewContext(row.input))))
      .map((row) => ({
        base: base.assembleReviewContext(row.input),
        live: assembleReviewContext(row.input),
      }))
      .filter((pair) => pair.base.includes("\n## Review Sibling Repositories\n"));
    expect(texts.length).toBeGreaterThan(0);
    for (const pair of texts) {
      expect(pair.live).toContain("\n## Review Sibling Repositories\n");
      for (const text of [pair.base, pair.live]) {
        expect(withoutReviewSiblingSection(text).length).toBeLessThan(text.length);
        // And it takes ONE section, not the rest of the prompt with it.
        expect(withoutReviewSiblingSection(text)).toContain("## Research & Plan");
      }
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
      withDescriptionWhereNoPlanStandsIn(
        withoutFalsePreSandboxLabel(
          base.assembleImplementationContext(input),
          midRun(input.preSandboxAdditions),
        ),
        input as ImplementationContextInput,
      );
    const rows = implementationRows();
    // Rows with no plan and rows with one, or the rewrite above pins nothing.
    expect(rows.some((row) => row.input.researchPlanMarkdown.trim() === "")).toBe(true);
    expect(rows.some((row) => row.input.researchPlanMarkdown.trim() !== "")).toBe(true);
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
      // Our own rule held back, or a field of the ticket another part stands in
      // for (the description, where the plan was written from it). Never text
      // from anywhere else: nothing else is ours to hold back.
      if (entry.origin.kind !== "platform" && entry.origin.kind !== "ticket") {
        problems.push(`withheld "${entry.id}" is neither a platform rule nor a ticket field`);
      }
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
