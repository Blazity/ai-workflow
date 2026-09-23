/**
 * The one reader of a stored definition row, and the one place that still knows
 * a definition schema older than the running one exists (ADR-003).
 *
 * A v2 row parses into the runnable graph. A v1 row is returned exactly as it
 * was written: the envelope below checks only what decides the arm, so a row
 * that was legal when it was stored stays readable, and nothing upgrades it,
 * because an operator opening history has to see what was stored rather than a
 * translation of it. Everything a v1 row can no longer do (restore, deploy,
 * save) is refused by its caller with RETIRED_SCHEMA_MESSAGE.
 */
import type { StoredWorkflowDefinition } from "@shared/contracts";
import { workflowDefinitionSchemaVersionOf } from "@shared/contracts";
import { parse } from "@shared/workflow-graph";

/** The discriminator is the only fact this reader needs to classify a legacy
 *  row. Historical content is deliberately not parsed, normalized or trimmed. */
export function isLegacyStoredWorkflowDefinition(raw: unknown): boolean {
  return workflowDefinitionSchemaVersionOf(raw) === 1;
}

export function parseStoredWorkflowDefinition(raw: unknown): StoredWorkflowDefinition {
  if (isLegacyStoredWorkflowDefinition(raw)) {
    return { schema: "legacy-v1", definition: raw };
  }
  // Not a v1 row, so it has to be a runnable one. An unreadable row throws the
  // parser's own error here, exactly as it did before v1 was retired.
  //
  // A block this build renamed is rewritten first, so everything downstream
  // sees one name: the palette, the parameter schemas, the resolver, the
  // editor and the run. The row itself is untouched until somebody publishes,
  // which is deliberate (ADR-010): rewriting stored rows is a separate,
  // explicitly invoked one-off, never something a read or a build migration
  // does to a database a preview deployment shares with production.
  const parsed = parse(raw);
  if (parsed.definition === null) throw parsed.error;
  return { schema: "v2", definition: parsed.definition };
}
