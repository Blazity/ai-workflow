/**
 * THE SEAM NOBODY OWNS: the repository map, inside a captured briefing.
 *
 * A briefing is stored by tiling each section with its parts, and the package
 * REFUSES a section whose parts do not reproduce its text. It refuses quietly:
 * the outcome is "not recorded" and a marker is stored, which is the right
 * behaviour for a record nobody could trust, and it means a composer that
 * starts producing parts that do not join back to its own text turns NOTHING
 * red. Every production briefing becomes an empty marker and the first person
 * to notice is whoever opens the page a week later.
 *
 * The map is now part of that composition, it is the largest part-producing
 * section in the prompt, and its parts are assembled through three different
 * paths (group headings, our own rules, one part per repository). So this
 * takes a REAL research composition with all four groups in it and captures it
 * the way a run does, and asserts both halves: the capture was recorded, and
 * the map's own parts tile their section exactly.
 *
 * WHAT TURNS IT RED, observed: numbering the map's parts by repository key
 * (`repository-map-workspace:github:acme/api`) instead of by position. That is
 * the obvious "improvement" to make the ids readable, the key is not a legal
 * part id, and the outcome becomes `refused` for the WHOLE send. Nothing else
 * in the suite notices, and on production every briefing would be a marker.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PROMPTS } from "@shared/prompts";
import type { AgentBriefingBuildInput, AgentBriefingIndex } from "@shared/agent-visibility";
import type { Db } from "../db/client.js";
import { readAgentBriefingRecord } from "../db/repositories/agent-visibility.js";
import { createTestDb } from "../db/test-db.js";
import {
  compileEffectivePrompt,
  resolveProfileInstructions,
} from "../engine/helpers/effective-prompt.js";
import { researchPlanContextParts } from "../sandbox/context.js";
import type { RepositoryMapContext } from "../repository-map/map.js";
import { recordAgentBriefing } from "./agent-briefings.js";
import { createVisibilityDetector } from "./visibility-detector.js";

const detect = createVisibilityDetector({ secrets: [] });
const IDENTITY = {
  runId: "wrun_map_briefing",
  nodeId: "planning",
  attempt: 1,
  activationScopeId: "root",
  sequence: 1,
};

/** A map with every group in it: a workspace, a neighbourhood, something
 *  already decided, and a catalog tail. */
const MAP: RepositoryMapContext = {
  repositories: [
    {
      key: "github:acme/api",
      catalogDescription: "The payments API. It owns the ledger and the webhook fan-out.",
      relationships: [
        { kind: "backend_for", targetKey: "github:acme/web", direction: "outgoing" },
      ],
      enabled: true,
      usable: true,
    },
    { key: "github:acme/web", catalogDescription: "The customer dashboard.", enabled: true, usable: true },
    { key: "github:acme/legacy", catalogDescription: "The retired monolith.", enabled: true, usable: true },
    { key: "github:acme/docs", catalogDescription: "Developer documentation.", enabled: true, usable: true },
  ],
  namedKeys: ["github:acme/api"],
  entries: [
    {
      repositoryKey: "github:acme/legacy",
      state: "excluded",
      origin: "person",
      rationale: "not part of this ticket",
      decidedBy: { kind: "person", actorId: "u-anna", actorLabel: "Anna Nowak" },
      decidedAt: "2026-09-17T11:04:00.000Z",
    },
  ],
  catalogActivated: true,
  expansionOpen: true,
};

function researchParts() {
  return researchPlanContextParts({
    ticket: {
      identifier: "AWP-1",
      title: "Refund webhooks drop the last event",
      description: "Something in github:acme/api drops the last webhook of a batch.",
      acceptanceCriteria: "No event is dropped.",
      comments: [],
    },
    prompt: "",
    branchName: "ai/awp-1",
    selectedRepositories: [
      {
        provider: "github",
        repoPath: "acme/api",
        defaultBranch: "main",
        selectedRationale: "The ticket text names this repository path.",
      },
    ],
    repositoryMap: MAP,
  });
}

/**
 * A REAL COMPILATION, and then the slicing `engine/agent-visibility/capture.ts`
 * does over it.
 *
 * Deliberately NOT `text: joinPromptParts(parts)`: a section whose text is the
 * join of its own parts tiles by construction and could never fail, which
 * would make this test a decoration. The capture records each part's LENGTH
 * and the page slices the stored text by those lengths in order, so a part
 * whose length disagrees with the text the compiler produced shifts every part
 * after it and the package refuses the whole briefing. That is the failure
 * this reproduces, so the text comes from the compiler and the parts are cut
 * out of it by length exactly as the capture cuts them.
 */
