import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  BLOCK_PARAM_KEYS,
  type WorkflowBlockAdditionalInputContract,
  type WorkflowBlockContract,
  type WorkflowBlockType,
  type WorkflowValueSchema,
} from "@shared/contracts";
import {
  buildWorkflowBlockRegistry,
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

interface CatalogPath {
  path: string;
  type: string;
}

interface CatalogAdditionalInput extends CatalogPath {
  keyPattern: string;
}

interface CatalogShape {
  requiredInputs: CatalogPath[];
  optionalInputs: CatalogPath[];
  additionalInputs: CatalogAdditionalInput[];
  requiredOutputs: CatalogPath[];
  optionalOutputs: CatalogPath[];
  statuses: string[];
}

interface CatalogProbe extends CatalogShape {
  name: string;
  params: Record<string, unknown>;
}

interface CatalogBlock {
  runtimeType: WorkflowBlockType;
  runtimeContract: CatalogShape & {
    params: string[];
    probes?: CatalogProbe[];
  };
}

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
};

const declaredGenericSchema = JSON.stringify({
  type: "object",
  properties: {
    classification: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["classification"],
});

const declaredLlmSchema = JSON.stringify({
  type: "object",
  properties: {
    summary: { type: "string" },
    score: { type: "number" },
  },
  required: ["summary"],
});

function loadCatalog(): Record<string, CatalogBlock> {
  const html = readFileSync(
    new URL("../../../../docs/workflow-workspace/index.html", import.meta.url),
    "utf8",
  );
  const source = html.match(
    /const GROUPS = \{[\s\S]*?(?=\n\s*\/\* ={10,}\n\s*ENGINE)/,
  )?.[0];
  expect(source, "canvas catalog should be extractable").toBeTruthy();
  const context: { __catalog?: Record<string, CatalogBlock> } = {};
  vm.runInNewContext(`${source}\nglobalThis.__catalog = BLOCKS;`, context);
  return context.__catalog!;
}

function schemaType(schema: WorkflowValueSchema): string {
  switch (schema.type) {
    case "array":
      return `${schemaType(schema.items)}[]`;
    case "nullable":
      return `${schemaType(schema.value)} | null`;
    case "object":
      return "object";
    default:
      return schema.type;
  }
}

function outputPaths(
  schema: WorkflowValueSchema,
  prefix = "",
  parentRequired = true,
): { required: CatalogPath[]; optional: CatalogPath[] } {
  if (schema.type !== "object") return { required: [], optional: [] };
  const required: CatalogPath[] = [];
  const optional: CatalogPath[] = [];
  for (const [key, child] of Object.entries(schema.properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const isRequired = parentRequired && schema.required.includes(key);
    (isRequired ? required : optional).push({ path, type: schemaType(child) });
    if (child.type === "object") {
      const nested = outputPaths(child, path, isRequired);
      required.push(...nested.required);
      optional.push(...nested.optional);
    }
  }
  return { required, optional };
}

function additionalInput(
  input: WorkflowBlockAdditionalInputContract,
): CatalogAdditionalInput {
  return {
    path: input.keyPattern,
    keyPattern: input.keyPattern,
    type: schemaType(input.schema),
  };
}

function contractShape(contract: WorkflowBlockContract): CatalogShape {
  const output = outputPaths(contract.output.bindingSchema);
  return {
    requiredInputs: Object.entries(contract.inputs)
      .filter(([, input]) => input.required)
      .map(([path, input]) => ({ path, type: schemaType(input.schema) })),
    optionalInputs: Object.entries(contract.inputs)
      .filter(([, input]) => !input.required)
      .map(([path, input]) => ({ path, type: schemaType(input.schema) })),
    additionalInputs: contract.additionalInputs.map(additionalInput),
    requiredOutputs: output.required,
    optionalOutputs: output.optional,
    statuses: [...contract.output.statusVariants],
  };
}

function normalized(shape: CatalogShape): CatalogShape {
  const byPath = <P extends CatalogPath>(paths: P[]) =>
    [...paths].sort((a, b) => a.path.localeCompare(b.path));
  return {
    requiredInputs: byPath(shape.requiredInputs),
    optionalInputs: byPath(shape.optionalInputs),
    additionalInputs: byPath(shape.additionalInputs),
    requiredOutputs: byPath(shape.requiredOutputs),
    optionalOutputs: byPath(shape.optionalOutputs),
    statuses: [...shape.statuses],
  };
}

function probeContract(
  type: WorkflowBlockType,
  params: Record<string, unknown>,
): WorkflowBlockContract {
  return resolveWorkflowBlockContract(
    type,
    params as WorkflowBlockContract["defaults"],
    registryContext,
  );
}

describe("workflow workspace block catalog", () => {
  it("is a bijection with the worker registry and exactly mirrors every default contract", () => {
    const catalog = loadCatalog();
    const registry = buildWorkflowBlockRegistry(registryContext);
    const catalogTypes = Object.values(catalog).map((block) => block.runtimeType);

    expect(Object.keys(catalog)).toHaveLength(29);
    expect(new Set(catalogTypes).size).toBe(catalogTypes.length);
    expect([...catalogTypes].sort()).toEqual(Object.keys(registry).sort());

    for (const [catalogId, block] of Object.entries(catalog)) {
      const runtime = registry[block.runtimeType];
      expect(runtime, `${catalogId} has an unknown runtimeType`).toBeTruthy();
      expect(block.runtimeContract.params, `${catalogId} params`).toEqual(
        BLOCK_PARAM_KEYS[block.runtimeType],
      );
      expect(normalized(block.runtimeContract), `${catalogId} default contract`).toEqual(
        normalized(contractShape(runtime)),
      );
    }
  });

  it("mirrors scope:any and declared-output contract variants", () => {
    const catalog = loadCatalog();
    const expectedProbes = new Map<WorkflowBlockType, Array<{ name: string; params: Record<string, unknown> }>>([
      ["trigger_pr_created", [{ name: "scope:any", params: { providers: ["github", "gitlab"], scope: "any" } }]],
      ["trigger_pr_checks_failed", [{
        name: "scope:any",
        params: {
          providers: ["github", "gitlab"],
          scope: "any",
          checkNames: [],
          githubAppSlugs: ["github-actions"],
          gitlabPipelineSources: ["merge_request_event"],
        },
      }]],
      ["trigger_pr_review", [{ name: "scope:any", params: { providers: ["github"], on: ["changes_requested"], scope: "any" } }]],
      ["trigger_pr_merged", [{ name: "scope:any", params: { providers: ["github", "gitlab"], scope: "any" } }]],
      ["generic_agent", [{
        name: "declared-output",
        params: {
          provider: "claude",
          model: "claude-test",
          prompt: "",
          workspaceMode: "none",
          outputSchema: declaredGenericSchema,
        },
      }]],
      ["call_llm", [{
        name: "declared-output",
        params: { prompt: "", outputSchema: declaredLlmSchema },
      }]],
    ]);

    for (const block of Object.values(catalog)) {
      const expected = expectedProbes.get(block.runtimeType) ?? [];
      expect(
        (block.runtimeContract.probes ?? []).map(({ name, params }) => ({ name, params })),
        `${block.runtimeType} probe declarations`,
      ).toEqual(expected);
      for (const probe of block.runtimeContract.probes ?? []) {
        const runtime = probeContract(block.runtimeType, probe.params);
        expect(normalized(probe), `${block.runtimeType}:${probe.name}`).toEqual(
          normalized(contractShape(runtime)),
        );
      }
    }
  });
});
