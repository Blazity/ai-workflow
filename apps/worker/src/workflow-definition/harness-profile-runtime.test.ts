import { describe, expect, it, vi } from "vitest";
import type {
  HarnessProfileManifestV1,
  HarnessProfileReference,
  HarnessProfileResolvedVersion,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  builtinHarnessProfileReference,
} from "@shared/contracts";
import { parseAgentKindOverride } from "../sandbox/agents/index.js";
import { hashHarnessProfileManifest } from "../harness-profiles/manifest.js";
import { resolveHarnessRuntimesWithLoader } from "./harness-profile-runtime.js";

describe("V1 Harness Profile compatibility resolution", () => {
  it("resolves virtual runtimes without loading an organization profile", async () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        {
          id: "planning",
          type: "planning_agent",
          name: "Planning agent",
          x: 0,
          y: 0,
          params: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          inputs: {},
        },
      ],
      edges: [],
    };
    const load = vi.fn(async () => {
      throw new Error("V1 must not perform a dashboard organization lookup");
    });

    const runtimes = await resolveHarnessRuntimesWithLoader(
      definition,
      "claude",
      load,
    );

    expect(load).not.toHaveBeenCalled();
    expect(runtimes.planning).toMatchObject({
      legacyDynamicSkills: true,
      manifest: {
        profileId: "virtual-v1-codex",
        slug: "virtual-v1-codex",
        model: { id: "gpt-5-codex", options: {} },
      },
      cliSpec: {
        kind: "codex",
        version: "0.144.6",
        protocol: "codex-jsonl-0.144.6",
      },
    });
    expect(JSON.parse(JSON.stringify(runtimes.planning))).toEqual(
      runtimes.planning,
    );
  });
});

describe("ticket agent label over a pinned Harness Profile", () => {
  const ORG_CLAUDE_PROFILE: HarnessProfileManifestV1 = {
    ...structuredClone(BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-claude"]),
    profileId: "org-claude",
    version: 4,
    slug: "org-claude",
    displayName: "Org Claude",
    system: false,
    model: { id: "claude-org-pinned", options: {} },
  };

  const publishedVersion = (
    manifest: HarnessProfileManifestV1,
  ): HarnessProfileResolvedVersion => {
    const cloned = structuredClone(manifest);
    return {
      manifest: cloned,
      manifestHash: hashHarnessProfileManifest(cloned),
      skillArtifacts: [],
    };
  };

  const catalog = (): HarnessProfileManifestV1[] => [
    structuredClone(BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-claude"]),
    structuredClone(BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-codex"]),
    ORG_CLAUDE_PROFILE,
  ];

  const loaderOver = (manifests: HarnessProfileManifestV1[]) =>
    vi.fn(async ({ profileId, version }: { profileId: string; version: number }) => {
      const manifest = manifests.find(
        (candidate) =>
          candidate.profileId === profileId && candidate.version === version,
      );
      return manifest ? publishedVersion(manifest) : null;
    });

  const definition = (
    reference: HarnessProfileReference,
  ): WorkflowDefinitionV2 => ({
    schemaVersion: 2,
    nodes: [
      {
        id: "implement",
        type: "implementation_agent",
        name: "Implementation agent",
        x: 0,
        y: 0,
        configuration: {
          harnessProfile: { ...reference },
          prompt: "Implement the ticket.",
        },
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  });

  const codexPinned = definition(builtinHarnessProfileReference("codex"));
  const claudePinned = definition(builtinHarnessProfileReference("claude"));

  it("redirects a codex pin to Claude for an agent:claude ticket", async () => {
    const load = loaderOver(catalog());

    const runtimes = await resolveHarnessRuntimesWithLoader(
      codexPinned,
      "codex",
      load,
      parseAgentKindOverride(["agent:claude"]),
    );

    expect(runtimes.implement.manifest).toMatchObject({
      profileId: "builtin-claude",
      harness: { provider: "claude" },
      model: { id: "claude-opus-4-8" },
    });
    expect(runtimes.implement.cliSpec.kind).toBe("claude");
  });

  // The rollback lever: if the Claude default misbehaves, an `agent:codex` label
  // is what moves one ticket back without redeploying a definition.
  it("redirects a Claude pin to codex for an agent:codex ticket", async () => {
    const load = loaderOver(catalog());

    const runtimes = await resolveHarnessRuntimesWithLoader(
      claudePinned,
      "claude",
      load,
      parseAgentKindOverride(["agent:codex"]),
    );

    expect(runtimes.implement.manifest).toMatchObject({
      profileId: "builtin-codex",
      harness: { provider: "codex" },
      model: { id: "gpt-5.4" },
    });
    expect(runtimes.implement.cliSpec.kind).toBe("codex");
  });

  it("keeps the codex pin when the ticket carries no agent label", async () => {
    const load = loaderOver(catalog());

    const runtimes = await resolveHarnessRuntimesWithLoader(
      codexPinned,
      "claude",
      load,
      parseAgentKindOverride(["needs-review"]),
    );

    expect(runtimes.implement.manifest).toMatchObject({
      profileId: "builtin-codex",
      harness: { provider: "codex" },
      model: { id: "gpt-5.4" },
    });
    // The pinned version is the only one loaded, so the default path costs
    // exactly what it cost before the label could redirect anything.
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(builtinHarnessProfileReference("codex"));
  });

  it("keeps an organization profile that already runs the demanded provider", async () => {
    const load = loaderOver(catalog());

    const runtimes = await resolveHarnessRuntimesWithLoader(
      definition({
        profileId: ORG_CLAUDE_PROFILE.profileId,
        version: ORG_CLAUDE_PROFILE.version,
      }),
      "codex",
      load,
      parseAgentKindOverride(["agent:claude"]),
    );

    expect(runtimes.implement.manifest).toMatchObject({
      profileId: "org-claude",
      harness: { provider: "claude" },
      model: { id: "claude-org-pinned" },
    });
  });

  it("fails the run when the demanded system profile is unpublished", async () => {
    const load = loaderOver(
      catalog().filter((manifest) => manifest.profileId !== "builtin-claude"),
    );

    await expect(
      resolveHarnessRuntimesWithLoader(
        codexPinned,
        "codex",
        load,
        parseAgentKindOverride(["agent:claude"]),
      ),
    ).rejects.toThrow(
      /"agent:claude" label cannot be honoured for block "implement"/,
    );
  });

  it("names the redirected profile when its workspace cannot serve the block", async () => {
    const load = loaderOver([
      structuredClone(BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-codex"]),
      {
        ...structuredClone(BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-claude"]),
        workspace: { mode: "managed", preserveAcrossBlocks: false },
      },
    ]);

    // The pin would have satisfied the block, so naming it here would send an
    // operator to repair the wrong profile.
    await expect(
      resolveHarnessRuntimesWithLoader(
        codexPinned,
        "codex",
        load,
        parseAgentKindOverride(["agent:claude"]),
      ),
    ).rejects.toThrow(
      /Harness Profile "builtin-claude" version 2 cannot be used by block "implement"/,
    );
  });

  it("reports the unavailable pin rather than the label when the pin cannot resolve", async () => {
    const load = loaderOver(catalog());

    // A label cannot rescue a definition whose own pin is gone: the pin is
    // resolved first, and its failure is the one an operator has to fix.
    await expect(
      resolveHarnessRuntimesWithLoader(
        definition({ profileId: "org-retired", version: 9 }),
        "codex",
        load,
        parseAgentKindOverride(["agent:claude"]),
      ),
    ).rejects.toThrow(
      /Harness Profile "org-retired" version 9 is unavailable for block "implement"/,
    );
  });
});