async function sendInput(): Promise<AgentBriefingBuildInput> {
  const profile = await resolveProfileInstructions({
    node: {
      id: "planning",
      type: "planning_agent",
      x: 0,
      y: 0,
      configuration: { provider: "claude" },
      inputs: {},
      additionalInputs: [],
    } as never,
  });
  if (!profile) throw new Error("the built-in profile did not resolve");
  const compilation = await compileEffectivePrompt({
    nodeId: "planning",
    blockPrompt: DEFAULT_AGENT_PROMPTS["research-plan"],
    runtimeData: researchParts(),
    profileContext: { includeWorkflowData: true, includeRepositoryInstructions: true },
    slots: [],
    promptManifest: [],
    profileSource: profile,
    repositorySources: [],
    memorySources: [],
    bindingContext: {
      entryOutput: { status: "fired" } as never,
      getStepOutput: () => undefined,
    },
  });
  expect(compilation.issues).toEqual([]);
  return {
    identity: {
      ...IDENTITY,
      kind: "agent",
      blockType: "planning_agent",
      capturedAt: "2026-09-19T10:15:00.000Z",
    },
    harness: { provider: "claude", model: "claude-sonnet-4-5-20250929" },
    sections: compilation.sections.map((section) => {
      let offset = 0;
      return {
        kind: section.kind,
        title: section.title,
        text: section.content,
        parts: section.parts.map((part) => {
          const start = offset;
          offset += part.content.length;
          return {
            id: part.id,
            title: part.title,
            origin: part.origin,
            content: section.content.slice(start, offset),
            ...(part.withheld ? { withheld: part.withheld } : {}),
          };
        }),
      };
    }),
    repositoryContext: null,
  };
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("a briefing of a send that carries the repository map", () => {
  it("is recorded, with the map's parts tiling their section exactly", async () => {
    const input = await sendInput();
    const runtime = input.sections.findIndex((section) => section.kind === "runtime");
    expect(runtime).toBeGreaterThan(-1);
    const sent = input.sections[runtime]!.text;
    // The fixture is only worth anything if it really is the shape this is
    // about: all four groups, and our own rules beside the catalog's facts.
    expect(sent).toContain("### In the workspace");
    expect(sent).toContain("### Related to this work, not in the workspace");
    expect(sent).toContain("### Already decided, do not request these");
    expect(sent).toContain("### Also in the catalog");

    const result = await recordAgentBriefing(input, { db, sanitize: detect });

    // NOT a marker. A refusal here is the whole failure this test exists for,
    // and it is worth reading the reason when it happens.
    expect(result).toEqual({ outcome: "recorded", briefingId: expect.any(Number) });

    const record = await readAgentBriefingRecord(db, IDENTITY);
    const index = record?.briefing.index as AgentBriefingIndex | undefined;
    const section = index?.sections[runtime];
    expect(section).toBeDefined();
    const stored = record?.texts.find((entry) => entry.sha256 === section!.storedSha256)?.text;
    expect(stored).toBe(sent);

    // And the map's own parts, each one a span of the text that was sent. The
    // spans are byte offsets into the stored text, which is what the pages
    // slice with.
    const bytes = Buffer.from(stored!, "utf8");
    const slice = (part: { range: { start: number; end: number } }) =>
      bytes.subarray(part.range.start, part.range.end).toString("utf8");
    const mapParts = section!.parts.filter((part) => part.id.startsWith("repository-map"));
    expect(mapParts.length).toBeGreaterThan(4);
    const tiled = mapParts.map((part) => slice(part)).join("");
    expect(tiled).toContain("## Repositories");
    expect(tiled).toContain("### Already decided, do not request these");
    // Contiguous, so nothing of the map is stored twice and nothing of it
    // falls between two parts.
    for (let index = 1; index < mapParts.length; index += 1) {
      expect(mapParts[index]!.range.start).toBe(mapParts[index - 1]!.range.end);
    }
    // And the whole section really is tiled by its parts, which is the
    // condition the package refuses on.
    expect(section!.parts.map((part) => slice(part)).join("")).toBe(stored);
  });

  it("keeps our own rules distinguishable from the catalog's facts in the record", async () => {
    // The point of storing parts rather than one blob: a person reading a
    // briefing has to be able to tell what WE told the agent from what the
    // catalog said. If the map ever composed its rules into the same part as
    // the repositories they govern, that distinction is gone and the section
    // still tiles perfectly.
    const input = await sendInput();
    await recordAgentBriefing(input, { db, sanitize: detect });

    const record = await readAgentBriefingRecord(db, IDENTITY);
    const index = record?.briefing.index as AgentBriefingIndex | undefined;
    const section = index!.sections.find((candidate) => candidate.kind === "runtime")!;
    const parts = section.parts;
    const bytes = Buffer.from(
      record!.texts.find((entry) => entry.sha256 === section.storedSha256)!.text,
      "utf8",
    );
    const rules = parts.filter(
      (part) => part.id.startsWith("repository-map") && part.origin.kind === "platform",
    );
    const facts = parts.filter(
      (part) => part.id.startsWith("repository-map") && part.origin.kind === "repository_catalog",
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(facts.length).toBeGreaterThan(0);
    const ruleText = rules
      .map((part) => bytes.subarray(part.range.start, part.range.end).toString("utf8"))
      .join("");
    expect(ruleText).toContain("Only a repository marked (write) may be changed");
    expect(ruleText).not.toContain("The payments API.");
  });
});
