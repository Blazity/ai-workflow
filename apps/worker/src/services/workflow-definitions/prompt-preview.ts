/**
 * The prompt an operator is shown while editing, and what execution would
 * really do with it.
 *
 * A PREVIEW IS A CLAIM ABOUT A FUTURE RUN, so every difference between this
 * compilation and `agent-workflow.ts`'s is a lie with a delay on it. Three of
 * them are answered here rather than left for the operator to discover:
 *
 * 1. The selected profile's switches are applied, exactly as execution reads
 *    them: `includeWorkflowData` off means no Runtime data section here either,
 *    and `includeRepositoryInstructions` off means the repository section is
 *    not merely unavailable, it is not coming. Both are reported in `context`
 *    so the screen can say which prompt this is.
 * 2. Every unresolved source says what becomes of it AT RUN TIME. With
 *    `preview: true` the compiler fills an unresolvable `{{data:...}}` with a
 *    schema example, while execution's resolver throws and fails the
 *    invocation; a screen that calls both "resolved when this block runs"
 *    reassures an operator about a definition that dies on its first run.
 * 3. The sections an editor cannot compose at all (repository instructions,
 *    repository memory) are named in `notPreviewable` instead of being
 *    silently absent. They need a prepared workspace, which is a run.
 *
 * WHICH PROFILE. The one the CANDIDATE names for that block, which is the
 * operator's unsaved selection and the definition's selection at once: they are
 * the same object, and previewing anything else would answer a question nobody
 * asked. `profile` says which one was applied, and is null where the named one
 * could not be resolved, because the built-in prompt under somebody else's
 * profile name is the worst answer available.
 */
