import { isDeepStrictEqual } from "node:util";
import {
  BLOCK_TYPE_SPECS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  parsePromptReferenceTokens,
  type WorkflowDefinitionV1,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import { getCurrentSystemHarnessProfileReference } from "../harness-profiles/store.js";
import {
  createPromptReferenceLoader,
  getPrompt,
} from "../prompt-library/store.js";
import { VARIABLE_PARAM_KEYS } from "../workflows/prompt-vars.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import { workflowBlockRegistryContextFromEnv } from "./models.js";
import {
  getRawWorkflowDefinitionVersion,
  getWorkflowDefinitionRawState,
  WorkflowDefinitionStoreError,
} from "./store.js";
import { validateWorkflowDefinitionCandidateWithPromptAuthoring } from "./prompt-authoring.js";
import { upgradeStoredWorkflowDefinition } from "./schema.js";
import { prepareWorkflowV1PromptsForMigration } from "./v2-migration-prompts.js";
import {
  convertWorkflowDefinitionV1ToV2,
  workflowV2PromptResolutionKey,
  type WorkflowV2MigrationDiagnostic,
  type WorkflowV2MigrationResult,
  type WorkflowV2PromptResolution,
} from "./v2-converter.js";

export async function previewWorkflowDefinitionV2Migration(
  db: Db,
  input: {
    definitionId: number;
    sourceVersion: number;
    expectedDraftRevision: number;
    registryContext?: WorkflowBlockRegistryContext;
  },
): Promise<WorkflowV2MigrationResult> {
  const definitionRow = await getWorkflowDefinitionRawState(
    db,
    input.definitionId,
  );
  if (!definitionRow) {
    throw new WorkflowDefinitionStoreError(404, "Unknown definition");
  }
  if (definitionRow.archivedAt) {
    throw new WorkflowDefinitionStoreError(409, "Definition is archived");
  }
  if (definitionRow.draftRevision !== input.expectedDraftRevision) {
    throw new WorkflowDefinitionStoreError(
      409,
      "Draft changed; preview the migration again",
    );
  }

  const source = await getRawWorkflowDefinitionVersion(
    db,
    input.definitionId,
    input.sourceVersion,
  );
  if (!source) {
    throw new WorkflowDefinitionStoreError(404, "Unknown source version");
  }
  if (rawSchemaVersion(source.definition) === 2) {
    throw new WorkflowDefinitionStoreError(409, "Source version is already v2");
  }

  const preflight = inspectRawWorkflowDefinitionV1Migration(source.definition);
  const analysisSource = rawWorkflowDefinitionV1AnalysisCopy(
    source.definition,
  );

  let upgraded: WorkflowDefinitionV1;
  try {
    // Raw-only fields are already preserved as authoritative blockers above.
    // Remove them from this diagnostic copy only, so strict historical parsers
    // can still expose independent converter blockers. This copy is never
    // returned or persisted, and any raw blocker forces a null conversion.
    const definition = upgradeStoredWorkflowDefinition(analysisSource);
    if (definition.schemaVersion !== 1) {
      throw new Error("Expected a v1 workflow definition");
    }
    upgraded = restoreRawPromptProvenance(source.definition, definition);
  } catch (error) {
    return blockedMigrationResult(input, {
      ...preflight,
      blockers: [
        ...preflight.blockers,
        {
          code: "migration.source.invalid_legacy_shape",
          message:
            "The stored source does not match a supported historical v1 workflow shape.",
          nodeId: null,
          ...legacyShapeErrorPath(error),
        },
      ],
    });
  }
  if (!isDeepStrictEqual(analysisSource, upgraded)) {
    preflight.conversions.push({
      code: "migration.source.compatibility_normalized",
      message:
        "Applied the existing deterministic v1 compatibility normalization before conversion.",
      nodeId: null,
      path: "/",
    });
  }

  const registryContext =
    input.registryContext ?? workflowBlockRegistryContextFromEnv();
  const preparedPrompts = await prepareWorkflowV1PromptsForMigration(
    db,
    upgraded,
  );
  const converted = await convertWorkflowDefinitionV1ToV2WithPromptResolution(db, {
    sourceDefinitionId: input.definitionId,
    sourceVersion: input.sourceVersion,
    definition: preparedPrompts.definition,
    registryContext,
  });
  const rawSourceBlocked = preflight.blockers.length > 0;
  const preliminaryBlockers = dedupeMigrationDiagnostics([
    ...preflight.blockers,
    ...preparedPrompts.blockers,
    ...converted.blockers,
  ]);
  const targetBlockers: WorkflowV2MigrationDiagnostic[] = [];
  if (preliminaryBlockers.length === 0 && converted.definition) {
    const validation =
      await validateWorkflowDefinitionCandidateWithPromptAuthoring(
        db,
        converted.definition,
        registryContext,
      );
    for (const issue of validation.response.issues) {
      targetBlockers.push({
        code: `migration.target.${issue.code}`,
        message: `Converted v2 workflow is not deployable: ${issue.message}`,
        nodeId: issue.nodeId,
        ...(issue.path === undefined ? {} : { path: issue.path }),
      });
    }
  }
  const blockers = dedupeMigrationDiagnostics([
    ...preliminaryBlockers,
    ...targetBlockers,
  ]);
  const applicable =
    !rawSourceBlocked &&
    blockers.length === 0 &&
    converted.definition !== null;
  return {
    ...converted,
    // The compatibility copy is used only to discover additional actionable
    // blockers. Unknown raw fields remain authoritative and can never be
    // normalized away into an applicable conversion.
    conversionHash: applicable ? converted.conversionHash : null,
    definition: applicable ? converted.definition : null,
    conversions: dedupeMigrationDiagnostics([
      ...preflight.conversions,
      ...preparedPrompts.conversions,
      ...converted.conversions,
    ]),
    warnings: [...preflight.warnings, ...converted.warnings],
    blockers,
  };
}

export async function convertWorkflowDefinitionV1ToV2WithPromptResolution(
  db: Db,
  input: {
    sourceDefinitionId: number;
    sourceVersion: number;
    definition: WorkflowDefinitionV1;
    registryContext?: WorkflowBlockRegistryContext;
  },
): Promise<WorkflowV2MigrationResult> {
  const [claudeReference, codexReference] = await Promise.all([
    getCurrentSystemHarnessProfileReference(db, "claude"),
    getCurrentSystemHarnessProfileReference(db, "codex"),
  ]);
  return convertWorkflowDefinitionV1ToV2({
    ...input,
    registryContext:
      input.registryContext ?? workflowBlockRegistryContextFromEnv(),
    promptResolutions: await resolvePromptVersions(db, input.definition),
    harnessProfiles: {
      claude: {
        reference: claudeReference,
        modelId:
          BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-claude"].model.id,
      },
      codex: {
        reference: codexReference,
        modelId:
          BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-codex"].model.id,
      },
    },
  });
}

async function resolvePromptVersions(
  db: Db,
  definition: WorkflowDefinitionV1,
): Promise<Map<string, WorkflowV2PromptResolution>> {
  const references = new Map<
    string,
    ReturnType<typeof parsePromptReferenceTokens>[number]
  >();
  for (const node of definition.nodes) {
    const promptKeys = new Set(VARIABLE_PARAM_KEYS[node.type] ?? []);
    for (const [paramName, value] of Object.entries(node.params)) {
      if (!promptKeys.has(paramName)) continue;
      const values =
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value
            : [];
      for (const text of values) {
        for (const reference of parsePromptReferenceTokens(text)) {
          references.set(
            workflowV2PromptResolutionKey(reference),
            reference,
          );
        }
      }
    }
  }

  const load = createPromptReferenceLoader(db);
  const resolutions = new Map<string, WorkflowV2PromptResolution>();
  for (const [key, reference] of references) {
    try {
      const loaded = await load(
        reference.slug === undefined
          ? { legacyPromptId: reference.legacyPromptId }
          : { slug: reference.slug },
        reference.version,
      );
      const prompt = await getPrompt(db, loaded.promptId);
      if (!prompt) continue;
      resolutions.set(key, {
        slug: prompt.slug,
        requestedVersion: reference.version,
        resolvedVersion: loaded.resolvedVersion,
      });
    } catch {
      // The pure converter turns a missing resolution into a path-specific
      // blocker. Preview must report every bad token instead of stopping at the
      // first prompt-library lookup failure.
    }
  }
  return resolutions;
}

interface RawMigrationPreflight {
  conversions: WorkflowV2MigrationDiagnostic[];
  warnings: WorkflowV2MigrationDiagnostic[];
  blockers: WorkflowV2MigrationDiagnostic[];
}

const RAW_DEFINITION_FIELDS = new Set([
  "schemaVersion",
  "budgets",
  "nodes",
  "edges",
]);
const RAW_NODE_FIELDS = new Set([
  "id",
  "type",
  "name",
  "x",
  "y",
  "params",
  "promptRefs",
  "inputs",
]);
const RAW_EDGE_FIELDS = new Set(["from", "to", "fromPort"]);

function rawWorkflowDefinitionV1AnalysisCopy(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const copy = pickRawFields(raw, RAW_DEFINITION_FIELDS);
  if (Array.isArray(raw.nodes)) {
    copy.nodes = raw.nodes.map((node) =>
      isRecord(node) ? pickRawFields(node, RAW_NODE_FIELDS) : node,
    );
  }
  if (Array.isArray(raw.edges)) {
    copy.edges = raw.edges.map((edge) =>
      isRecord(edge) ? pickRawFields(edge, RAW_EDGE_FIELDS) : edge,
    );
  }
  return copy;
}

function pickRawFields(
  raw: Record<string, unknown>,
  fields: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([field]) => fields.has(field)),
  );
}

