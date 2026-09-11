import {
  type WorkflowDefinition,
  type WorkflowDefinitionV2,
  type WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import {
  containsMalformedPromptDataToken,
  containsMalformedPromptSlotToken,
  isPromptAuthoringBlock,
  parsePromptDataTokens,
  parsePromptSlotTokens,
  promptDataTokenIssue,
  promptFieldForV2Node,
  promptSlotBindingsForV2Node,
  resolveNodePromptAuthoringPure,
  resolvePromptReferences,
  VARIABLE_PARAM_KEYS,
  type PromptReferenceLoader,
  type ResolvedNodePromptAuthoring as SharedResolvedNodePromptAuthoring,
  type ResolveNodePromptAuthoringInput as SharedResolveNodePromptAuthoringInput,
} from "@shared/prompts";
import type { Db } from "../db/client.js";
import { createPromptReferenceLoader } from "../prompt-library/prompt-reference-loader.js";
import { compileEffectivePrompt } from "../engine/helpers/effective-prompt.js";
import {
  analyzeWorkflowV2Bindings,
  analyzeWorkflowV2Catalog,
} from "./available-values.js";
import { isWorkflowSchemaAssignable } from "./bindings.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  inspectJsonSchema202012,
} from "./json-schema.js";
import {
  dashboardOrganizationId,
  validateHarnessProfileReferences,
  validateHarnessProfileReferencesWithLoader,
  type HarnessProfileVersionLoader,
} from "./harness-profile-runtime.js";
import {
  validateWorkflowDefinitionCandidate,
  type WorkflowDefinitionCandidateValidation,
} from "./validation.js";

export type ResolvedNodePromptAuthoring = SharedResolvedNodePromptAuthoring;
export interface ResolveNodePromptAuthoringInput extends Omit<
  SharedResolveNodePromptAuthoringInput,
  "compile" | "areSlotSchemasCompatible"
> {}

export {
  isPromptAuthoringBlock,
  promptFieldForV2Node,
  promptSlotBindingsForV2Node,
};

export function resolveNodePromptAuthoring(
  input: ResolveNodePromptAuthoringInput,
): Promise<ResolvedNodePromptAuthoring> {
  return resolveNodePromptAuthoringPure({
    ...input,
    compile: compileEffectivePrompt,
    areSlotSchemasCompatible: (source, target) => {
      const sourceSchema = inspectJsonSchema202012(source);
      const targetSchema = inspectJsonSchema202012(target);
      return (
        sourceSchema.ok &&
        targetSchema.ok &&
        isWorkflowSchemaAssignable(
          sourceSchema.valueSchema,
          targetSchema.valueSchema,
        )
      );
    },
  });
}

export async function validateWorkflowPromptAuthoringIssues(
  db: Db,
  definition: WorkflowDefinition,
  registryContext?: WorkflowBlockRegistryContext,
  profileLoader?: HarnessProfileVersionLoader,
): Promise<WorkflowDefinitionValidationIssue[]> {
  const context =
    registryContext ??
    (await import("./models.js")).workflowBlockRegistryContextFromEnv();
  const promptIssues =
    await validateWorkflowPromptAuthoringIssuesWithLoader(
      definition,
      context,
      createPromptReferenceLoader(db),
    );
  if (!definition.nodes.some((node) => isPromptAuthoringBlock(node))) {
    return promptIssues;
  }
  const profileIssues = profileLoader
    ? await validateHarnessProfileReferencesWithLoader(
        definition,
        profileLoader,
      )
    : await validateHarnessProfileReferences(db, {
        definition,
        organizationId: await dashboardOrganizationId(
          db,
          (await import("../infra/vcs-config.js")).env.DASHBOARD_ORG_SLUG,
        ),
      });
  return dedupeIssues([...promptIssues, ...profileIssues]);
}

export async function validateWorkflowPromptAuthoringIssuesWithLoader(
  definition: WorkflowDefinitionV2,
  registryContext: WorkflowBlockRegistryContext,
  loadPromptReference: PromptReferenceLoader,
): Promise<WorkflowDefinitionValidationIssue[]> {
  const analysis = analyzeWorkflowV2Bindings(definition, registryContext);
  const catalog = analyzeWorkflowV2Catalog(definition, registryContext);
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of definition.nodes.entries()) {
    const availableValues = analysis.availableValuesByNode[node.id] ?? [];
    if (isPromptAuthoringBlock(node)) {
      const result = await resolveNodePromptAuthoring({
        node,
        nodeIndex,
        availableValues,
        catalogValues: catalog.catalogByNode[node.id] ?? [],
        loadPromptReference,
      });
      issues.push(...result.issues);
      continue;
    }
    if ((VARIABLE_PARAM_KEYS[node.type]?.length ?? 0) > 0) {
      issues.push(
        ...await validateNonAgentPromptAuthoring({
          node,
          nodeIndex,
          availableValues,
          catalogValues: catalog.catalogByNode[node.id] ?? [],
          loadPromptReference,
        }),
      );
    }
  }
  return dedupeIssues(issues);
}