import type {
  WorkflowDefinition,
  WorkflowDefinitionV2Node,
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import {
  createWorkflowValueAnalyzer,
  dedupeWorkflowDefinitionIssues,
} from "@shared/workflow-graph";
import type { EffectivePromptUnresolvedSource } from "@shared/prompts";
import { JSON_SCHEMA_SUPPORT } from "../../engine/definition/json-schema-support.js";
import type { Db } from "../../db/types.js";
import { createPromptReferenceLoader } from "../../prompt-library/prompt-reference-loader.js";
import { createConnectedPromptReferenceLoader } from "../../prompt-library/prompt-reference-loader.js";
import {
  builtinHarnessManifestFor,
  exampleValueForJsonSchema,
  effectivePromptProfileSource,
  resolveProfileInstructions,
  type EffectivePromptCompilation,
} from "../../engine/helpers/effective-prompt.js";
import { unresolvedRepositoryInstructionSources } from "../../engine/steps/repository-instructions.js";
import {
  createWorkflowBlockContractResolver,
  type WorkflowBlockRegistryContext,
} from "../../engine/definition/block-contract-resolver.js";
import { BLOCK_PARAMS_SCHEMAS } from "../../engine/definition/block-params-schemas.js";
import {
  isPromptAuthoringBlock,
  resolveNodePromptAuthoring,
} from "./prompt-authoring.js";
import { validateWorkflowDefinitionCandidate } from "../../engine/definition/validation.js";
import { resolveHarnessRuntimesForDefinition } from "../../engine/definition/harness-profile-runtime.js";
import { resolveConnectedVerifiedHarnessProfileVersion } from "../../harness-profiles/resolved-version.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";

/** The two profile switches execution reads before it composes a prompt
 *  (`agent-workflow.ts`), reported so a screen can name the prompt it shows. */
interface WorkflowPromptPreviewContext {
  includeWorkflowData: boolean;
  includeRepositoryInstructions: boolean;
}

/**
 * What becomes of one unresolved source when the block really runs.
 *
 * - `filled_at_run`: execution resolves it. The preview shows an example.
 * - `fails_the_run`: execution cannot resolve it and refuses the invocation.
 *   The preview shows an example too, which is exactly why this field exists.
 * - `not_in_preview`: only a prepared workspace has it. Absent here, and its
 *   absence at run time is not itself a failure.
 */
type PreviewSourceFate = "filled_at_run" | "fails_the_run" | "not_in_preview";

interface WorkflowPromptPreviewSource extends EffectivePromptUnresolvedSource {
  atRun: PreviewSourceFate;
}

/** A section a run composes and an editor cannot, named rather than missing. */
interface WorkflowPromptPreviewGap {
  kind: "repository_instructions" | "repository_memory";
  reason: string;
}

interface WorkflowPromptPreviewProfile {
  profileId: string;
  version: number;
  name: string;
  /**
   * - `selected`: the profile this block names, resolved (a published version,
   *   or a built-in one named outright).
   * - `builtin`: the block names none, so this is the provider default a run
   *   would use.
   *
   * There is no third value: a named profile this deployment cannot resolve
   * leaves `profile` null, because showing the built-in prompt under the name
   * of a profile that did not load is the lie this field exists to prevent.
   * A run refuses to start in that case, which the `profile` entry in
   * `unresolvedSources` says as `fails_the_run`.
   */
  applied: "selected" | "builtin";
}

interface WorkflowPromptPreview {
  blockId: string;
  prompt: string;
  hash: string;
  sections: EffectivePromptCompilation["sections"];
  provenance: EffectivePromptCompilation["provenance"];
  unresolvedSources: WorkflowPromptPreviewSource[];
  context: WorkflowPromptPreviewContext;
  profile: WorkflowPromptPreviewProfile | null;
  notPreviewable: WorkflowPromptPreviewGap[];
  issues: WorkflowDefinitionValidationIssue[];
}

export type WorkflowPromptPreviewResult =
  | { ok: true; preview: WorkflowPromptPreview }
  | { ok: false; statusCode: 400 | 422; message: string; issues: WorkflowDefinitionValidationIssue[] };

/** Where a runtime for the block's profile comes from. The two exported
 *  previews differ in this and in how they load prompt references, and in
 *  nothing else: the rules below have to be the same on both. */
type ResolveRuntime = (
  definition: WorkflowDefinition,
  node: WorkflowDefinitionV2Node,
) => Promise<ResolvedHarnessRuntime | null>;

/**
 * Compiles one block from the exact unsaved candidate supplied by the editor.
 * It intentionally does not read the stored draft; the definition id route is
 * only the authenticated organization-scoped parent resource.
 */
export async function previewWorkflowPromptCandidate(
  db: Db,
  candidate: unknown,
  blockId: string,
  registryContext: WorkflowBlockRegistryContext,
  options: { organizationId?: string } = {},
): Promise<WorkflowPromptPreviewResult> {
  return compilePreview({
    candidate,
    blockId,
    registryContext,
    loadPromptReference: createPromptReferenceLoader(db),
    resolveRuntime: async (definition, node) => {
      if (!options.organizationId) return null;
      const runtimes = await resolveHarnessRuntimesForDefinition(db, {
        definition,
        organizationId: options.organizationId,
        defaultProvider: registryContext.defaultAgent.provider,
      });
      return runtimes[node.id] ?? null;
    },
  });
}

/** Process-bound preview assembled from named prompt/profile repository reads. */
export async function previewConnectedWorkflowPromptCandidate(input: {
  candidate: unknown;
  blockId: string;
  organizationId?: string;
}): Promise<WorkflowPromptPreviewResult> {
  const registryContext = (
    await import("../../engine/definition/block-contract-environment.js")
  ).workflowBlockRegistryContext();
  return compilePreview({
    candidate: input.candidate,
    blockId: input.blockId,
    registryContext,
    loadPromptReference: createConnectedPromptReferenceLoader(),
    resolveRuntime: async (_definition, node) => {
      const reference = node.configuration.harnessProfile;
      if (!input.organizationId) return null;
      if (
        !reference ||
        typeof reference !== "object" ||
        !("profileId" in reference) ||
        !("version" in reference)
      ) {
        return null;
      }
      const profile = await resolveConnectedVerifiedHarnessProfileVersion({
        organizationId: input.organizationId,
        profileId: String(reference.profileId),
        version: Number(reference.version),
      });
      if (!profile) return null;
      const { resolveHarnessRuntime } = await import("../../sandbox/harness-runtime.js");
      return resolveHarnessRuntime({
        nodeId: node.id,
        nodeType: node.type,
        workspaceMode: node.configuration.workspaceMode,
        resolved: profile,
        legacyDynamicSkills: false,
      });
    },
  });
}

async function compilePreview(input: {
  candidate: unknown;
  blockId: string;
  registryContext: WorkflowBlockRegistryContext;
  loadPromptReference: Parameters<typeof resolveNodePromptAuthoring>[0]["loadPromptReference"];
  resolveRuntime: ResolveRuntime;
}): Promise<WorkflowPromptPreviewResult> {
  const { registryContext, blockId } = input;
  const resolveContract = createWorkflowBlockContractResolver(registryContext);
  const validated = validateWorkflowDefinitionCandidate(
    input.candidate,
    resolveContract,
    BLOCK_PARAMS_SCHEMAS,
    registryContext.vcsProviders,
    createWorkflowValueAnalyzer(resolveContract, JSON_SCHEMA_SUPPORT),
  );
  if (!validated.parsed) {
    return {
      ok: false,
      statusCode: 422,
      message: "Prompt preview requires a structurally valid v2 definition.",
      issues: validated.response.issues,
    };
  }
  const nodeIndex = validated.parsed.nodes.findIndex((node) => node.id === blockId);
  const node = validated.parsed.nodes[nodeIndex];
  if (!node) {
    return { ok: false, statusCode: 400, message: `Unknown block "${blockId}".`, issues: [] };
  }
  if (!isPromptAuthoringBlock(node)) {
    return {
      ok: false,
      statusCode: 400,
      message: `Block "${blockId}" does not have an effective agent prompt.`,
      issues: [],
    };
  }

  const availableValues = validated.response.availableValuesByNode[node.id] ?? [];
  const applied = await appliedProfile(node, validated.parsed, input.registryContext, input.resolveRuntime);
  const resolved = await resolveNodePromptAuthoring({
    node,
    nodeIndex,
    availableValues,
    loadPromptReference: input.loadPromptReference,
    profileSource: applied.source,
    // Off means the section is not coming, which is a different thing from a
    // section this screen cannot show: listing the files would put an
    // "unavailable here" note under a prompt that will never carry them.
    unresolvedRepositorySources: applied.context.includeRepositoryInstructions
      ? unresolvedRepositoryInstructionSources()
      : [],
    // Exactly execution's own line (`agent-workflow.ts`): the section is empty
    // when the profile says this agent does not get workflow data.
    runtimeData: applied.context.includeWorkflowData
      ? renderPreviewRuntimeData(availableValues)
      : "",
  });
  const validationIssues = validated.response.issues.filter(
    (issue) => issue.nodeId === null || issue.nodeId === blockId,
  );
  const guaranteed = new Set(availableValues.map((value) => value.reference));
  return {
    ok: true,
    preview: {
      blockId,
      prompt: resolved.compilation.prompt,
      hash: resolved.compilation.hash,
      sections: resolved.compilation.sections,
      provenance: resolved.compilation.provenance,
      unresolvedSources: resolved.compilation.unresolvedSources.map((source) =>
        describeSource(source, guaranteed),
      ),
      context: applied.context,
      profile: applied.profile,
      notPreviewable: notPreviewable(applied.context),
      issues: dedupeWorkflowDefinitionIssues([...validationIssues, ...resolved.issues]),
    },
  };
}

/**
 * The profile this block would run with, its switches, and which case it is.
 *
 * A profile the definition names and this deployment cannot resolve is NOT an
 * error here: validation reports it, and the preview still compiles so an
 * operator can see the rest of their edit. It simply has no profile to show,
 * and says so, rather than presenting the built-in prompt as theirs.
 *
 * With no profile at all the switches below are the pinned defaults. They
 * decide nothing in that case, because a run of this block would refuse to
 * start before it composed anything.
 */
async function appliedProfile(
  node: WorkflowDefinitionV2Node,
  definition: WorkflowDefinition,
  registryContext: WorkflowBlockRegistryContext,
  resolveRuntime: ResolveRuntime,
): Promise<{
  source: Awaited<ReturnType<typeof resolveProfileInstructions>>;
  context: WorkflowPromptPreviewContext;
  profile: WorkflowPromptPreviewProfile | null;
}> {
  const runtime = await resolveRuntime(definition, node).catch(() => null);
  if (runtime) {
    return {
      source: effectivePromptProfileSource(runtime),
      context: {
        includeWorkflowData: runtime.manifest.context.includeWorkflowData,
        includeRepositoryInstructions: runtime.manifest.context.includeRepositoryInstructions,
      },
      profile: {
        profileId: runtime.manifest.profileId,
        version: runtime.manifest.version,
        name: runtime.manifest.displayName,
        applied: node.configuration.harnessProfile === undefined ? "builtin" : "selected",
      },
    };
  }
  const defaultProvider = registryContext.defaultAgent.provider;
  const builtin = builtinHarnessManifestFor({ node, defaultProvider });
  const source = await resolveProfileInstructions({ node, defaultProvider });
  return {
    source,
    // The built-in manifest's own switches, never a hard-coded pair: a built-in
    // profile that turns one off has to preview that way too.
    context: {
      includeWorkflowData: builtin?.context.includeWorkflowData ?? true,
      includeRepositoryInstructions: builtin?.context.includeRepositoryInstructions ?? true,
    },
    profile: builtin
      ? {
          profileId: builtin.profileId,
          version: builtin.version,
          name: builtin.displayName,
          applied: node.configuration.harnessProfile === undefined ? "builtin" : "selected",
        }
      : null,
  };
}

/**
 * What execution does with a source the preview could not resolve, and the
 * sentence that goes with it.
 *
 * The test is the one the static analyzer already answers: a reference that is
 * not GUARANTEED for this block is the one execution's resolver throws on
 * (`prompt_data_unavailable`, `prompt_slot_unavailable`), and a compilation
 * with issues fails the invocation before the agent is called.
 *
 * The compiler's own message is replaced for the fatal ones. It says the value
 * "is resolved when this block runs", which is true of the ordinary case and a
 * flat contradiction of this one, and a reader that shows the message without
 * the flag would go on reassuring people.
 */
function describeSource(
  source: EffectivePromptUnresolvedSource,
  guaranteed: ReadonlySet<string>,
): WorkflowPromptPreviewSource {
  switch (source.kind) {
    case "data":
    case "slot": {
      if (guaranteed.has(source.reference)) return { ...source, atRun: "filled_at_run" };
      return {
        ...source,
        atRun: "fails_the_run",
        message: `"${source.reference}" is not guaranteed when this block runs, so a run stops here instead of calling the agent. The value in the prompt above is an example this screen made up.`,
      };
    }
    // No instructions at all: execution refuses the block rather than sending
    // a prompt without its profile.
    case "profile":
      return {
        ...source,
        atRun: "fails_the_run",
        message:
          "The Harness Profile for this block could not be resolved, so a run would refuse to start. Select a published profile version.",
      };
    case "repository":
      return { ...source, atRun: "not_in_preview" };
  }
}

/** The sections a run composes that no editor can. Named, because "absent" and
 *  "absent here" are different things to an operator reading a prompt. */
function notPreviewable(context: WorkflowPromptPreviewContext): WorkflowPromptPreviewGap[] {
  const gaps: WorkflowPromptPreviewGap[] = [
    {
      kind: "repository_memory",
      reason:
        "What earlier runs learned about a repository is added from the prepared workspace, so it can only be read on a run. It is absent here whether or not a run would carry it.",
    },
  ];
  if (!context.includeRepositoryInstructions) return gaps;
  return [
    {
      kind: "repository_instructions",
      reason:
        "AGENTS.md, CLAUDE.md and repository rules are read from the checkout, so a run carries them and this screen cannot.",
    },
    ...gaps,
  ];
}

function renderPreviewRuntimeData(
  values: Parameters<typeof resolveNodePromptAuthoring>[0]["availableValues"],
): string {
  if (values.length === 0) {
    return "No runtime values are guaranteed for this block.";
  }
  return JSON.stringify(
    Object.fromEntries(
      values.map((value) => [value.reference, exampleValueForJsonSchema(value.schema)]),
    ),
    null,
    2,
  );
}