export function inspectRawWorkflowDefinitionV1Migration(
  raw: unknown,
): RawMigrationPreflight {
  const result: RawMigrationPreflight = {
    conversions: [],
    warnings: [],
    blockers: [],
  };
  if (!isRecord(raw)) {
    result.blockers.push({
      code: "migration.source.invalid_legacy_shape",
      message: "The stored source is not a workflow definition object.",
      nodeId: null,
      path: "/",
    });
    return result;
  }

  for (const field of Object.keys(raw)) {
    if (RAW_DEFINITION_FIELDS.has(field)) continue;
    result.blockers.push({
      code: "migration.source.unknown_top_level_field",
      message: `The stored source contains unsupported top-level field "${field}".`,
      nodeId: null,
      path: `/${escapePointerSegment(field)}`,
    });
  }
  if (raw.schemaVersion !== 1) {
    result.blockers.push({
      code: "migration.source.invalid_schema_version",
      message: "The stored source is not a v1 workflow definition.",
      nodeId: null,
      path: "/schemaVersion",
    });
  }

  if (!Array.isArray(raw.nodes)) {
    result.blockers.push({
      code: "migration.source.invalid_legacy_shape",
      message: "The stored source has no valid block list.",
      nodeId: null,
      path: "/nodes",
    });
  } else {
    for (const [nodeIndex, node] of raw.nodes.entries()) {
      const nodePath = `/nodes/${nodeIndex}`;
      if (!isRecord(node)) {
        result.blockers.push({
          code: "migration.source.invalid_legacy_shape",
          message: `Stored block ${nodeIndex + 1} is not an object.`,
          nodeId: null,
          path: nodePath,
        });
        continue;
      }
      const nodeId = typeof node.id === "string" ? node.id : null;
      for (const field of Object.keys(node)) {
        if (RAW_NODE_FIELDS.has(field)) continue;
        result.blockers.push({
          code: "migration.source.unknown_node_field",
          message: `Stored block "${nodeId ?? nodeIndex + 1}" contains unsupported field "${field}".`,
          nodeId,
          path: `${nodePath}/${escapePointerSegment(field)}`,
        });
      }
      if (node.type === "arthur_trace") {
        result.blockers.push({
          code: "migration.source.retired_arthur_trace",
          message: `Stored block "${nodeId ?? nodeIndex + 1}" uses retired Arthur Trace behavior and must be removed explicitly before v2 conversion.`,
          nodeId,
          path: `${nodePath}/type`,
        });
      } else if (
        typeof node.type !== "string" ||
        node.type === "transform" ||
        !Object.prototype.hasOwnProperty.call(BLOCK_TYPE_SPECS, node.type)
      ) {
        result.blockers.push({
          code: "migration.source.unknown_block_type",
          message: `Stored block "${nodeId ?? nodeIndex + 1}" has an unsupported block type.`,
          nodeId,
          path: `${nodePath}/type`,
        });
      }
      if (
        node.promptRefs !== undefined &&
        !isValidRawPromptProvenance(node.promptRefs)
      ) {
        result.blockers.push({
          code: "migration.source.invalid_prompt_provenance",
          message: `Stored block "${nodeId ?? nodeIndex + 1}" has malformed prompt provenance metadata.`,
          nodeId,
          path: `${nodePath}/promptRefs`,
        });
      }
    }
  }

  if (!Array.isArray(raw.edges)) {
    result.blockers.push({
      code: "migration.source.invalid_legacy_shape",
      message: "The stored source has no valid connection list.",
      nodeId: null,
      path: "/edges",
    });
  } else {
    for (const [edgeIndex, edge] of raw.edges.entries()) {
      const edgePath = `/edges/${edgeIndex}`;
      if (!isRecord(edge)) {
        result.blockers.push({
          code: "migration.source.invalid_legacy_shape",
          message: `Stored connection ${edgeIndex + 1} is not an object.`,
          nodeId: null,
          path: edgePath,
        });
        continue;
      }
      for (const field of Object.keys(edge)) {
        if (RAW_EDGE_FIELDS.has(field)) continue;
        result.blockers.push({
          code: "migration.source.unknown_edge_field",
          message: `Stored connection ${edgeIndex + 1} contains unsupported field "${field}".`,
          nodeId: typeof edge.from === "string" ? edge.from : null,
          path: `${edgePath}/${escapePointerSegment(field)}`,
        });
      }
    }
  }
  return result;
}

