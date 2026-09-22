import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import { builtinHarnessProfileReference } from "@shared/harness";
import type { Db } from "../../db/client.js";
import type { WorkflowBlockRegistryContext } from "../../engine/definition/block-contract-resolver.js";

const mocks = vi.hoisted(() => ({
  loadPromptReference: vi.fn(),
  resolveHarnessRuntimesForDefinition: vi.fn(),
}));

vi.mock("../../prompt-library/prompt-reference-loader.js", () => ({
  createPromptReferenceLoader: () => mocks.loadPromptReference,
}));
vi.mock("../../engine/definition/harness-profile-runtime.js", () => ({
  resolveHarnessRuntimesForDefinition: mocks.resolveHarnessRuntimesForDefinition,
}));

import type { effectivePromptProfileSource } from "../../engine/helpers/effective-prompt.js";
import { previewWorkflowPromptCandidate } from "./prompt-preview.js";
import { MESSAGING_CONNECTED } from "../../engine/definition/messaging-deployment.fixture.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "codex", model: "gpt-5-codex" },
  vcsProviders: ["github"],
  vcsBotIdentities: ["github"],
  webhookTriggerConfigured: true,
  integrations: MESSAGING_CONNECTED,
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

const reusablePrompt = {
  promptId: 4,
  promptName: "Generic task",
  requestedVersion: 1,
  resolvedVersion: 1,
  body: "Work on {{slot:ticket}}: {{data:steps.entry.output.ticket.title}}",
  slots: [
    {
      name: "ticket",
      description: "Ticket identifier",
      schema: { type: "string" },
      required: true,
    },
  ],
};

/** A resolved runtime carrying only what the preview reads off it: the
 *  manifest's identity, its instructions and its two context switches. */
function runtimeWith(context: {
  includeWorkflowData: boolean;
  includeRepositoryInstructions: boolean;
}) {
  return {
    manifest: {
      profileId: "team-codex",
      version: 3,
      displayName: "Team codex",
      instructions: "Follow the team conventions.",
      homeFiles: [],
      context,
    },
  } as unknown as Parameters<typeof effectivePromptProfileSource>[0];
}

