/**
 * One request, one walk.
 *
 * Draft validation, the editor's data catalog and prompt authoring all need to
 * know which values each block may read. Each used to work that out for itself,
 * so one validation request walked the same graph, resolved the same contracts
 * and built the same catalog several times over. The request now carries the
 * analysis, and this is the case that says so: the counting analyser below is
 * the request's, and it may compute at most once for one definition instance.
 */
import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import type { WorkflowBlockRegistryContext } from "../engine/definition/block-contract-resolver.js";
import { BLOCK_PARAMS_SCHEMAS } from "../engine/definition/block-params-schemas.js";
import { testBlockContractResolver } from "../test-support/block-contracts.js";
import {
  analyzeWorkflowValues,
  analyzeWorkflowV2Catalog,
  type WorkflowValueAnalyzer,
} from "./available-values.js";
import { validateWorkflowPromptAuthoringIssuesWithLoader } from "./prompt-authoring.js";
import { validateWorkflowDefinitionCandidate } from "./validation.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github"],
  vcsBotIdentities: ["github"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

const resolveContract = testBlockContractResolver(registryContext);

const node = (
  id: string,
  type: WorkflowBlockType,
): WorkflowDefinitionV2Node => ({
  id,
  type,
  x: 0,
  y: 0,
  configuration: {},
  inputs: {},
  additionalInputs: [],
});

const candidateDefinition = (): WorkflowDefinitionV2 => ({
  schemaVersion: 2,
  nodes: [
    node("entry", "trigger_ticket_ai"),
    {
      ...node("agent", "generic_agent"),
      configuration: { prompt: "Summarise the ticket." },
    },
  ],
  edges: [{ id: "edge-1", from: "entry", to: "agent" }],
});

/** The request's analyser, counting every pass it performs. */
function countingAnalyzer(): {
  analyzeValues: WorkflowValueAnalyzer;
  walks: () => number;
} {
  let walks = 0;
  return {
    analyzeValues: (definition) => {
      walks += 1;
      return analyzeWorkflowValues(definition, resolveContract);
    },
    walks: () => walks,
  };
}

describe("available-values analysis pass", () => {
  it("runs once for a request that validates a draft, reads its available values and checks prompt authoring", async () => {
    const { analyzeValues, walks } = countingAnalyzer();

    const validated = validateWorkflowDefinitionCandidate(
      candidateDefinition(),
      resolveContract,
      BLOCK_PARAMS_SCHEMAS,
      registryContext.vcsProviders,
      analyzeValues,
    );
    expect(validated.parsed).not.toBeNull();
    const parsed = validated.parsed!;
    const analysis = validated.analysis!;

    const catalog = analyzeWorkflowV2Catalog(analysis);
    const promptIssues = await validateWorkflowPromptAuthoringIssuesWithLoader(
      parsed,
      analysis,
      async () => {
        throw new Error("this fixture references no reusable prompt");
      },
    );

    expect(Object.keys(catalog.catalogByNode)).toEqual(["entry", "agent"]);
    expect(promptIssues).toEqual([]);
    expect(walks()).toBe(1);
  });

  it("runs again for a graph edited between two validations", () => {
    const { analyzeValues, walks } = countingAnalyzer();
    const definition = candidateDefinition();

    const before = analyzeValues(definition).availableValuesByNode["agent"];
    definition.nodes[1]!.id = "renamed";
    const after = analyzeValues(definition).availableValuesByNode["agent"];

    expect(before).toBeDefined();
    expect(after).toBeUndefined();
    expect(walks()).toBe(2);
  });
});
