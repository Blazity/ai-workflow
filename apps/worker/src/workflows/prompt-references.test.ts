import { describe, expect, it, vi } from "vitest";
import {
  formatPromptReferenceToken,
  parsePromptReferenceTokens,
  type PromptReferenceSelector,
} from "@shared/contracts";
import { resolvePromptReferences } from "./prompt-references.js";

describe("prompt reference tokens", () => {
  it("formats latest and pinned references canonically", () => {
    expect(formatPromptReferenceToken({ promptId: 42, version: "latest" })).toBe("{{prompt:42}}");
    expect(formatPromptReferenceToken({ promptId: 42, version: 2 })).toBe("{{prompt:42@2}}");
  });

  it("parses default latest, explicit latest, pinned, and multiple references", () => {
    expect(parsePromptReferenceTokens("A {{prompt:42}} B {{prompt:7@latest}} C {{prompt:9@3}}"))
      .toEqual([
        expect.objectContaining({ raw: "{{prompt:42}}", promptId: 42, version: "latest" }),
        expect.objectContaining({ raw: "{{prompt:7@latest}}", promptId: 7, version: "latest" }),
        expect.objectContaining({ raw: "{{prompt:9@3}}", promptId: 9, version: 3 }),
      ]);
  });
});

type Fixture = {
  name: string;
  archived: boolean;
  versions: Record<number, string>;
};

function loader(fixtures: Record<number, Fixture>) {
  return vi.fn(async (promptId: number, requested: PromptReferenceSelector) => {
    const prompt = fixtures[promptId];
    if (!prompt) throw new Error(`Prompt ${promptId} does not exist`);
    if (requested === "latest" && prompt.archived) {
      throw new Error(`Prompt ${promptId} is archived and cannot follow latest`);
    }
    const resolvedVersion = requested === "latest"
      ? Math.max(...Object.keys(prompt.versions).map(Number))
      : requested;
    const body = prompt.versions[resolvedVersion];
    if (body === undefined) throw new Error(`Prompt ${promptId} version ${resolvedVersion} does not exist`);
    return { promptId, promptName: prompt.name, requestedVersion: requested, resolvedVersion, body };
  });
}

describe("resolvePromptReferences", () => {
  it("expands nested prompt references before leaving global variables for the existing pass", async () => {
    const load = loader({
      1: { name: "Research", archived: false, versions: { 2: "Research {{ticket_key}}\n{{prompt:2@1}}" } },
      2: { name: "Policy", archived: false, versions: { 1: "Branch {{branch_name}}" } },
    });

    const result = await resolvePromptReferences("Start\n{{prompt:1}}\nEnd", load);

    expect(result.text).toBe("Start\nResearch {{ticket_key}}\nBranch {{branch_name}}\nEnd");
    expect(result.manifest).toEqual([
      expect.objectContaining({ promptId: 1, requestedVersion: "latest", resolvedVersion: 2 }),
      expect.objectContaining({ promptId: 2, requestedVersion: 1, resolvedVersion: 1 }),
    ]);
  });

  it("loads a repeated selector once but expands every occurrence", async () => {
    const load = loader({ 1: { name: "Shared", archived: false, versions: { 3: "BODY" } } });
    const result = await resolvePromptReferences("{{prompt:1}} + {{prompt:1}}", load);
    expect(result.text).toBe("BODY + BODY");
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.manifest).toHaveLength(1);
  });

  it("rejects cycles with the complete prompt path", async () => {
    const load = loader({
      1: { name: "A", archived: false, versions: { 1: "{{prompt:2}}" } },
      2: { name: "B", archived: false, versions: { 1: "{{prompt:1}}" } },
    });
    await expect(resolvePromptReferences("{{prompt:1}}", load)).rejects.toThrow("1@1 -> 2@1 -> 1@1");
  });

  it("allows a prompt version to include an older version of the same prompt", async () => {
    const load = loader({
      1: { name: "Research", archived: false, versions: { 1: "foundation", 2: "{{prompt:1@1}}\nupdate" } },
    });

    await expect(resolvePromptReferences("{{prompt:1@2}}", load)).resolves.toMatchObject({
      text: "foundation\nupdate",
    });
  });

  it("detects cycles between versions of the same prompt", async () => {
    const load = loader({
      1: { name: "Research", archived: false, versions: { 1: "{{prompt:1@2}}", 2: "{{prompt:1@1}}" } },
    });

    await expect(resolvePromptReferences("{{prompt:1@2}}", load)).rejects.toThrow("1@2 -> 1@1 -> 1@2");
  });

  it("allows pinned archived versions but rejects archived latest", async () => {
    const load = loader({ 1: { name: "Archived", archived: true, versions: { 1: "OLD" } } });
    await expect(resolvePromptReferences("{{prompt:1@1}}", load)).resolves.toMatchObject({ text: "OLD" });
    await expect(resolvePromptReferences("{{prompt:1}}", load)).rejects.toThrow("archived");
  });

  it("rejects malformed directives, excessive depth, and excessive output", async () => {
    const load = loader({
      1: { name: "A", archived: false, versions: { 1: "{{prompt:2}}" } },
      2: { name: "B", archived: false, versions: { 1: "{{prompt:3}}" } },
      3: { name: "C", archived: false, versions: { 1: "done" } },
      4: { name: "Large", archived: false, versions: { 1: "123456" } },
    });
    await expect(resolvePromptReferences("{{prompt:nope}}", load)).rejects.toThrow("Malformed prompt reference");
    await expect(resolvePromptReferences("{{prompt:1}}", load, { maxDepth: 2 })).rejects.toThrow("maximum depth");
    await expect(resolvePromptReferences("{{prompt:4}}", load, { maxOutputLength: 5 })).rejects.toThrow("maximum length");
  });
});
