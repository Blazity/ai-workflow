import { describe, expect, it } from "vitest";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  builtinHarnessProfileReference,
  resolveBuiltinHarnessProfile,
} from "@shared/contracts";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  defaultWorkflowDefinition,
  defaultWorkflowDefinitionV2,
} from "./default.js";
import {
  workflowDefinitionTemplate,
  workflowDefinitionTemplates,
} from "./templates.js";
import {
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionV2Schema,
} from "./schema.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-opus-4-6" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
};

describe("built-in Harness Profiles", () => {
  it("publishes immutable version-one compatibility manifests", () => {
    const claude = resolveBuiltinHarnessProfile(
      builtinHarnessProfileReference("claude"),
    );
    const codex = resolveBuiltinHarnessProfile(
      builtinHarnessProfileReference("codex"),
    );

    expect(claude).toMatchObject({
      profileId: BUILTIN_HARNESS_PROFILE_IDS.claude,
      version: 1,
      harness: {
        provider: "claude",
        cliVersion: "2.1.216",
        protocolVersion: "claude-json-2.1.216",
      },
      model: { id: "claude-opus-4-6" },
    });
    expect(codex).toMatchObject({
      profileId: BUILTIN_HARNESS_PROFILE_IDS.codex,
      version: 1,
      harness: {
        provider: "codex",
        cliVersion: "0.144.6",
        protocolVersion: "codex-jsonl-0.144.6",
      },
      model: { id: "gpt-5-codex" },
    });
    expect(Object.isFrozen(BUILTIN_HARNESS_PROFILE_MANIFESTS)).toBe(true);
    expect(Object.isFrozen(claude?.harness)).toBe(true);
  });
});

describe("v2 built-in authoring definitions", () => {
  it("keeps the legacy default on v1 and authors the new default on v2", () => {
    expect(defaultWorkflowDefinition({ includeReview: false }).schemaVersion).toBe(
      1,
    );
    const authored = defaultWorkflowDefinitionV2({
      includeReview: false,
      provider: "codex",
    });

    expect(authored.schemaVersion).toBe(2);
    expect(authored.nodes.map((node) => node.id)).toEqual([
      "trigger",
      "prepare",
      "planning",
      "implementation",
      "checks",
      "finalize",
      "open-pr",
      "slack",
      "status",
    ]);
    expect(
      authored.nodes.find((node) => node.id === "planning")?.configuration,
    ).toMatchObject({
      prompt: "{{prompt:research-plan@1}}",
      harnessProfile: {
        profileId: BUILTIN_HARNESS_PROFILE_IDS.codex,
        version: 1,
      },
    });
    expect(
      authored.nodes.findIndex((node) => node.id === "prepare"),
    ).toBeLessThan(authored.nodes.findIndex((node) => node.id === "planning"));
    expect(new Set(authored.edges.map((edge) => edge.id)).size).toBe(
      authored.edges.length,
    );
    expect(
      authored.nodes.find((node) => node.id === "implementation")
        ?.configuration.prompt,
    ).toBe("{{prompt:implement@1}}");
  });

  it("pins every built-in specialized prompt and exposes the Fix template task", () => {
    const templates = workflowDefinitionTemplates({
      includeReview: true,
      provider: "claude",
    });
    const ticket = templates.find((template) => template.id === "ticket-workflow")!
      .definition;
    const human = templates.find((template) => template.id === "human-approved-plan")!
      .definition;
    const fix = templates.find((template) => template.id === "review-fix-after-pr")!
      .definition;
    if (
      ticket.schemaVersion !== 2 ||
      human.schemaVersion !== 2 ||
      fix.schemaVersion !== 2
    ) {
      throw new Error("Built-in authoring templates must use schema version 2");
    }

    expect(ticket.nodes.find((node) => node.type === "planning_agent")
      ?.configuration.prompt).toBe("{{prompt:research-plan@1}}");
    expect(ticket.nodes.find((node) => node.type === "implementation_agent")
      ?.configuration.prompt).toBe("{{prompt:implement@1}}");
    expect(ticket.nodes.find((node) => node.type === "review_agent")
      ?.configuration.prompt).toBe("{{prompt:review@1}}");
    expect(human.nodes.find((node) => node.type === "planning_agent")
      ?.configuration.prompt).toBe("{{prompt:research-plan@1}}");
    expect(human.nodes.find((node) => node.type === "implementation_agent")
      ?.configuration.prompt).toBe("{{prompt:implement@1}}");
    expect(fix.nodes.find((node) => node.type === "fix_agent")
      ?.configuration.instructions).toContain("Resolve the fetched pull-request");
  });

  it.each(["claude", "codex"] as const)(
    "builds every %s template as a structurally deployable v2 graph",
    (provider) => {
      const templates = workflowDefinitionTemplates({
        includeReview: true,
        provider,
      });

      expect(templates).toHaveLength(4);
      for (const template of templates) {
        expect(template.definition.schemaVersion).toBe(2);
        if (template.definition.schemaVersion !== 2) continue;
        expect(workflowDefinitionV2Schema.safeParse(template.definition).success)
          .toBe(true);
        expect(
          validateWorkflowDefinitionIssuesForDeployment(
            template.definition,
            registryContext,
          ),
          template.id,
        ).toEqual([]);
        expect(new Set(template.definition.edges.map((edge) => edge.id)).size)
          .toBe(template.definition.edges.length);
      }
    },
  );

  it("returns independent template snapshots", () => {
    const first = workflowDefinitionTemplate("ticket-workflow", {
      includeReview: false,
      provider: "claude",
    });
    const second = workflowDefinitionTemplate("ticket-workflow", {
      includeReview: false,
      provider: "claude",
    });
    expect(first?.definition).toEqual(second?.definition);
    expect(first?.definition).not.toBe(second?.definition);
  });
});

describe("v2 Harness Profile validation", () => {
  it("accepts one exact built-in reference and rejects unknown or mixed overrides", () => {
    const valid = defaultWorkflowDefinitionV2({
      includeReview: false,
      provider: "claude",
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(valid, registryContext),
    ).toEqual([]);

    const unknown = structuredClone(valid);
    const planning = unknown.nodes.find((node) => node.id === "planning")!;
    planning.configuration.harnessProfile = {
      profileId: "missing",
      version: 1,
    };
    expect(
      validateWorkflowDefinitionIssuesForDeployment(unknown, registryContext),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_configuration",
          nodeId: "planning",
          path: "/nodes/2/configuration/harnessProfile",
        }),
      ]),
    );

    const mixed = structuredClone(valid);
    mixed.nodes.find((node) => node.id === "planning")!.configuration.provider =
      "claude";
    expect(
      validateWorkflowDefinitionIssuesForDeployment(mixed, registryContext),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_configuration",
          nodeId: "planning",
        }),
      ]),
    );
  });
});
