import { describe, expect, it, vi } from "vitest";
import {
  builtinHarnessProfileReference,
  type WorkflowDefinitionV2,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";

const mocks = vi.hoisted(() => ({
  loadPromptReference: vi.fn(),
}));

vi.mock("../prompt-library/store.js", () => ({
  createPromptReferenceLoader: () => mocks.loadPromptReference,
}));

import { previewWorkflowPromptCandidate } from "./prompt-preview.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "codex", model: "gpt-5-codex" },
  vcsProviders: ["github"],
  vcsBotIdentities: ["github"],
  slackConfigured: true,
  arthurConfigured: true,
};

const candidate: WorkflowDefinitionV2 = {
  schemaVersion: 2,
  nodes: [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      x: 0,
      y: 0,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
    {
      id: "agent",
      type: "generic_agent",
      x: 200,
      y: 0,
      configuration: {
        harnessProfile: {
          ...builtinHarnessProfileReference("codex"),
        },
        prompt: "{{prompt:generic-task@1}}",
        workspaceMode: "none",
        promptSlotBindings: {
          ticket: {
            kind: "reference",
            reference: "steps.entry.output.ticketKey",
          },
        },
      },
      inputs: {},
      additionalInputs: [],
    },
    {
      id: "done",
      type: "terminate",
      x: 400,
      y: 0,
      configuration: { terminalStatus: "done" },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [
    { id: "edge-1", from: "trigger", to: "agent" },
    { id: "edge-2", from: "agent", to: "done" },
  ],
};

describe("previewWorkflowPromptCandidate", () => {
  it("compiles the exact unsaved block with hashes, provenance, examples, and unresolved sources", async () => {
    mocks.loadPromptReference.mockResolvedValue({
      promptId: 4,
      promptName: "Generic task",
      requestedVersion: 1,
      resolvedVersion: 1,
      body:
        "Work on {{slot:ticket}}: {{data:steps.entry.output.ticket.title}}",
      slots: [{
        name: "ticket",
        description: "Ticket identifier",
        schema: { type: "string" },
        required: true,
      }],
    });

    const result = await previewWorkflowPromptCandidate(
      {} as Db,
      candidate,
      "agent",
      registryContext,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.blockId).toBe("agent");
    expect(result.preview.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.sections.map((section) => section.kind)).toEqual([
      "profile",
      "block",
      "runtime",
    ]);
    expect(
      result.preview.sections.find((section) => section.kind === "block")
        ?.content,
    ).toBe("Work on example: example");
    expect(result.preview.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "profile",
          id: "builtin-codex",
          version: 1,
        }),
        expect.objectContaining({
          kind: "prompt",
          id: "4:Generic task",
          version: 1,
        }),
      ]),
    );
    expect(result.preview.unresolvedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "slot",
          reference: "steps.entry.output.ticketKey",
        }),
        expect.objectContaining({
          kind: "data",
          reference: "steps.entry.output.ticket.title",
        }),
        expect.objectContaining({ kind: "repository" }),
      ]),
    );
    expect(result.preview.issues).toEqual([]);
  });

  it("returns structured issues for an invalid unsaved candidate", async () => {
    const result = await previewWorkflowPromptCandidate(
      {} as Db,
      { schemaVersion: 2, nodes: "invalid" },
      "agent",
      registryContext,
    );

    expect(result).toEqual({
      ok: false,
      statusCode: 422,
      message: "Prompt preview requires a structurally valid v2 definition.",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "schema", severity: "error" }),
      ]),
    });
  });
});
