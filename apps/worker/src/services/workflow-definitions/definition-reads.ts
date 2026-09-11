/**
 * What the editor is shown about the definitions that exist.
 *
 * The store below takes a connection and answers about rows; this binds the
 * connection and decides what a dashboard read means, including the two shapes
 * that are not simply "the rows": the editor's opening payload, which needs the
 * seed a new definition would start from, and the detail read, which treats an
 * archived definition as absent.
 */
import { defaultWorkflowDefinitionV2 } from "../../workflow-definition/default.js";
import {
  buildWorkflowEditorOptions,
  fetchAvailableModels,
  fetchTicketStatuses,
} from "../../workflow-definition/models.js";
import { workflowDefinitionTemplates } from "../../workflow-definition/templates.js";
import {
  type WorkflowDefinitionRow,
  type WorkflowDefinitionVersionRow,
} from "../../db/repositories/definitions.js";
import {
  getConnectedWorkflowDefinition,
  listConnectedWorkflowDefinitions,
} from "../../db/repositories/definitions/connected.js";
import { agentRuntimeSettings } from "../settings/index.js";
import { currentSystemHarnessProfileReference } from "../harness/index.js";
import {
  readConnectedDeployedWorkflowDefinitionVersion,
  readConnectedWorkflowDefinitionVersionRows,
} from "../../engine/stored-definition-reads.js";
import { readConnectedWorkflowDefinitionDraft } from "../../engine/definition-draft-read.js";

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

/**
 * Everything the editor needs before it can show anything: the definitions, the
 * choices a block may offer, and the two seeds (templates and the default) a
 * new definition can start from. Those seeds depend on the deployment, since
 * which agent runs and which optional phases exist decide what a starting graph
 * contains, so they are shaped here rather than by the caller.
 */
export async function readWorkflowDefinitionsOverview(): Promise<WorkflowDefinitionsOverview> {
  const { agentKind, includeReview, includeLeakReview } = agentRuntimeSettings();
  const definitions = await listConnectedWorkflowDefinitions();
  const [models, ticketStatuses, profileReference] = await Promise.all([
    fetchAvailableModels(),
    fetchTicketStatuses(),
    currentSystemHarnessProfileReference(agentKind),
  ]);
  const seedOptions = {
    includeReview,
    includeLeakReview,
    provider: agentKind,
    profileReference,
  };
  return {
    definitions,
    templates: workflowDefinitionTemplates(seedOptions),
    defaultDefinition: defaultWorkflowDefinitionV2(seedOptions),
    options: buildWorkflowEditorOptions(models, ticketStatuses),
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
