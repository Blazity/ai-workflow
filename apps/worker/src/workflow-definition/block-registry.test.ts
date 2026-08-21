import { describe, expect, it } from "vitest";
import {
  BLOCK_TYPE_SPECS,
  MANUALLY_DISPATCHABLE_TRIGGER_TYPES,
  NON_DISPATCHABLE_TRIGGER_TYPES,
  TRIGGER_BLOCK_TYPES,
  type WorkflowBlockType,
} from "@shared/contracts";
import {
  buildWorkflowBlockRegistry,
  resolveWorkflowBlockContract,
  validateBlockOutputForDefinition,
  workflowBlockDefinitionIssues,
  workflowBlockDeploymentDefinitionIssues,
  workflowRepositoryScopeIssues,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

const context: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: false },
  llmProviders: { claude: true, codex: false },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github"],
  vcsBotIdentities: [],
  slackConfigured: false,
  arthurConfigured: false,
  webhookTriggerConfigured: false,
};

describe("workflow block registry", () => {
  it("owns a complete contract for every workflow block type", () => {
    const registry = buildWorkflowBlockRegistry(context);
    const blockTypes = Object.keys(BLOCK_TYPE_SPECS) as WorkflowBlockType[];

    expect(Object.keys(registry).sort()).toEqual([...blockTypes].sort());
    for (const type of blockTypes) {
      const contract = registry[type];
      expect(contract.type).toBe(type);
      expect(contract.presentation.label.trim(), `${type} label`).not.toBe("");
      expect(contract.presentation.description.trim(), `${type} description`).not.toBe("");
      expect(contract.presentation.group.trim(), `${type} group`).not.toBe("");
      expect(contract.defaults, `${type} defaults`).toBeTypeOf("object");
      expect(contract.ports, `${type} ports`).toEqual(BLOCK_TYPE_SPECS[type].ports);
      expect(contract.allowsFailurePort, `${type} failure port`).toBe(
        BLOCK_TYPE_SPECS[type].allowsFailurePort,
      );
      expect(contract.inputs, `${type} inputs`).toBeTypeOf("object");
      expect(contract.additionalInputs, `${type} additional inputs`).toBeInstanceOf(Array);
      expect(contract.output.schema, `${type} output`).toBeTypeOf("object");
      expect(contract.output.bindingSchema, `${type} binding output`).toBeTypeOf("object");
      expect(contract.output.statusVariants.length, `${type} statuses`).toBeGreaterThan(0);
    }
  });

  it("does not advertise execution errors as normal action outputs", () => {
    const registry = buildWorkflowBlockRegistry(context);
    for (const [type, spec] of Object.entries(BLOCK_TYPE_SPECS)) {
      if (spec.category !== "action") continue;
      expect(registry[type as WorkflowBlockType].output.statusVariants, type).not.toContain(
        "failed",
      );
    }
  });

  it("declares safe variadic Finalize check inputs", () => {
    const contract = buildWorkflowBlockRegistry(context).finalize_workspace;
    expect(contract.additionalInputs).toEqual([
      {
        keyPattern: "^checks\\.[A-Za-z0-9_-]+$",
        schema: { type: "string" },
      },
    ]);
  });

  it("separates the full output envelope from fields guaranteed on normal output", () => {
    const registry = buildWorkflowBlockRegistry(context);
    expect(registry.planning_agent.output.schema).toMatchObject({ required: ["status"] });
    expect(registry.planning_agent.output.bindingSchema).toMatchObject({
      required: ["status", "plan"],
    });
    expect(registry.review_agent.output.bindingSchema).toMatchObject({
      required: ["status", "findings", "decision"],
    });
  });

  it("advertises only inputs current executors actually consume", () => {
    const registry = buildWorkflowBlockRegistry(context);

    for (const contract of Object.values(registry)) {
      for (const [name, inputContract] of Object.entries(contract.inputs)) {
        const isBindingOnlyPlan = contract.type === "send_plan_approval" && name === "plan";
        const isFinalizedPublication =
          contract.type === "open_pr" && name === "repositories";
        const isRunOwnedCheck =
          contract.type === "complete_pr_check" && name === "check";
        const isReviewResults =
          contract.type === "post_pr_review" && name === "reviewResults";
        expect(inputContract.required, `${contract.type}.${name}`).toBe(
          isBindingOnlyPlan ||
            isFinalizedPublication ||
            isRunOwnedCheck ||
            isReviewResults,
        );
      }
    }
    expect(registry.open_pr.inputs).toEqual({
      repositories: {
        required: true,
        schema: expect.objectContaining({ type: "array" }),
      },
      title: { required: false, schema: { type: "string" } },
      body: { required: false, schema: { type: "string" } },
    });
    expect(registry.planning_agent.inputs).toEqual({
      ticket: { required: false, schema: expect.objectContaining({ type: "object" }) },
      comments: {
        required: false,
        schema: expect.objectContaining({ type: "array" }),
      },
      priorAnswers: {
        required: false,
        schema: expect.objectContaining({ type: "array" }),
      },
    });
    expect(registry.implementation_agent.inputs).toEqual({
      ticket: { required: false, schema: expect.objectContaining({ type: "object" }) },
      plan: { required: false, schema: { type: "string" } },
    });
    const reviewFeedbackInput = {
      required: false,
      schema: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: ["changes_requested", "commented"],
          },
          author: { type: "string" },
          body: { type: "string" },
        },
        required: ["state", "author", "body"],
        additionalProperties: false,
      },
    };
    expect(registry.review_agent.inputs).toEqual({
      reviewFeedback: reviewFeedbackInput,
    });
    expect(registry.fix_agent.inputs).toEqual({
      reviewFeedback: reviewFeedbackInput,
      reviewResults: {
        required: false,
        schema: expect.objectContaining({
          type: "array",
          items: expect.objectContaining({
            type: "object",
            required: ["decision", "findings"],
            additionalProperties: true,
          }),
        }),
      },
    });
    expect(registry.fetch_pr_context.inputs).toEqual({});
    expect(Object.keys(registry.generic_agent.inputs)).toEqual(["prompt"]);
    expect(Object.keys(registry.call_llm.inputs)).toEqual(["prompt", "system"]);
    expect(Object.keys(registry.update_ticket_status.inputs)).toEqual(["target"]);
    expect(Object.keys(registry.post_ticket_comment.inputs)).toEqual(["body"]);
    expect(Object.keys(registry.post_pr_comment.inputs)).toEqual(["body"]);
    expect(Object.keys(registry.send_slack_message.inputs)).toEqual(["message"]);
    expect(Object.keys(registry.human_question.inputs)).toEqual([
      "questions",
      "suggestedAnswers",
      "context",
    ]);
    expect(registry.trigger_ticket_ai.output.bindingSchema).toMatchObject({
      required: expect.arrayContaining(["ticket", "comments", "priorAnswers"]),
    });
  });

  it("advertises the canonical Fix classification and workspace state", () => {
    const registry = buildWorkflowBlockRegistry(context);

    expect(registry.fix_agent.output.statusVariants).toEqual([
      "fixed",
      "needs_human_input",
    ]);
    expect(registry.fix_agent.output.bindingSchema).toMatchObject({
      required: [
        "status",
        "workspaceId",
        "commits",
        "resolvedConflicts",
        "unresolvedConflicts",
        "summary",
      ],
    });
  });

  it("publishes typed review decisions, finding severity, and check outcomes", () => {
    const registry = buildWorkflowBlockRegistry(context);
    expect(registry.review_agent.output.bindingSchema).toMatchObject({
      properties: {
        decision: {
          type: "string",
          enum: ["approve", "request_changes"],
        },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ["Blocker", "High", "Medium", "Nit"],
              },
            },
          },
        },
      },
    });
    for (const type of ["run_pre_pr_checks", "run_checks", "run_scripts"] as const) {
      expect(registry[type].output.bindingSchema).toMatchObject({
        properties: {
          outcome: {
            type: "string",
            enum: [
              "passed",
              "failed",
              "skipped",
              "missing_configuration",
            ],
          },
        },
        required: expect.arrayContaining(["outcome"]),
      });
    }
    expect(registry.run_checks.output.bindingSchema).toMatchObject({
      properties: { skipReason: { type: "string" } },
    });
    expect(
      (registry.run_checks.output.bindingSchema as { required?: string[] })
        .required,
    ).not.toContain("skipReason");
  });

  it("publishes the repository script contract both script blocks bind against", () => {
    const registry = buildWorkflowBlockRegistry(context);
    // Stage 4's diagnose/trace layer reads the outcome and the summary, so both
    // have to be guaranteed on a normal output rather than merely declared: an
    // optional field is one an operator cannot rely on reading.
    for (const type of ["run_pre_pr_checks", "run_scripts"] as const) {
      expect(registry[type].output.bindingSchema, type).toMatchObject({
        properties: {
          ok: { type: "boolean" },
          allPassed: { type: "boolean" },
          anyFailed: { type: "boolean" },
          summary: { type: "string" },
          groupStatuses: {
            type: "array",
            items: {
              type: "object",
              properties: {
                provider: { type: "string" },
                repoPath: { type: "string" },
                group: { type: "string" },
                status: {
                  type: "string",
                  enum: ["passed", "failed", "timed_out", "skipped", "not_run"],
                },
              },
            },
          },
        },
        required: expect.arrayContaining([
          "ok",
          "outcome",
          "allPassed",
          "anyFailed",
          "groupStatuses",
          "summary",
        ]),
      });
    }
  });

  it("publishes the per-command record both script blocks report", () => {
    const registry = buildWorkflowBlockRegistry(context);
    // groupStatuses answers "did the group pass". These answer "what actually
    // ran, what broke, and what it left behind", which is what a fix wire binds
    // to feed an agent and what a formatter flow binds to decide whether there
    // is anything to commit. All four are required: an empty array and an
    // absent one read the same in a template but not in a binding.
    for (const type of ["run_pre_pr_checks", "run_scripts"] as const) {
      expect(registry[type].output.bindingSchema, type).toMatchObject({
        properties: {
          setupFailed: { type: "boolean" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                repo: { type: "string" },
                command: { type: "string" },
                group: { type: "string" },
                exitCode: { type: "number" },
                durationMs: { type: "number" },
                timedOut: { type: "boolean" },
              },
            },
          },
          failures: {
            type: "array",
            items: {
              type: "object",
              properties: {
                repo: { type: "string" },
                command: { type: "string" },
                exitCode: { type: "number" },
                output: { type: "string" },
              },
            },
          },
          dirtied: {
            type: "array",
            items: {
              type: "object",
              properties: {
                repo: { type: "string" },
                files: { type: "array", items: { type: "string" } },
                preExisting: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        required: expect.arrayContaining([
          "results",
          "failures",
          "dirtied",
          "setupFailed",
        ]),
      });
    }
  });

  it("keeps the execution-error word out of both script blocks' status vocabulary", () => {
    const registry = buildWorkflowBlockRegistry(context);
    // "failed" stays reserved for execution errors. A failing script run is an
    // ordinary branchable outcome and says so through ok/outcome/anyFailed,
    // never by borrowing the word the failure port owns.
    expect(registry.run_scripts.output.statusVariants).toEqual(["ok", "skipped"]);
    expect(registry.run_pre_pr_checks.output.statusVariants).toEqual(["ok", "skipped"]);
  });

  it("keeps the gate's fixCycles field and drops the retired repair default", () => {
    const registry = buildWorkflowBlockRegistry(context);
    // The field stays required in the output contract: definitions deployed
    // against it bind steps.checks.output.fixCycles today, and dropping it
    // would break them. The authored default goes, because nothing reads it.
    expect(registry.run_pre_pr_checks.output.bindingSchema).toMatchObject({
      properties: { fixCycles: { type: "number" } },
      required: expect.arrayContaining(["fixCycles"]),
    });
    expect(registry.run_pre_pr_checks.defaults).toEqual({});
    expect(registry.run_scripts.defaults).toEqual({ groups: ["checks"] });
  });

  it("never lets repository scripts advertise a publication gate", () => {
    const registry = buildWorkflowBlockRegistry(context);
    // recoverPrePrGateFromSteps walks every step output looking for the
    // outcome+gate pair. run_scripts carries outcome, so the only thing keeping
    // it out of gate recovery is the absence of the key itself.
    const schema = registry.run_scripts.output.schema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).not.toContain("gate");
    expect(registry.run_pre_pr_checks.output.schema).toMatchObject({
      properties: { gate: { type: "nullable" } },
    });
  });

  it("rejects runtime values outside nested typed enums", () => {
    expect(
      validateBlockOutputForDefinition(
        "review_agent",
        {},
        {
          status: "reviewed",
          findings: [
            {
              file: "src/index.ts",
              description: "Invalid severity",
              severity: "showstopper",
            },
          ],
          decision: "maybe",
        },
        { requireNormalOutput: true },
      ),
    ).toEqual(
      expect.arrayContaining([
        "output.decision must be one of: approve, request_changes.",
        "output.findings[0].severity must be one of: Blocker, High, Medium, Nit.",
      ]),
    );

    expect(
      validateBlockOutputForDefinition(
        "run_checks",
        {},
        {
          status: "ok",
          ok: false,
          outcome: "unknown",
          results: [],
          failures: [],
        },
        { requireNormalOutput: true },
      ),
    ).toContain(
      "output.outcome must be one of: passed, failed, skipped, missing_configuration.",
    );
  });

  it("accepts the no-op planning_agent shape alongside the existing ready shape", () => {
    const registry = buildWorkflowBlockRegistry(context);
    expect(registry.planning_agent.output.statusVariants).toEqual([
      "ready",
      "needs_human_input",
      "no_change_needed",
    ]);
    expect(
      validateBlockOutputForDefinition("planning_agent", {}, {
        status: "no_change_needed",
        evidence: ["Commit a1b2c3d already fixes this."],
      }),
    ).toEqual([]);
    expect(
      validateBlockOutputForDefinition("planning_agent", {}, {
        status: "ready",
        plan: "Implement the feature.",
      }),
    ).toEqual([]);
  });

  it("accepts the no-op planning_agent output the short-circuit returns under requireNormalOutput", () => {
    expect(
      validateBlockOutputForDefinition(
        "planning_agent",
        {},
        {
          status: "no_change_needed",
          plan: "The reported crash is already fixed on main.",
          evidence: ["Commit a1b2c3d guards the null branch."],
        },
        { requireNormalOutput: true },
      ),
    ).toEqual([]);
  });

  it("defaults newly authored Generic Agent blocks to workspace-free mode", () => {
    expect(buildWorkflowBlockRegistry(context).generic_agent.defaults).toMatchObject({
      workspaceMode: "none",
    });
  });

  it("maps the Webhook trigger to top-level payload fields by default", () => {
    expect(buildWorkflowBlockRegistry(context).trigger_webhook.defaults).toEqual({
      authScheme: "hmac_sha256",
      requireTimestamp: false,
      timestampToleranceSeconds: 300,
      mapSubject: "subject",
      mapDescription: "description",
      mapRequester: "requester",
      mapPriority: "priority",
    });
  });

  it("gates the Webhook trigger on a configured encryption key", () => {
    expect(buildWorkflowBlockRegistry(context).trigger_webhook.availability).toEqual({
      available: false,
      unavailableReason: "Webhook trigger encryption is not configured.",
    });
    expect(
      buildWorkflowBlockRegistry({ ...context, webhookTriggerConfigured: true })
        .trigger_webhook.availability,
    ).toEqual({ available: true, unavailableReason: null });
  });

  it("always explains why an environmentally unavailable block is disabled", () => {
    const registry = buildWorkflowBlockRegistry(context);
    expect(registry.send_slack_message.availability).toEqual({
      available: false,
      unavailableReason: "Slack messaging is not configured.",
    });
    expect(registry.arthur_injection_check.availability).toEqual({
      available: false,
      unavailableReason: "Arthur Engine is not configured.",
    });

    for (const contract of Object.values(registry)) {
      if (!contract.availability.available) {
        expect(contract.availability.unavailableReason.trim(), contract.type).not.toBe("");
      }
    }
  });

  it("derives Generic Agent's top-level fields and compatibility data alias from outputSchema", () => {
    const contract = resolveWorkflowBlockContract(
      "generic_agent",
      {
        provider: "claude",
        prompt: "summarize",
        outputSchema: JSON.stringify({
          type: "object",
          properties: {
            summary: { type: "string" },
            stats: {
              type: "object",
              properties: { passed: { type: "number" } },
              required: ["passed"],
              additionalProperties: false,
            },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "stats"],
          additionalProperties: false,
        }),
      },
      context,
    );

    expect(contract.output.schema).toEqual({
      type: "object",
      properties: {
        status: { type: "string" },
        summary: { type: "string" },
        stats: {
          type: "object",
          properties: { passed: { type: "number" } },
          required: ["passed"],
          additionalProperties: false,
        },
        tags: { type: "array", items: { type: "string" } },
        data: {
          type: "object",
          properties: {
            summary: { type: "string" },
            stats: {
              type: "object",
              properties: { passed: { type: "number" } },
              required: ["passed"],
              additionalProperties: false,
            },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "stats"],
          additionalProperties: false,
        },
      },
      required: ["status"],
      additionalProperties: false,
    });
    expect(contract.output.bindingSchema).toMatchObject({
      required: ["status", "summary", "stats", "data"],
    });
  });

  it("derives Call LLM's output field and disables malformed JSON schema", () => {
    const declared = resolveWorkflowBlockContract(
      "call_llm",
      { prompt: "count", outputSchema: '{"type":"array","items":{"type":"boolean"}}' },
      context,
    );
    expect(declared.output.schema).toEqual({
      type: "object",
      properties: {
        status: { type: "string" },
        output: { type: "array", items: { type: "boolean" } },
      },
      required: ["status"],
      additionalProperties: false,
    });

    const invalid = resolveWorkflowBlockContract(
      "call_llm",
      { prompt: "count", outputSchema: "{not-json" },
      context,
    );
    expect(invalid.output.schema).toMatchObject({
      type: "object",
      properties: { output: { type: "unknown" } },
    });
    expect(invalid.availability).toEqual({
      available: false,
      unavailableReason: "outputSchema is not valid JSON.",
    });
  });

  it.each(["status", "data"])(
    "rejects Generic Agent outputSchema property %s because the runtime owns it",
    (reserved) => {
      const contract = resolveWorkflowBlockContract(
        "generic_agent",
        {
          prompt: "work",
          outputSchema: JSON.stringify({
            type: "object",
            properties: { [reserved]: { type: "string" } },
            required: [reserved],
            additionalProperties: false,
          }),
        },
        context,
      );

      expect(contract.availability).toEqual({
        available: false,
        unavailableReason: `outputSchema property "${reserved}" is reserved by Generic Agent.`,
      });
    },
  );

  it.each([
    ["42", "outputSchema must be a JSON Schema object."],
    ['{"type":"made-up"}', 'outputSchema has unsupported type "made-up".'],
    ['{"type":"integer"}', 'outputSchema has unsupported type "integer".'],
    [
      '{"type":"string","pattern":"^[A-Z]+$"}',
      'outputSchema uses unsupported validation keyword "pattern".',
    ],
    [
      '{"type":"object","properties":{"nested":{"type":"made-up"}}}',
      'outputSchema.properties.nested has unsupported type "made-up".',
    ],
  ])("disables valid JSON that is not a supported recursive schema", (outputSchema, reason) => {
    const contract = resolveWorkflowBlockContract(
      "call_llm",
      { prompt: "work", outputSchema },
      context,
    );
    expect(contract.availability).toMatchObject({
      available: false,
      unavailableReason: reason,
    });
  });

  it("retains enum, description, and nullable metadata from a declared schema", () => {
    const contract = resolveWorkflowBlockContract(
      "call_llm",
      {
        prompt: "classify",
        outputSchema: JSON.stringify({
          type: "object",
          properties: {
            state: {
              type: "string",
              description: "Current state",
              enum: ["ready", "blocked"],
            },
            reason: { type: ["string", "null"] },
          },
          required: ["state"],
          additionalProperties: false,
        }),
      },
      context,
    );

    expect(contract.output.schema).toMatchObject({
      properties: {
        output: {
          type: "object",
          properties: {
            state: {
              type: "string",
              description: "Current state",
              enum: ["ready", "blocked"],
            },
            reason: { type: "nullable", value: { type: "string" } },
          },
        },
      },
    });
  });

  it("keeps open v1 schemas runtime-compatible but rejects them for deployment", () => {
    const params = {
      prompt: "classify",
      outputSchema: JSON.stringify({
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { state: { type: "string" } },
          },
        },
        additionalProperties: false,
      }),
    };

    expect(workflowBlockDefinitionIssues("call_llm", params)).toEqual([]);
    expect(workflowBlockDeploymentDefinitionIssues("call_llm", params)).toEqual([
      expect.objectContaining({
        code: "invalid_schema",
        path: "/properties/nested/additionalProperties",
      }),
    ]);
  });

  it("treats a blank outputSchema as the block's unstructured default", () => {
    const registry = buildWorkflowBlockRegistry(context);
    const generic = resolveWorkflowBlockContract(
      "generic_agent",
      { prompt: "work", outputSchema: "   " },
      context,
    );
    const llm = resolveWorkflowBlockContract(
      "call_llm",
      { prompt: "work", outputSchema: "   " },
      context,
    );

    expect(generic.output.schema).toEqual(registry.generic_agent.output.schema);
    expect(llm.output.schema).toEqual(registry.call_llm.output.schema);
  });

  it("marks a block unavailable when its selected agent provider has no credentials", () => {
    const contract = resolveWorkflowBlockContract(
      "generic_agent",
      { provider: "codex", prompt: "work" },
      context,
    );
    expect(contract.availability).toEqual({
      available: false,
      unavailableReason: "Codex credentials are not configured.",
    });
  });

  it("distinguishes OAuth-capable Codex agents from API-key-only Call LLM", () => {
    const oauthOnly: WorkflowBlockRegistryContext = {
      ...context,
      agentProviders: { claude: false, codex: true },
      llmProviders: { claude: false, codex: false },
      defaultAgent: { provider: "codex", model: "gpt-5-codex" },
    };

    expect(
      resolveWorkflowBlockContract("generic_agent", { prompt: "work" }, oauthOnly).availability,
    ).toEqual({ available: true, unavailableReason: null });
    expect(
      resolveWorkflowBlockContract("call_llm", { prompt: "work" }, oauthOnly).availability,
    ).toEqual({
      available: false,
      unavailableReason: "Codex API credentials are not configured for Call LLM.",
    });
  });

  it("uses runtime model inference for Call LLM across a different run default", () => {
    const claudeDefault: WorkflowBlockRegistryContext = {
      ...context,
      llmProviders: { claude: true, codex: false },
      defaultAgent: { provider: "claude", model: "claude-test" },
    };
    expect(
      resolveWorkflowBlockContract(
        "call_llm",
        { prompt: "work", model: "gpt-5" },
        claudeDefault,
      ).availability,
    ).toEqual({
      available: false,
      unavailableReason: "Codex API credentials are not configured for Call LLM.",
    });

    const codexDefault: WorkflowBlockRegistryContext = {
      ...context,
      llmProviders: { claude: true, codex: false },
      defaultAgent: { provider: "codex", model: "gpt-5-codex" },
    };
    expect(
      resolveWorkflowBlockContract(
        "call_llm",
        { prompt: "work", model: "claude-haiku-4-5" },
        codexDefault,
      ).availability,
    ).toEqual({ available: true, unavailableReason: null });
  });

  it("marks a VCS trigger unavailable when none of its selected providers are installed", () => {
    const gitlabOnly = resolveWorkflowBlockContract(
      "trigger_pr_review",
      { providers: ["gitlab"], on: ["commented"] },
      context,
    );
    expect(gitlabOnly.availability).toEqual({
      available: false,
      unavailableReason: "Selected VCS providers are not configured: gitlab.",
    });

    expect(buildWorkflowBlockRegistry(context).trigger_pr_review.availability).toEqual({
      available: true,
      unavailableReason: null,
    });
  });

  it("authors a usable PR review trigger by default in a GitLab-only deployment", () => {
    const review = buildWorkflowBlockRegistry({
      ...context,
      vcsProviders: ["gitlab"],
      vcsBotIdentities: ["gitlab"],
    }).trigger_pr_review;

    expect(review.defaults).toMatchObject({
      providers: ["gitlab"],
      on: ["commented"],
      scope: "workflow_owned",
    });
    expect(review.availability).toEqual({ available: true, unavailableReason: null });
  });

  it("rejects GitLab review triggers that omit the only reliable Note Hook state", () => {
    const gitlab = resolveWorkflowBlockContract(
      "trigger_pr_review",
      { providers: ["gitlab"], on: ["changes_requested"] },
      { ...context, vcsProviders: ["gitlab"], vcsBotIdentities: ["gitlab"] },
    );

    expect(gitlab.availability).toEqual({
      available: false,
      unavailableReason:
        'GitLab review triggers must include "commented"; GitLab does not emit a reliable changes-requested review event.',
    });

    expect(
      resolveWorkflowBlockContract(
        "trigger_pr_review",
        { providers: ["github"], on: ["changes_requested"] },
        context,
      ).availability,
    ).toEqual({ available: true, unavailableReason: null });
  });

  it("requires bot identities for every configured provider selected by a commented trigger", () => {
    const mixed = resolveWorkflowBlockContract(
      "trigger_pr_review",
      { providers: ["github", "gitlab"], on: ["changes_requested", "commented"] },
      {
        ...context,
        vcsProviders: ["github", "gitlab"],
        vcsBotIdentities: ["github"],
      },
    );

    expect(mixed.availability).toEqual({
      available: false,
      unavailableReason:
        "Commented review triggers require a configured GITLAB_BOT_LOGIN to prevent recursive bot reviews.",
    });
  });

  it("keeps an incomplete checks trigger editable until deployment validation", () => {
    expect(
      resolveWorkflowBlockContract(
        "trigger_pr_checks_failed",
        {
          providers: ["github"],
          scope: "workflow_owned",
          checkNames: [],
          githubAppSlugs: ["github-actions"],
          gitlabPipelineSources: ["merge_request_event"],
        },
        context,
      ).availability,
    ).toEqual({ available: true, unavailableReason: null });

    expect(
      resolveWorkflowBlockContract(
        "trigger_pr_checks_failed",
        {
          providers: ["github"],
          scope: "workflow_owned",
          checkNames: ["ci / build"],
          githubAppSlugs: ["github-actions"],
          gitlabPipelineSources: ["merge_request_event"],
        },
        context,
      ).availability,
    ).toEqual({ available: true, unavailableReason: null });
  });

  it.each([
    "trigger_pr_created",
    "trigger_pr_checks_failed",
    "trigger_pr_review",
    "trigger_pr_merged",
  ] as const)("declares ticketKey only for workflow-owned %s contracts", (type) => {
    const owned = resolveWorkflowBlockContract(
      type,
      { scope: "workflow_owned", providers: ["github"] },
      context,
    );
    const arbitrary = resolveWorkflowBlockContract(
      type,
      { scope: "any", providers: ["github"] },
      context,
    );

    for (const schema of [owned.output.schema, owned.output.bindingSchema]) {
      expect(schema).toMatchObject({
        properties: { ticketKey: { type: "string" } },
        required: expect.arrayContaining(["ticketKey"]),
      });
    }
    for (const schema of [arbitrary.output.schema, arbitrary.output.bindingSchema]) {
      expect(schema).toMatchObject({
        required: expect.not.arrayContaining(["ticketKey"]),
      });
      expect(schema).not.toHaveProperty("properties.ticketKey");
    }
  });
});

