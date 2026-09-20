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
import { researchPlanContextParts, type SentRepositoryMap } from "../sandbox/context.js";
import type { RepositoryMapContext } from "../repository-map/map.js";
import { selectedRepositoryContext } from "../engine/agent-visibility/repository-context.js";
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

/** The repositories this send is standing in, the way the run hands them over. */
const WORKSPACE = [
  {
    provider: "github",
    repoPath: "acme/api",
    defaultBranch: "main",
    selectedRationale: "The ticket text names this repository path.",
  },
] as const;

/** The same repository as the workspace hands it to the recorder: `access` is
 *  the workspace's word, not the selection's. */
const WORKSPACE_INPUT = [{ ...WORKSPACE[0], access: "write" as const }];

function researchParts(sent?: SentRepositoryMap) {
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
    selectedRepositories: [...WORKSPACE],
    repositoryMap: MAP,
    ...(sent ? { sentRepositoryMap: sent } : {}),
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
async function sendInput(sent?: SentRepositoryMap): Promise<AgentBriefingBuildInput> {
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
    runtimeData: researchParts(sent),
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

/**
 * THE SAME SEAM, STRUCTURED HALF.
 *
 * The map text is one panel of the Briefing tab; the repositories beside it are
 * the other, and the owner asked for the second one by name ("that repo is the
 * backend for that one, and he really receives it"). It travels as
 * `repositoryContext`, which the package parses with a STRICT schema. A strict
 * object refuses on a field it does not know, and the whole send then records
 * as a marker with nothing red anywhere, exactly like the text half above. The
 * direction of a relationship is the field at risk: it is what makes the pair
 * readable, and it was not in the package's write schema until the map started
 * carrying it.
 *
 * WHAT TURNS THESE RED, observed: dropping the optional `direction` from
 * `repositoryInputSchema` in `packages/agent-visibility/build.ts` makes the
 * first one `refused` instead of `recorded`; making `selectedRepositoryContext`
 * ignore its `map` empties the panel, and the second one loses the
 * relationship, the operator's description and the reason a repository is here.
 */
describe("the repositories of a send that carries the map", () => {
  /** The map the composer really rendered, and the context a block records
   *  from it, through the one call `planBlockAgentBriefing` makes. */
  async function sentAndRecorded() {
    const sent: SentRepositoryMap = { map: null };
    const base = await sendInput(sent);
    // A null map here would make every assertion below vacuous: the context
    // would fall back to the workspace list and still look plausible.
    expect(sent.map).not.toBeNull();
    const runtime = base.sections.findIndex((section) => section.kind === "runtime");
    expect(runtime).toBeGreaterThan(-1);
    const input: AgentBriefingBuildInput = {
      ...base,
      repositoryContext: selectedRepositoryContext({
        repositories: WORKSPACE_INPUT,
        map: sent.map,
        renderedAt: { sectionIndex: runtime, partId: "repository-map" },
      }),
    };
    const result = await recordAgentBriefing(input, { db, sanitize: detect });
    return { sent, input, result };
  }

  /** The stored context document, which lives as its own text blob and is
   *  referenced from the index by hash. */
  async function storedContext() {
    const record = await readAgentBriefingRecord(db, IDENTITY);
    const index = record?.briefing.index as AgentBriefingIndex | undefined;
    const ref = index?.repositoryContext;
    expect(ref).toBeTruthy();
    const text = record?.texts.find((entry) => entry.sha256 === ref!.sha256)?.text;
    expect(text).toBeTruthy();
    return {
      ref: ref!,
      document: JSON.parse(text!) as {
        repositories: {
          key: string;
          description: { source: string; text: string };
          relationships: { kind: string; target: string; direction?: string }[];
          relationshipCount: number;
          state: string;
          reason?: string;
          inclusion: { cause: string; via?: { key: string; relationship: string } };
          rendering: string;
        }[];
        unlistedCount: number;
      },
    };
  }

  it("is recorded, not refused, with a directed relationship on it", async () => {
    const { result } = await sentAndRecorded();
    // A refusal here is the failure this test exists for: the package would
    // have stored a marker and said nothing.
    expect(result).toEqual({ outcome: "recorded", briefingId: expect.any(Number) });

    const { document } = await storedContext();
    const api = document.repositories.find((entry) => entry.key === "github:acme/api");
    expect(api?.relationships).toEqual([
      { kind: "backend_for", target: "github:acme/web", direction: "outgoing" },
    ]);
    // And the other end of the SAME edge, which is the whole reason direction
    // is on the record. The catalog stores the edge once, on the repository
    // whose operator recorded it, so the neighbour gets it from its own end
    // with the side flipped: read forwards without it, "web backend_for api"
    // is the reverse of what the operator wrote down.
    const web = document.repositories.find((entry) => entry.key === "github:acme/web");
    expect(web?.relationships).toEqual([
      { kind: "backend_for", target: "github:acme/api", direction: "incoming" },
    ]);
  });

  it("carries the operator's own words, why each repository is here, and what may be done to it", async () => {
    await sentAndRecorded();
    const { ref, document } = await storedContext();

    const api = document.repositories.find((entry) => entry.key === "github:acme/api");
    expect(api?.description).toEqual({
      source: "catalog",
      text: "The payments API. It owns the ledger and the webhook fan-out.",
    });
    expect(api?.state).toBe("write");
    expect(api?.inclusion.cause).toBe("named");
    expect(api?.rendering).toBe("full");

    // A neighbour is on the record as a candidate, and it names the repository
    // and the relationship it came through.
    const web = document.repositories.find((entry) => entry.key === "github:acme/web");
    expect(web?.state).toBe("offered");
    expect(web?.inclusion).toEqual({
      cause: "related",
      via: { key: "github:acme/api", relationship: "backend_for" },
    });

    // Something already decided keeps its reason, which the package requires of
    // every state a send may not use.
    const legacy = document.repositories.find((entry) => entry.key === "github:acme/legacy");
    expect(legacy?.state).toBe("excluded");
    expect(legacy?.reason?.length ?? 0).toBeGreaterThan(0);

    // The catalog tail is there too, as the one-line entry the map rendered.
    const docs = document.repositories.find((entry) => entry.key === "github:acme/docs");
    expect(docs?.rendering).toBe("line");

    // And the panel points at the line of the prompt it came from, so the two
    // halves of the tab are the same send. The part id has to be one the map
    // really emits or the planner drops the pointer without a word.
    expect(ref.renderedAt?.partId).toBe("repository-map");
    expect(ref.repositoryCount).toBe(4);
  });

  it("keeps the workspace list, and invents nothing, for a send that carried no map", async () => {
    // An older run, or a block that composed no map: the composer hands over
    // nothing, and the record says what it had rather than a description and a
    // relationship nobody put in front of this agent.
    const base = await sendInput();
    const context = selectedRepositoryContext({
      repositories: WORKSPACE_INPUT,
      map: null,
    });
    const result = await recordAgentBriefing({ ...base, repositoryContext: context }, { db, sanitize: detect });
    expect(result).toEqual({ outcome: "recorded", briefingId: expect.any(Number) });

    const { document } = await storedContext();
    expect(document.repositories.map((entry) => entry.key)).toEqual(["github:acme/api"]);
    const api = document.repositories[0]!;
    expect(api.description).toEqual({ source: "none", text: "" });
    expect(api.relationships).toEqual([]);
    expect(api.state).toBe("write");
    expect(api.inclusion).toEqual({ cause: "chosen_by_workflow" });
  });
});