beforeEach(() => {
  mocks.resolveHarnessRuntimesForDefinition.mockReset();
  mocks.resolveHarnessRuntimesForDefinition.mockResolvedValue({});
});

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
          version: 2,
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

  // Red when: the preview composes a Runtime data section for a profile whose
  // switch is off. An operator reads a prompt with ticket data in it, ships the
  // definition, and the agent is sent a prompt without it: the one difference
  // they cannot see is the one that changes the answer.
  it("leaves out the sections the selected profile switches off", async () => {
    mocks.loadPromptReference.mockResolvedValue(reusablePrompt);
    const runtime = runtimeWith({
      includeWorkflowData: false,
      includeRepositoryInstructions: false,
    });
    mocks.resolveHarnessRuntimesForDefinition.mockResolvedValue({ agent: runtime });

    const result = await previewWorkflowPromptCandidate(
      {} as Db,
      candidate,
      "agent",
      registryContext,
      { organizationId: "org-1" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.sections.map((section) => section.kind)).toEqual([
      "profile",
      "block",
    ]);
    // Said out loud, so the screen can name the prompt instead of leaving an
    // operator to wonder where the section went.
    expect(result.preview.context).toEqual({
      includeWorkflowData: false,
      includeRepositoryInstructions: false,
    });
    // Not coming is not the same as not shown here: with the switch off, the
    // repository files are neither listed as unresolved nor as unpreviewable.
    expect(result.preview.unresolvedSources.some((source) => source.kind === "repository")).toBe(
      false,
    );
    // The switch decides this one entry and nothing else: the rest of the list
    // is what a run composes from a workspace, which no switch turns off.
    expect(result.preview.notPreviewable.map((gap) => gap.kind)).not.toContain(
      "repository_instructions",
    );
    expect(result.preview.notPreviewable.map((gap) => gap.kind)).toContain("repository_memory");
  });

  // Red when: the switches are read from anywhere but the profile that would
  // run. A profile with both on has to preview both sections.
  it("keeps the sections a profile with both switches on would send", async () => {
    mocks.loadPromptReference.mockResolvedValue(reusablePrompt);
    mocks.resolveHarnessRuntimesForDefinition.mockResolvedValue({
      agent: runtimeWith({ includeWorkflowData: true, includeRepositoryInstructions: true }),
    });

    const result = await previewWorkflowPromptCandidate(
      {} as Db,
      candidate,
      "agent",
      registryContext,
      { organizationId: "org-1" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.sections.map((section) => section.kind)).toContain("runtime");
    expect(result.preview.context.includeWorkflowData).toBe(true);
    expect(result.preview.notPreviewable.map((gap) => gap.kind)).toEqual(
      expect.arrayContaining(["repository_instructions", "repository_memory"]),
    );
    expect(result.preview.profile).toMatchObject({ applied: "selected" });
  });

  // Red when: a data reference that execution's resolver THROWS on is listed
  // beside one it fills in, both under "resolved when this block runs". The
  // operator ships a definition that dies on its first invocation with
  // prompt_data_unavailable, having read a preview that looked complete.
  it("says which unresolved sources would fail the run rather than be filled in", async () => {
    mocks.loadPromptReference.mockResolvedValue({
      ...reusablePrompt,
      body:
        "Work on {{slot:ticket}}: {{data:steps.entry.output.ticket.title}} and {{data:steps.nowhere.output.value}}",
    });

    const result = await previewWorkflowPromptCandidate(
      {} as Db,
      candidate,
      "agent",
      registryContext,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fates = Object.fromEntries(
      result.preview.unresolvedSources.map((source) => [source.reference, source.atRun]),
    );
    // Guaranteed for this block: execution resolves it, the preview showed an
    // example, and nothing is wrong.
    expect(fates["steps.entry.output.ticket.title"]).toBe("filled_at_run");
    // Not guaranteed: the example in the preview is the whole problem.
    expect(fates["steps.nowhere.output.value"]).toBe("fails_the_run");
    // And the sentence beside it stops saying the opposite: a reader showing
    // only the message would otherwise keep reassuring people.
    const fatal = result.preview.unresolvedSources.find(
      (source) => source.reference === "steps.nowhere.output.value",
    );
    expect(fatal?.message).toContain("not guaranteed");
    expect(fatal?.message).not.toContain("is resolved when this block runs");
    // A slot bound to a guaranteed reference is the ordinary case.
    expect(fates["steps.entry.output.ticketKey"]).toBe("filled_at_run");
    // The workspace files are neither: absent here, and absent at run time is
    // not a failure.
    expect(
      result.preview.unresolvedSources
        .filter((source) => source.kind === "repository")
        .every((source) => source.atRun === "not_in_preview"),
    ).toBe(true);
  });

  // Red when: the editor shows a prompt with no repository or memory section
  // and nothing says those sections exist at all, so an operator tunes a
  // prompt against a picture missing the parts a run adds.
  it("names the sections it cannot compose instead of leaving them out", async () => {
    mocks.loadPromptReference.mockResolvedValue(reusablePrompt);

    const result = await previewWorkflowPromptCandidate(
      {} as Db,
      candidate,
      "agent",
      registryContext,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every section a run composes and this screen cannot, not the two that
    // happen to come from a checkout. An operator who could not find the
    // repository map here read the short list as the whole difference and went
    // to change their catalog: the map is in every real send.
    expect(result.preview.notPreviewable.map((gap) => gap.kind)).toEqual(
      expect.arrayContaining([
        "repository_instructions",
        "repository_memory",
        "repository_map",
        "ticket_and_pull_request",
        "run_notes",
        "platform_rules",
      ]),
    );
    for (const gap of result.preview.notPreviewable) {
      expect(gap.reason.length).toBeGreaterThan(20);
    }
  });

  // Red when: the map stops being named here, which is how this list fell
  // behind the first time. The sentence has to tell an operator the map IS
  // sent, not merely that it is missing from this screen.
  it("says the repository map is in every real send, and where it lives there", async () => {
    mocks.loadPromptReference.mockResolvedValue(reusablePrompt);

    const result = await previewWorkflowPromptCandidate(
      {} as Db,
      candidate,
      "agent",
      registryContext,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const map = result.preview.notPreviewable.find((gap) => gap.kind === "repository_map");
    expect(map?.reason).toContain("A run always sends it");
    expect(map?.reason).toContain("selected-repositories");
  });

  // Red when: a block naming a profile this deployment cannot resolve is shown
  // the built-in prompt under that profile's name. The run would refuse to
  // start, and the preview would have read as normal.
  it("shows no profile, rather than somebody else's, when the named one is gone", async () => {
    mocks.loadPromptReference.mockResolvedValue(reusablePrompt);
    mocks.resolveHarnessRuntimesForDefinition.mockResolvedValue({});
    const persisted = structuredClone(candidate);
    persisted.nodes[1]!.configuration.harnessProfile = { profileId: "team-codex", version: 3 };

    const result = await previewWorkflowPromptCandidate(
      {} as Db,
      persisted,
      "agent",
      registryContext,
      { organizationId: "org-1" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.profile).toBeNull();
    expect(result.preview.sections.map((section) => section.kind)).not.toContain("profile");
    expect(
      result.preview.unresolvedSources.find((source) => source.kind === "profile")?.atRun,
    ).toBe("fails_the_run");
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