function blockedMigrationResult(
  input: {
    definitionId: number;
    sourceVersion: number;
  },
  preflight: RawMigrationPreflight,
): WorkflowV2MigrationResult {
  return {
    sourceDefinitionId: input.definitionId,
    sourceVersion: input.sourceVersion,
    targetSchemaVersion: 2,
    conversionHash: null,
    definition: null,
    conversions: preflight.conversions,
    warnings: preflight.warnings,
    blockers: preflight.blockers,
  };
}

function dedupeMigrationDiagnostics(
  diagnostics: WorkflowV2MigrationDiagnostic[],
): WorkflowV2MigrationDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([
      diagnostic.code,
      diagnostic.nodeId,
      diagnostic.path ?? null,
      diagnostic.message,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function restoreRawPromptProvenance(
  raw: unknown,
  upgraded: WorkflowDefinitionV1,
): WorkflowDefinitionV1 {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return upgraded;
  const promptRefsByNode = new Map<string, WorkflowDefinitionV1["nodes"][number]["promptRefs"]>();
  for (const node of raw.nodes) {
    if (
      isRecord(node) &&
      typeof node.id === "string" &&
      node.promptRefs !== undefined &&
      isValidRawPromptProvenance(node.promptRefs)
    ) {
      promptRefsByNode.set(
        node.id,
        node.promptRefs as WorkflowDefinitionV1["nodes"][number]["promptRefs"],
      );
    }
  }
  return {
    ...upgraded,
    nodes: upgraded.nodes.map((node) => {
      const promptRefs = promptRefsByNode.get(node.id);
      return promptRefs === undefined ? node : { ...node, promptRefs };
    }),
  };
}

function isValidRawPromptProvenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.promptId === "number" &&
      Number.isInteger(entry.promptId) &&
      entry.promptId > 0 &&
      typeof entry.version === "number" &&
      Number.isInteger(entry.version) &&
      entry.version > 0,
  );
}

function rawSchemaVersion(raw: unknown): unknown {
  return isRecord(raw) ? raw.schemaVersion : undefined;
}

function legacyShapeErrorPath(error: unknown): { path?: string } {
  if (!isRecord(error) || !Array.isArray(error.issues)) return {};
  const first = error.issues[0];
  if (!isRecord(first) || !Array.isArray(first.path)) return {};
  return {
    path:
      first.path.length === 0
        ? "/"
        : `/${first.path.map((part) => escapePointerSegment(String(part))).join("/")}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