describe("definition repository pin validation", () => {
  it("accepts an absent, empty, or fully configured pin", () => {
    expect(workflowRepositoryScopeIssues(undefined, context)).toEqual([]);
    expect(workflowRepositoryScopeIssues({}, context)).toEqual([]);
    expect(
      workflowRepositoryScopeIssues(
        {
          providers: ["github"],
          repositories: [{ provider: "github", repoPath: "acme/api" }],
        },
        context,
      ),
    ).toEqual([]);
  });

  it("reports pinned providers none of which this server has configured", () => {
    expect(workflowRepositoryScopeIssues({ providers: ["gitlab"] }, context)).toEqual([
      "Pinned VCS providers are not configured: gitlab.",
    ]);
    expect(
      workflowRepositoryScopeIssues({ providers: ["github", "gitlab"] }, context),
    ).toEqual([]);
  });

  // Provider configuration is environment state: skipping it keeps an
  // already-deployed pinned definition loadable after that state changes.
  it("skips the provider check when environment availability is not checked", () => {
    expect(
      workflowRepositoryScopeIssues({ providers: ["gitlab"] }, context, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual([]);
  });

  // Without an explicit provider pin each repository carries its own provider, so
  // the environment check has to run per repository. Otherwise a GitLab pin on a
  // GitHub-only deployment would report nothing at all and fail only at runtime.
  it("reports pinned repositories whose own provider this server has not configured", () => {
    expect(
      workflowRepositoryScopeIssues(
        {
          repositories: [
            { provider: "github", repoPath: "acme/api" },
            { provider: "gitlab", repoPath: "acme/shared" },
            { provider: "gitlab", repoPath: "acme/docs" },
          ],
        },
        context,
      ),
    ).toEqual([
      "Pinned repositories use VCS providers that are not configured: gitlab:acme/shared, gitlab:acme/docs.",
    ]);
    expect(
      workflowRepositoryScopeIssues(
        { repositories: [{ provider: "github", repoPath: "acme/api" }] },
        context,
      ),
    ).toEqual([]);
  });

  // A provider list holding one configured and one unconfigured provider passes
  // the list-level check, so only the per-repository check can catch a repository
  // pinned to the unconfigured half.
  it("reports a pinned repository on an unconfigured provider its own list names", () => {
    const mixed = {
      providers: ["github" as const, "gitlab" as const],
      repositories: [
        { provider: "github" as const, repoPath: "acme/api" },
        { provider: "gitlab" as const, repoPath: "acme/app" },
      ],
    };

    expect(workflowRepositoryScopeIssues(mixed, context)).toEqual([
      "Pinned repositories use VCS providers that are not configured: gitlab:acme/app.",
    ]);
    expect(
      workflowRepositoryScopeIssues(mixed, context, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual([]);
  });

  // Same environment escape as the provider list above: a definition already
  // deployed against a since-disconnected provider stays loadable.
  it("skips the per-repository provider check when environment availability is not checked", () => {
    expect(
      workflowRepositoryScopeIssues(
        { repositories: [{ provider: "gitlab", repoPath: "acme/shared" }] },
        context,
        { checkEnvironmentAvailability: false },
      ),
    ).toEqual([]);
  });

  // A pinned repository its own provider list excludes can never resolve. It must
  // surface as an authoring issue instead of being dropped at runtime, so it is
  // reported even when environment availability is skipped.
  it("reports a pinned repository excluded by the pinned provider list", () => {
    const contradiction = {
      providers: ["github" as const],
      repositories: [
        { provider: "github" as const, repoPath: "acme/api" },
        { provider: "gitlab" as const, repoPath: "acme/shared" },
      ],
    };
    const expected = [
      "Pinned repositories use providers excluded by the pinned provider list: gitlab:acme/shared.",
    ];

    expect(workflowRepositoryScopeIssues(contradiction, context)).toEqual(expected);
    expect(
      workflowRepositoryScopeIssues(contradiction, context, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual(expected);
  });
});

describe("manual dispatch allowlist", () => {
  // TRIGGER_BLOCK_TYPES is derived from BLOCK_TYPE_SPECS at runtime, so the
  // compiler cannot force a new trigger into one of the two halves. This is that
  // force. It exists because the dashboard used to decide the same question with a
  // deny-list, which silently offered manual dispatch for a trigger nobody had
  // considered, and the failure surfaced to the user as a false error message.
  it("partitions every trigger type into dispatchable or not, with no overlap", () => {
    const dispatchable = [...MANUALLY_DISPATCHABLE_TRIGGER_TYPES] as WorkflowBlockType[];
    const nonDispatchable = [...NON_DISPATCHABLE_TRIGGER_TYPES] as WorkflowBlockType[];

    expect([...dispatchable, ...nonDispatchable].sort()).toEqual(
      [...TRIGGER_BLOCK_TYPES].sort(),
    );
    expect(dispatchable.filter((type) => nonDispatchable.includes(type))).toEqual([]);
  });

  it("lists no block that is not a trigger", () => {
    const notTriggers = [
      ...MANUALLY_DISPATCHABLE_TRIGGER_TYPES,
      ...NON_DISPATCHABLE_TRIGGER_TYPES,
    ].filter((type) => BLOCK_TYPE_SPECS[type].category !== "trigger");
    expect(notTriggers).toEqual([]);
  });
});
