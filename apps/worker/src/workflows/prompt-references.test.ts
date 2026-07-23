import { describe, expect, it, vi } from "vitest";
import {
  formatPromptReferenceToken,
  parsePromptReferenceTokens,
  type PromptSlotDefinition,
  type PromptReferenceSelector,
} from "@shared/contracts";
import { resolvePromptReferences, type PromptReferenceTarget } from "./prompt-references.js";

describe("prompt reference tokens", () => {
  it("formats latest and pinned references canonically", () => {
    expect(formatPromptReferenceToken({ slug: "research-plan", version: "latest" })).toBe("{{prompt:research-plan}}");
    expect(formatPromptReferenceToken({ slug: "research-plan", version: 2 })).toBe("{{prompt:research-plan@2}}");
  });

  it("parses slug, explicit latest, pinned, and legacy numeric references", () => {
    expect(
      parsePromptReferenceTokens("A {{prompt:research}} B {{prompt:policy@latest}} C {{prompt:review@3}} D {{prompt:42}}"),
    ).toEqual([
      expect.objectContaining({ raw: "{{prompt:research}}", slug: "research", version: "latest" }),
      expect.objectContaining({ raw: "{{prompt:policy@latest}}", slug: "policy", version: "latest" }),
      expect.objectContaining({ raw: "{{prompt:review@3}}", slug: "review", version: 3 }),
      expect.objectContaining({ raw: "{{prompt:42}}", legacyPromptId: 42, version: "latest" }),
    ]);
  });
});

type Fixture = {
  id: number;
  name: string;
  archived: boolean;
  versions: Record<
    number,
    string | { body: string; slots: PromptSlotDefinition[] }
  >;
};

function loader(fixtures: Record<string, Fixture>) {
  return vi.fn(async (target: PromptReferenceTarget, requested: PromptReferenceSelector) => {
    const label = target.slug ?? `#${target.legacyPromptId}`;
    const prompt = target.slug !== undefined
      ? fixtures[target.slug]
      : Object.values(fixtures).find((candidate) => candidate.id === target.legacyPromptId);
    if (!prompt) throw new Error(`Prompt ${label} does not exist`);
    if (requested === "latest" && prompt.archived) {
      throw new Error(`Prompt ${label} is archived and cannot follow latest`);
    }
    const resolvedVersion = requested === "latest"
      ? Math.max(...Object.keys(prompt.versions).map(Number))
      : requested;
    const version = prompt.versions[resolvedVersion];
    if (version === undefined) throw new Error(`Prompt ${label} version ${resolvedVersion} does not exist`);
    return {
      promptId: prompt.id,
      promptName: prompt.name,
      requestedVersion: requested,
      resolvedVersion,
      body: typeof version === "string" ? version : version.body,
      slots: typeof version === "string" ? [] : version.slots,
    };
  });
}

const textSlot = (
  name: string,
  overrides: Partial<PromptSlotDefinition> = {},
): PromptSlotDefinition => ({
  name,
  description: `${name} value`,
  schema: { type: "string" },
  required: true,
  ...overrides,
});

