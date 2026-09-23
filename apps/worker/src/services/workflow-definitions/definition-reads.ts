/**
 * What the editor is shown about the definitions that exist.
 *
 * The store below takes a connection and answers about rows; this binds the
 * connection and decides what a dashboard read means, including the two shapes
 * that are not simply "the rows": the editor's opening payload, which needs the
 * seed a new definition would start from, and the detail read, which treats an
 * archived definition as absent.
 */
import { defaultWorkflowDefinitionV2 } from "../../engine/definition/default.js";
import {
  RETIRED_SCHEMA_MESSAGE,
  type SettingsSnapshot,
  type WorkflowDefinition,
} from "@shared/contracts";
import {
  buildWorkflowEditorOptions,
  fetchAvailableModels,
  fetchTicketStatuses,
} from "../../engine/definition/models.js";
import { workflowDefinitionTemplates } from "../../engine/definition/templates.js";
import {
  type WorkflowDefinitionRow,
  type WorkflowDefinitionVersionRow,
} from "../../db/repositories/definitions.js";
import {
  getConnectedWorkflowDefinition,
  listConnectedWorkflowDefinitions,
} from "../../db/repositories/definitions/connected.js";
import { currentSystemHarnessProfileReference } from "../harness/index.js";
import { defaultBuiltinHarnessProfile } from "@shared/harness";
import {
  readConnectedDeployedWorkflowDefinitionVersion,
  readConnectedWorkflowDefinitionVersionRows,
} from "../../engine/stored-definition-reads.js";
import { readConnectedWorkflowDefinitionDraft } from "../../engine/definition-draft-read.js";
import { blockContractsFor } from "./block-contracts.js";
import type { DeploymentIntegrations } from "../../engine/definition/integration-availability.js";

export interface WorkflowDefinitionsOverview {
  definitions: WorkflowDefinitionRow[];
  templates: ReturnType<typeof workflowDefinitionTemplates>;
  defaultDefinition: ReturnType<typeof defaultWorkflowDefinitionV2>;
  options: ReturnType<typeof buildWorkflowEditorOptions>;
}

export interface WorkflowDefinitionDetail {
  row: WorkflowDefinitionRow;
  draft: Awaited<ReturnType<typeof readConnectedWorkflowDefinitionDraft>>;
  deployedRow: WorkflowDefinitionVersionRow | null;
  versionRows: WorkflowDefinitionVersionRow[];
}

export interface EnabledDeployedWorkflowDefinition {
  id: number;
  name: string;
  /** The deployed version, whose graph `definition` is. */
  version: number;
  definition: WorkflowDefinition;
}

/**
 * Enabled definitions and the exact immutable graph selected for new runs.
 * Drafts, archived rows, disabled definitions and retired deployments do not
 * belong in a change-impact warning about work this deployment can start.
 */
export async function readEnabledDeployedWorkflowDefinitions(): Promise<
  EnabledDeployedWorkflowDefinition[]
> {
  const rows = (await listConnectedWorkflowDefinitions()).filter(
    (row) => row.enabled && row.deployedVersion !== null && row.deployedSchema === "v2",
  );
  const deployed = await Promise.all(
    rows.map((row) => readConnectedDeployedWorkflowDefinitionVersion(row.id)),
  );
  return rows.flatMap((row, index) => {
    const version = deployed[index];
    return version?.schema === "v2"
      ? [{ id: row.id, name: row.name, version: row.deployedVersion!, definition: version.definition }]
      : [];
  });
}

/**
 * Everything the editor needs before it can show anything: the definitions, the
 * choices a block may offer, and the two seeds (templates and the default) a
 * new definition can start from. Those seeds depend on the deployment, since
 * which agent runs and which optional phases exist decide what a starting graph
 * contains, so they are shaped here rather than by the caller.
 */
export async function readWorkflowDefinitionsOverview(
  settings: SettingsSnapshot,
  /** Taken, not read: the palette carries every integration's blocks and says
   *  which are usable, and the route names where that state came from. */
  integrations: DeploymentIntegrations,
): Promise<WorkflowDefinitionsOverview> {
  const agentKind = defaultBuiltinHarnessProfile().harness.provider;
  const storedDefinitions = await listConnectedWorkflowDefinitions();
  const [models, ticketStatuses, profileReference, blockContracts, deployments] =
    await Promise.all([
    fetchAvailableModels(),
    fetchTicketStatuses(),
    currentSystemHarnessProfileReference(),
    blockContractsFor(undefined, integrations),
    Promise.all(storedDefinitions.map((row) =>
      row.deployedVersion === null
        ? null
        : readConnectedDeployedWorkflowDefinitionVersion(row.id))),
  ]);
  const definitions = storedDefinitions.map((row, index) =>
    deployments[index]?.schema === "legacy-v1"
      ? Object.assign({}, row, {
          deployedSchema: "legacy-v1" as const,
          retiredMessage: RETIRED_SCHEMA_MESSAGE,
          triggerTypes: [],
        })
      : row);
  const seedOptions = {
    includeReview: false,
    includeLeakReview: false,
    provider: agentKind,
    profileReference,
  };
  return {
    definitions,
    templates: workflowDefinitionTemplates(seedOptions),
    defaultDefinition: defaultWorkflowDefinitionV2(seedOptions),
    options: buildWorkflowEditorOptions(
      settings,
      models,
      ticketStatuses,
      blockContracts.blockRegistry(),
    ),
  };
}

/** One definition with its draft, deployed head and version list, or null when
 *  the id names nothing or names something archived. */
export async function readWorkflowDefinitionDetail(
  definitionId: number,
): Promise<WorkflowDefinitionDetail | null> {
  const row = await getConnectedWorkflowDefinition(definitionId);
  if (!row || row.archivedAt) return null;

  const [draft, deployedRow, versionRows] = await Promise.all([
    readConnectedWorkflowDefinitionDraft(definitionId),
    readConnectedDeployedWorkflowDefinitionVersion(definitionId),
    readConnectedWorkflowDefinitionVersionRows(definitionId),
  ]);
  return { row, draft, deployedRow, versionRows };
}

/** Whether the id names a definition an editor may still work on. Archived
 *  counts as absent, which is why this is not a plain existence check. */
export async function activeWorkflowDefinitionExists(
  definitionId: number,
): Promise<boolean> {
  const row = await getConnectedWorkflowDefinition(definitionId);
  return Boolean(row && row.archivedAt === null);
}
