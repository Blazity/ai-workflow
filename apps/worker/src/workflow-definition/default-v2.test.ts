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
import { validateHarnessProfileReferencesWithLoader } from "./harness-profile-runtime.js";
import { hashHarnessProfileManifest } from "../harness-profiles/manifest.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-opus-4-6" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

describe("built-in Harness Profiles", () => {
  it("publishes immutable versioned compatibility manifests", () => {
    const claude = resolveBuiltinHarnessProfile(
      builtinHarnessProfileReference("claude"),
    );
    const codex = resolveBuiltinHarnessProfile(
      builtinHarnessProfileReference("codex"),
    );

    expect(claude).toMatchObject({
      profileId: BUILTIN_HARNESS_PROFILE_IDS.claude,
      version: 2,
      harness: {
        provider: "claude",
        cliVersion: "2.1.216",
        protocolVersion: "claude-json-2.1.216",
      },
      model: { id: "claude-opus-4-8" },
    });
    expect(codex).toMatchObject({
      profileId: BUILTIN_HARNESS_PROFILE_IDS.codex,
      version: 2,
      harness: {
        provider: "codex",
        cliVersion: "0.144.6",
        protocolVersion: "codex-jsonl-0.144.6",
      },
      model: { id: "gpt-5.4" },
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
        version: 2,
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

  it("keeps the leak review out of both templates until the flag enables it", () => {
    const v1 = defaultWorkflowDefinition({ includeReview: false });
    const v2 = defaultWorkflowDefinitionV2({ includeReview: false });

    expect(v1.nodes.some((node) => node.type === "leak_review")).toBe(false);
    expect(v2.nodes.some((node) => node.type === "leak_review")).toBe(false);
    expect(v1).toEqual(
      defaultWorkflowDefinition({ includeReview: false, includeLeakReview: false }),
    );
    expect(v2).toEqual(
      defaultWorkflowDefinitionV2({ includeReview: false, includeLeakReview: false }),
    );
  });

  it("places the enabled leak review between checks and finalize on both templates", () => {
    const v1 = defaultWorkflowDefinition({
      includeReview: true,
      includeLeakReview: true,
    });
    expect(v1.nodes.map((node) => node.id)).toEqual([
      "trigger",
      "planning",
      "implementation",
      "review",
      "checks",
      "leak-review",
      "finalize",
      "open-pr",
      "slack",
      "status",
    ]);
    expect(v1.edges).toEqual(
      expect.arrayContaining([
        { from: "checks", to: "leak-review" },
        { from: "leak-review", to: "finalize" },
      ]),
    );
    expect(v1.edges.some((edge) => edge.from === "checks" && edge.to === "finalize")).toBe(
      false,
    );

    const v2 = defaultWorkflowDefinitionV2({
      includeReview: true,
      includeLeakReview: true,
    });
    expect(v2.nodes.map((node) => node.id)).toEqual([
      "trigger",
      "prepare",
      "planning",
      "implementation",
      "review",
      "checks",
      "leak-review",
      "finalize",
      "open-pr",
      "slack",
      "status",
    ]);
    expect(
      v2.edges.map(({ from, to }) => ({ from, to })),
    ).toEqual(
      expect.arrayContaining([
        { from: "checks", to: "leak-review" },
        { from: "leak-review", to: "finalize" },
      ]),
    );
    expect(new Set(v2.edges.map((edge) => edge.id)).size).toBe(v2.edges.length);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(v2, registryContext),
    ).toEqual([]);
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

      expect(templates).toHaveLength(7);
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

  it("builds the editable reviewed ticket retry graph", () => {
    const template = workflowDefinitionTemplate("reviewed-ticket-workflow", {
      includeReview: true,
      provider: "claude",
    });
    expect(template?.name).toBe("Reviewed ticket workflow");
    if (!template || template.definition.schemaVersion !== 2) {
      throw new Error("Reviewed ticket template must use schema version 2");
    }
    const definition = template.definition;
    const reviews = definition.nodes.filter(
      (node) => node.type === "review_agent",
    );
    expect(reviews.map((node) => node.name)).toEqual([
      "Security review",
      "Code quality review",
      "Requirements review",
    ]);
    const branch = definition.nodes.find(
      (node) => node.id === "reviews-approved",
    );
    expect(branch?.configuration).toMatchObject({
      combinator: "all",
      conditions: [
        { value: "approve" },
        { value: "approve" },
        { value: "approve" },
      ],
    });
    const loop = definition.nodes.find((node) => node.id === "retry");
    expect(loop?.configuration).toMatchObject({
      maxAttempts: 3,
      onExhaust: "fail",
      carry: expect.arrayContaining([
        expect.objectContaining({ name: "securityReview" }),
        expect.objectContaining({ name: "qualityReview" }),
        expect.objectContaining({ name: "requirementsReview" }),
      ]),
    });
    const fix = definition.nodes.find((node) => node.id === "fix");
    expect(fix?.inputs.reviewResults).toEqual({
      kind: "reference_list",
      references: [
        "steps.retry.output.values.securityReview",
        "steps.retry.output.values.qualityReview",
        "steps.retry.output.values.requirementsReview",
      ],
    });
    expect(
      definition.edges.filter(
        (edge) =>
          edge.from === "implementation" &&
          reviews.some((review) => review.id === edge.to),
      ),
    ).toHaveLength(3);
    expect(
      definition.edges.filter(
        (edge) =>
          edge.from === "fix" &&
          reviews.some((review) => review.id === edge.to),
      ),
    ).toHaveLength(3);
    expect(
      definition.nodes.find((node) => node.id === "exhausted-failure")
        ?.configuration,
    ).toEqual({ terminalStatus: "failed" });
  });

  it("builds the webhook triage graph with inline prompts", () => {
    const template = workflowDefinitionTemplate("webhook-ticket-triage", {
      includeReview: true,
      provider: "claude",
    });
    expect(template?.name).toBe("Ticket triage (webhook)");
    if (!template || template.definition.schemaVersion !== 2) {
      throw new Error("Webhook triage template must use schema version 2");
    }
    const definition = template.definition;
    expect(
      definition.nodes.find((node) => node.id === "trigger")?.type,
    ).toBe("trigger_webhook");
    const agents = definition.nodes.filter(
      (node) => node.type === "generic_agent",
    );
    expect(agents).toHaveLength(3);
    for (const agent of agents) {
      expect(typeof agent.configuration.prompt).toBe("string");
      expect(agent.configuration.prompt).not.toContain("{{prompt:");
      expect(agent.configuration.harnessProfile).toEqual({
        profileId: builtinHarnessProfileReference("claude").profileId,
        version: builtinHarnessProfileReference("claude").version,
      });
    }
    expect(
      definition.nodes.find((node) => node.id === "triage")?.configuration
        .prompt,
    ).toContain("{{data:steps.entry.output.subject}}");
    expect(
      definition.nodes.find((node) => node.id === "code-issue")?.configuration,
    ).toEqual({
      combinator: "all",
      conditions: [
        {
          reference: "steps.assess.output.codeIssue",
          operator: "equals",
          value: true,
        },
      ],
    });
    expect(
      definition.edges
        .filter((edge) => edge.from === "code-issue")
        .map(({ fromPort, to }) => ({ fromPort, to })),
    ).toEqual([
      { fromPort: "true", to: "prepare" },
      { fromPort: "false", to: "notify-no-code" },
    ]);
  });

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
  it("accepts one exact reference and rejects unknown or mixed overrides", async () => {
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
    const profileIssues = await validateHarnessProfileReferencesWithLoader(
      unknown,
      async (reference) => {
        const manifest =
          BUILTIN_HARNESS_PROFILE_MANIFESTS[
            reference.profileId as keyof typeof BUILTIN_HARNESS_PROFILE_MANIFESTS
          ];
        if (!manifest || manifest.version !== reference.version) return null;
        const cloned = structuredClone(manifest);
        return {
          manifest: cloned,
          manifestHash: hashHarnessProfileManifest(cloned),
          skillArtifacts: [],
        };
      },
    );
    expect(profileIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "harness_profile_unavailable",
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