describe("resolvePromptReferences", () => {
  it("expands nested prompt references before leaving global variables for the existing pass", async () => {
    const load = loader({
      research: { id: 1, name: "Research", archived: false, versions: { 2: "Research {{ticket_key}}\n{{prompt:policy@1}}" } },
      policy: { id: 2, name: "Policy", archived: false, versions: { 1: "Branch {{branch_name}}" } },
    });

    const result = await resolvePromptReferences("Start\n{{prompt:research}}\nEnd", load);

    expect(result.text).toBe("Start\nResearch {{ticket_key}}\nBranch {{branch_name}}\nEnd");
    expect(result.manifest).toEqual([
      expect.objectContaining({ promptId: 1, requestedVersion: "latest", resolvedVersion: 2 }),
      expect.objectContaining({ promptId: 2, requestedVersion: 1, resolvedVersion: 1 }),
    ]);
  });

  it("resolves legacy numeric tokens saved before slugs existed", async () => {
    const load = loader({
      research: { id: 1, name: "Research", archived: false, versions: { 2: "Research {{ticket_key}}\n{{prompt:2@1}}" } },
      policy: { id: 2, name: "Policy", archived: false, versions: { 1: "Branch {{branch_name}}" } },
    });

    const result = await resolvePromptReferences("Start\n{{prompt:1}}\nEnd", load);

    expect(result.text).toBe("Start\nResearch {{ticket_key}}\nBranch {{branch_name}}\nEnd");
    expect(result.manifest).toEqual([
      expect.objectContaining({
        promptId: 1,
        requestedVersion: "latest",
        resolvedVersion: 2,
        bodyHash: "703d1cba6d52e0ebe61f52b81676151958dbf21c6362353ee9936e5df6b4a2b9",
      }),
      expect.objectContaining({ promptId: 2, requestedVersion: 1, resolvedVersion: 1 }),
    ]);
  });

  it("loads a repeated selector once but expands every occurrence", async () => {
    const load = loader({ shared: { id: 1, name: "Shared", archived: false, versions: { 3: "BODY" } } });
    const result = await resolvePromptReferences("{{prompt:shared}} + {{prompt:shared}}", load);
    expect(result.text).toBe("BODY + BODY");
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.manifest).toHaveLength(1);
  });

  it("rejects cycles with the complete prompt path", async () => {
    const load = loader({
      a: { id: 1, name: "A", archived: false, versions: { 1: "{{prompt:b}}" } },
      b: { id: 2, name: "B", archived: false, versions: { 1: "{{prompt:a}}" } },
    });
    await expect(resolvePromptReferences("{{prompt:a}}", load)).rejects.toThrow("1@1 -> 2@1 -> 1@1");
  });

  it("allows a prompt version to include an older version of the same prompt", async () => {
    const load = loader({
      research: { id: 1, name: "Research", archived: false, versions: { 1: "foundation", 2: "{{prompt:research@1}}\nupdate" } },
    });

    await expect(resolvePromptReferences("{{prompt:research@2}}", load)).resolves.toMatchObject({
      text: "foundation\nupdate",
    });
  });

  it("detects cycles between versions of the same prompt", async () => {
    const load = loader({
      research: { id: 1, name: "Research", archived: false, versions: { 1: "{{prompt:research@2}}", 2: "{{prompt:research@1}}" } },
    });

    await expect(resolvePromptReferences("{{prompt:research@2}}", load)).rejects.toThrow("1@2 -> 1@1 -> 1@2");
  });

  it("allows pinned archived versions but rejects archived latest", async () => {
    const load = loader({ old: { id: 1, name: "Archived", archived: true, versions: { 1: "OLD" } } });
    await expect(resolvePromptReferences("{{prompt:old@1}}", load)).resolves.toMatchObject({ text: "OLD" });
    await expect(resolvePromptReferences("{{prompt:old}}", load)).rejects.toThrow("archived");
  });

  it("rejects malformed directives, excessive depth, and excessive output", async () => {
    const load = loader({
      a: { id: 1, name: "A", archived: false, versions: { 1: "{{prompt:b}}" } },
      b: { id: 2, name: "B", archived: false, versions: { 1: "{{prompt:c}}" } },
      c: { id: 3, name: "C", archived: false, versions: { 1: "done" } },
      large: { id: 4, name: "Large", archived: false, versions: { 1: "123456" } },
    });
    await expect(resolvePromptReferences("{{prompt:Not A Slug}}", load)).rejects.toThrow("Malformed prompt reference");
    await expect(resolvePromptReferences("{{prompt:a}}", load, { maxDepth: 2 })).rejects.toThrow("maximum depth");
    await expect(resolvePromptReferences("{{prompt:large}}", load, { maxOutputLength: 5 })).rejects.toThrow("maximum length");
  });

  it("requires every v2 reusable-prompt reference to pin an exact version", async () => {
    const load = loader({
      shared: {
        id: 1,
        name: "Shared",
        archived: false,
        versions: { 1: "BODY" },
      },
    });

    await expect(
      resolvePromptReferences("{{prompt:shared}}", load, {
        requirePinned: true,
      }),
    ).rejects.toThrow("must pin an exact version");
    await expect(
      resolvePromptReferences("{{prompt:shared@1}}", load, {
        requirePinned: true,
      }),
    ).resolves.toMatchObject({ text: "BODY" });
  });

  it("unions identical slot declarations across nested reusable prompts", async () => {
    const plan = textSlot("plan");
    const load = loader({
      outer: {
        id: 1,
        name: "Outer",
        archived: false,
        versions: {
          1: {
            body: "{{slot:plan}}\n{{prompt:inner@1}}",
            slots: [plan],
          },
        },
      },
      inner: {
        id: 2,
        name: "Inner",
        archived: false,
        versions: {
          1: {
            body: "Again: {{slot:plan}}",
            slots: [structuredClone(plan)],
          },
        },
      },
    });

    const result = await resolvePromptReferences(
      "{{prompt:outer@1}}",
      load,
      { requirePinned: true },
    );

    expect(result.slots).toEqual([plan]);
    expect(result.text).toBe("{{slot:plan}}\nAgain: {{slot:plan}}");
  });

  it("rejects conflicting slot declarations across nested reusable prompts", async () => {
    const load = loader({
      outer: {
        id: 1,
        name: "Outer",
        archived: false,
        versions: {
          1: {
            body: "{{prompt:inner@1}}",
            slots: [textSlot("plan")],
          },
        },
      },
      inner: {
        id: 2,
        name: "Inner",
        archived: false,
        versions: {
          1: {
            body: "{{slot:plan}}",
            slots: [textSlot("plan", { schema: { type: "number" } })],
          },
        },
      },
    });

    await expect(
      resolvePromptReferences("{{prompt:outer@1}}", load, {
        requirePinned: true,
      }),
    ).rejects.toThrow('Prompt slot conflict for "plan"');
  });
});