async function validateNonAgentPromptAuthoring(
  input: ResolveNodePromptAuthoringInput,
): Promise<WorkflowDefinitionValidationIssue[]> {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const availableByReference = new Set(
    input.availableValues.map((value) => value.reference),
  );
  const catalogByReference = new Map(
    (input.catalogValues ?? []).map((value) => [value.reference, value]),
  );
  for (const field of VARIABLE_PARAM_KEYS[input.node.type] ?? []) {
    const authored = input.node.configuration[field];
    const values =
      typeof authored === "string"
        ? [{ text: authored, path: field }]
        : Array.isArray(authored)
          ? authored.flatMap((value, index) =>
              typeof value === "string"
                ? [{ text: value, path: `${field}/${index}` }]
                : []
            )
          : [];
    for (const value of values) {
      let resolved: Awaited<ReturnType<typeof resolvePromptReferences>>;
      try {
        resolved = await resolvePromptReferences(
          value.text,
          input.loadPromptReference,
          { requirePinned: true },
        );
      } catch (error) {
        issues.push(nodeIssue(
          input,
          "prompt_reference_invalid",
          value.path,
          error instanceof Error
            ? error.message
            : "Reusable prompt resolution failed.",
        ));
        continue;
      }

      if (
        resolved.slots.length > 0 ||
        containsMalformedPromptSlotToken(resolved.text) ||
        parsePromptSlotTokens(resolved.text).length > 0
      ) {
        issues.push(nodeIssue(
          input,
          input.node.type === "call_llm"
            ? "call_llm_prompt_slots_unsupported"
            : "prompt_slots_unsupported",
          value.path,
          "Prompt slots are supported only by Agent blocks.",
        ));
      }
      if (containsMalformedPromptDataToken(resolved.text)) {
        issues.push(nodeIssue(
          input,
          "prompt_data_malformed",
          value.path,
          "The prompt contains a malformed data token.",
        ));
      }
      const dataTokens = parsePromptDataTokens(resolved.text);
      for (const token of dataTokens) {
        const issue = promptDataTokenIssue(
          token.reference,
          catalogByReference,
          availableByReference,
        );
        if (issue) {
          issues.push(nodeIssue(
            input,
            issue.code,
            value.path,
            issue.message,
          ));
        }
      }
      const residual = removePromptDataTokens(resolved.text, dataTokens);
      if (residual.includes("{{") || residual.includes("}}")) {
        issues.push(nodeIssue(
          input,
          "prompt_placeholder_unresolved",
          value.path,
          "The prompt contains an unresolved placeholder.",
        ));
      }
    }
  }
  return dedupeIssues(issues);
}

function removePromptDataTokens(
  text: string,
  tokens: ReturnType<typeof parsePromptDataTokens>,
): string {
  let output = "";
  let cursor = 0;
  for (const token of tokens) {
    output += text.slice(cursor, token.start);
    cursor = token.end;
  }
  return output + text.slice(cursor);
}

export async function validateWorkflowDefinitionCandidateWithPromptAuthoring(
  db: Db,
  candidate: unknown,
  registryContext?: WorkflowBlockRegistryContext,
  profileLoader?: HarnessProfileVersionLoader,
): Promise<WorkflowDefinitionCandidateValidation> {
  const context =
    registryContext ??
    (await import("./models.js")).workflowBlockRegistryContextFromEnv();
  const base = validateWorkflowDefinitionCandidate(candidate, context);
  if (!base.parsed) return base;
  const promptIssues = await validateWorkflowPromptAuthoringIssues(
    db,
    base.parsed,
    context,
    profileLoader,
  );
  const issues = dedupeIssues([...base.response.issues, ...promptIssues]);
  return {
    parsed: base.parsed,
    response: {
      ...base.response,
      valid: issues.length === 0,
      issues,
    },
  };
}

function nodeIssue(
  input: Pick<ResolveNodePromptAuthoringInput, "node" | "nodeIndex">,
  code: string,
  fieldPath: string,
  message: string,
): WorkflowDefinitionValidationIssue {
  return {
    code,
    severity: "error",
    nodeId: input.node.id,
    path: `/nodes/${input.nodeIndex}/configuration/${fieldPath}`,
    message,
  };
}

function dedupeIssues(
  issues: readonly WorkflowDefinitionValidationIssue[],
): WorkflowDefinitionValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([
      issue.code,
      issue.nodeId,
      issue.path ?? null,
      issue.message,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
