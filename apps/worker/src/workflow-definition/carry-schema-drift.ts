import {
  REVIEW_RESULT_JSON_SCHEMA,
  type JsonSchema202012,
} from "@shared/contracts";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  approvalRequests,
  manualDispatchRequests,
  triggerDeliveries,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { defaultWorkflowDefinition } from "./default.js";
import { PR_CHECK_OUTPUT_SCHEMA } from "./templates.js";

/**
 * Drift alarm for code-owned JSON schemas embedded BY VALUE into stored workflow
 * definitions.
 *
 * A loop `carry` freezes a copy of a schema constant inside the definition JSON
 * (templates.ts embeds REVIEW_RESULT_JSON_SCHEMA into the review carries and
 * PR_CHECK_OUTPUT_SCHEMA into the post-PR "check" carry). Deployment-time
 * validation then compares that frozen copy against the type it derives LIVE
 * from the current constant: the review carries bind `steps.*-review.output`,
 * whose type block-registry.ts builds from the CURRENT REVIEW_RESULT_JSON_SCHEMA.
 * So the moment the constant changes shape (severity "critical"|"suggestion" ->
 * "Blocker"|"High"|"Medium"|"Nit"), every previously-valid stored definition
 * that carried the old copy starts failing validation with no migration having
 * touched it. That is AIW-245.
 *
 * This walks the same way builtin-prompt-drift does: from what a dispatch can
 * still select back to the constant. For every reachable definition snapshot it
 * finds every embedded schema and keys it, by structural equality, to the
 * code-owned source it mirrors:
 *
 *   - equals a source's CURRENT shape  -> healthy.
 *   - equals a source's KNOWN PRIOR shape -> drift a resync migration corrects.
 *   - equals nothing known, in a carry -> a customer authored their own schema.
 *     There is no authorship marker inside a definition (unlike prompt version
 *     rows), so this is the only safe signal: a resync must never overwrite it.
 *   - equals nothing known, in an outputSchema -> a template-local declaration
 *     (planningOutput and friends), reported but harmless: an outputSchema is
 *     self-declaring, it is not compared against a live code type.
 *
 * `definitionsWalked` and `skipped` exist for the same reason they do in
 * builtin-prompt-drift: the dangerous failure of a check like this is not a
 * wrong answer, it is walking nothing and reporting clean. Every path that
 * cannot read what it expected records a `skipped` entry instead of continuing
 * quietly.
 */

/** Why a definition snapshot is reachable, so a finding says which dispatch path
 *  can still serve it. Mirrors builtin-prompt-drift's pin sources. */
export type CarrySchemaPinSource =
  | "deployed"
  | "fresh_install_default"
  | "approval"
  | "trigger_delivery"
  | "manual_dispatch";

/** Manual dispatch rows that have not yet produced a started run, so their
 *  pinned version can still be executed. Mirrors the status check constraint. */
const LIVE_MANUAL_DISPATCH_STATUSES = [
  "pending",
  "reserved",
  "prepared",
  "candidate_started",
];

/**
 * A code-owned schema that a platform template embeds by value into a stored
 * definition. `current` is what the running code compares against; `knownPrior`
 * are earlier platform shapes a resync migration rewrites to `current`. A stored
 * embed that matches none of these is a customer's own schema, never touched.
 */
export interface EmbeddedSchemaSource {
  key: string;
  label: string;
  current: JsonSchema202012;
  /** Verified against git history; see the shape constants below. */
  knownPrior: JsonSchema202012[];
}

/**
 * REVIEW_RESULT before commit 5d30f5d5 gave findings four severities: severity
 * was "critical"|"suggestion" and there was no `repo` field. This is the exact
 * shape AIW-245 reproduces (a stored carry under this shape fails validation
 * with six errors, because the current review-agent output enum is disjoint).
 */
const REVIEW_RESULT_PRIOR_TWO_SEVERITY: JsonSchema202012 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
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
          file: { type: "string" },
          description: { type: "string" },
          severity: {
            type: "string",
            enum: ["critical", "suggestion"],
          },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["file", "description", "severity"],
        additionalProperties: true,
      },
    },
    feedback: { type: "string" },
  },
  required: ["decision", "findings"],
  additionalProperties: true,
};

/**
 * REVIEW_RESULT between commits 5d30f5d5 and e7ce4f82: four severities were in
 * place but the cross-repo `repo` field had not been added yet. A definition
 * saved in that window carries this shape.
 */
const REVIEW_RESULT_PRIOR_NO_REPO: JsonSchema202012 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
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
          file: { type: "string" },
          description: { type: "string" },
          severity: {
            type: "string",
            enum: ["Blocker", "High", "Medium", "Nit"],
          },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["file", "description", "severity"],
        additionalProperties: true,
      },
    },
    feedback: { type: "string" },
  },
  required: ["decision", "findings"],
  additionalProperties: true,
};

/** The registry of code-owned schemas embedded by value in platform templates.
 *  Shared with the resync migration generator so the gate and the migration can
 *  never disagree on which shapes are the platform's. */
export const EMBEDDED_SCHEMA_SOURCES: EmbeddedSchemaSource[] = [
  {
    key: "review_result",
    label: "REVIEW_RESULT_JSON_SCHEMA",
    current: REVIEW_RESULT_JSON_SCHEMA,
    knownPrior: [REVIEW_RESULT_PRIOR_TWO_SEVERITY, REVIEW_RESULT_PRIOR_NO_REPO],
  },
  {
    key: "pr_check",
    label: "PR_CHECK_OUTPUT_SCHEMA",
    current: PR_CHECK_OUTPUT_SCHEMA,
    knownPrior: [],
  },
];

/** Prior shapes the resync migration rewrites, keyed to the current shape it
 *  rewrites them to. Only sources that actually have known prior shapes appear.
 *  Consumed by scripts/generate-carry-schema-resync-migration.ts. */
export const RESYNC_TARGETS = EMBEDDED_SCHEMA_SOURCES.filter(
  (source) => source.knownPrior.length > 0,
).map((source) => ({
  key: source.key,
  current: source.current,
  knownPrior: source.knownPrior,
}));

/** Deterministic serialization with recursively sorted object keys. JSON Schema
 *  treats object key order as meaningless, and a stored embed comes back from
 *  jsonb in the driver's own key order, so structural equality is the only
 *  correct comparison. Array order (enum, required) is preserved, which matters. */
export function canonicalizeSchema(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

interface SourceMatch {
  sourceKey: string;
  classification: "current" | "prior";
}

const SCHEMA_INDEX: Map<string, SourceMatch> = (() => {
  const index = new Map<string, SourceMatch>();
  for (const source of EMBEDDED_SCHEMA_SOURCES) {
    index.set(canonicalizeSchema(source.current), {
      sourceKey: source.key,
      classification: "current",
    });
    for (const prior of source.knownPrior) {
      index.set(canonicalizeSchema(prior), {
        sourceKey: source.key,
        classification: "prior",
      });
    }
  }
  return index;
})();

/** Keys one embedded schema to its code-owned source. Returns null when it
 *  matches nothing known (a customer schema or a template-local outputSchema). */
export function classifyEmbeddedSchema(schema: unknown): SourceMatch | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }
  return SCHEMA_INDEX.get(canonicalizeSchema(schema)) ?? null;
}

export type EmbeddedSchemaKind = "carry" | "output_schema";

export interface EmbeddedSchemaFinding {
  definitionId: number;
  definitionName: string;
  /** null for the synthetic fresh-install graph, which has no version row. */
  definitionVersion: number | null;
  source: CarrySchemaPinSource;
  nodeId: string;
  /** Locatable path to the embed inside the node, e.g.
   *  "configuration/carry/0/schema" or "configuration/outputSchema". */
  field: string;
  kind: EmbeddedSchemaKind;
  /** The code-owned source it mirrors, or null when unrecognized. */
  sourceKey: string | null;
  classification: "current" | "prior" | "unrecognized";
}

export interface SkippedWalkTarget {
  reason:
    | "definition_version_missing"
    | "definition_shape"
    | "definition_has_no_nodes"
    | "node_shape"
    | "output_schema_unparseable";
  definitionId: number;
  definitionVersion: number | null;
  source: CarrySchemaPinSource;
  nodeId: string | null;
  detail: string;
}

export interface CarrySchemaDriftReport {
  /** Every embedded schema reached across every selectable snapshot. */
  embeds: EmbeddedSchemaFinding[];
  /** Embeds matching a KNOWN PRIOR platform shape: stale copies a resync
   *  migration will rewrite to the current constant. */
  drift: EmbeddedSchemaFinding[];
  /** Carry embeds matching no known platform shape: a customer authored their
   *  own schema. Reported, never rewritten. */
  customerDivergent: EmbeddedSchemaFinding[];
  /** outputSchema embeds matching no known platform shape: self-declaring
   *  template-local schemas. Informational only. */
  unrecognizedOutputSchemas: EmbeddedSchemaFinding[];
  /** Snapshots opened and read. `definitionsWalked === 0` is the empty-report
   *  failure that looks identical to success. */
  definitionsWalked: number;
  /** Everything the walk could not read. Non-empty means the report is
   *  incomplete and must not be treated as a pass. */
  skipped: SkippedWalkTarget[];
}

export function describeCarrySchemaDrift(
  report: CarrySchemaDriftReport,
): string {
  const lines = [
    ...report.drift.map(
      (embed) =>
        `${embed.sourceKey} embed reached by definition ${embed.definitionId} ` +
        `("${embed.definitionName}" ${
          embed.definitionVersion === null
            ? "code default"
            : `v${embed.definitionVersion}`
        }, via ${embed.source}) block "${embed.nodeId}" field "${embed.field}": ` +
        `stored schema matches a prior platform shape, not the current constant.`,
    ),
    ...report.customerDivergent.map(
      (embed) =>
        `CUSTOMER SCHEMA (left untouched) definition ${embed.definitionId} block ` +
        `"${embed.nodeId}" field "${embed.field}": does not match any known ` +
        `platform shape.`,
    ),
    ...report.skipped.map(
      (skip) =>
        `NOT WALKED (${skip.reason}) definition ${skip.definitionId} ` +
        `${skip.definitionVersion === null ? "code default" : `v${skip.definitionVersion}`} ` +
        `via ${skip.source}${skip.nodeId === null ? "" : ` block "${skip.nodeId}"`}: ${skip.detail}`,
    ),
  ];
  return lines.join("\n");
}

interface WalkTarget {
  definitionId: number;
  definitionName: string;
  definitionVersion: number | null;
  source: CarrySchemaPinSource;
  definition: unknown;
}

export interface FindCarrySchemaDriftOptions {
  /** Whether the fresh-install fallback graph is built with its review agent.
   *  The default v1 graph carries no loop, so this changes nothing for carry
   *  drift; kept for parity with builtin-prompt-drift's over-covering default. */
  includeReview?: boolean;
}

/** Every definition snapshot a dispatch can still select. Ported from
 *  builtin-prompt-drift's collectWalkTargets: deployed pointer, the versionless
 *  fresh-install default, and every approval / trigger-delivery / manual-dispatch
 *  pin, deduplicated on definition plus version. */
async function collectWalkTargets(
  db: Db,
  options: FindCarrySchemaDriftOptions,
  skipped: SkippedWalkTarget[],
): Promise<WalkTarget[]> {
  const targets: WalkTarget[] = [];
  const seen = new Set<string>();
  const add = (target: WalkTarget): void => {
    const key = `${target.definitionId}@${target.definitionVersion ?? "default"}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const row of await db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      version: workflowDefinitionVersions.version,
      definition: workflowDefinitionVersions.definition,
    })
    .from(workflowDefinitions)
    .innerJoin(
      workflowDefinitionVersions,
      and(
        eq(workflowDefinitionVersions.definitionId, workflowDefinitions.id),
        eq(
          workflowDefinitionVersions.version,
          workflowDefinitions.deployedVersion,
        ),
      ),
    )
    .where(
      and(
        isNull(workflowDefinitions.archivedAt),
        isNotNull(workflowDefinitions.deployedVersion),
      ),
    )) {
    add({
      definitionId: row.id,
      definitionName: row.name,
      definitionVersion: row.version,
      source: "deployed",
      definition: row.definition,
    });
  }

  // Fresh install: the enabled ticket definition with no stored version at all,
  // for which definition-step.ts serves the code default graph.
  for (const row of await db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      triggerTypes: workflowDefinitions.triggerTypes,
    })
    .from(workflowDefinitions)
    .where(
      and(
        isNull(workflowDefinitions.archivedAt),
        eq(workflowDefinitions.enabled, true),
        isNull(workflowDefinitions.deployedVersion),
      ),
    )) {
    if (!row.triggerTypes.includes("trigger_ticket_ai")) continue;
    const anyVersion = await db
      .select({ version: workflowDefinitionVersions.version })
      .from(workflowDefinitionVersions)
      .where(eq(workflowDefinitionVersions.definitionId, row.id))
      .limit(1);
    if (anyVersion.length > 0) continue;
    add({
      definitionId: row.id,
      definitionName: row.name,
      definitionVersion: null,
      source: "fresh_install_default",
      definition: defaultWorkflowDefinition({
        includeReview: options.includeReview ?? true,
        includeLeakReview: false,
      }),
    });
  }

  const reachable: {
    definitionId: number;
    definitionVersion: number | null;
    source: CarrySchemaPinSource;
  }[] = [
    ...(
      await db
        .selectDistinct({
          definitionId: approvalRequests.definitionId,
          definitionVersion: approvalRequests.definitionVersion,
        })
        .from(approvalRequests)
        .where(eq(approvalRequests.status, "pending"))
    ).map((row) => ({ ...row, source: "approval" as const })),
    ...(
      await db
        .selectDistinct({
          definitionId: triggerDeliveries.definitionId,
          definitionVersion: triggerDeliveries.definitionVersion,
        })
        .from(triggerDeliveries)
        .where(eq(triggerDeliveries.pending, true))
    ).map((row) => ({ ...row, source: "trigger_delivery" as const })),
    ...(
      await db
        .selectDistinct({
          definitionId: manualDispatchRequests.definitionId,
          definitionVersion: manualDispatchRequests.definitionVersion,
        })
        .from(manualDispatchRequests)
        .where(
          inArray(manualDispatchRequests.status, LIVE_MANUAL_DISPATCH_STATUSES),
        )
    ).map((row) => ({ ...row, source: "manual_dispatch" as const })),
  ];

  const pending = new Map<string, (typeof reachable)[number]>();
  for (const entry of reachable) {
    const key = `${entry.definitionId}@${entry.definitionVersion ?? "deployed"}`;
    if (!pending.has(key)) pending.set(key, entry);
  }

  if (pending.size > 0) {
    const definitionRows = await db
      .select({
        id: workflowDefinitions.id,
        name: workflowDefinitions.name,
        deployedVersion: workflowDefinitions.deployedVersion,
      })
      .from(workflowDefinitions)
      .where(
        inArray(
          workflowDefinitions.id,
          [...new Set([...pending.values()].map((entry) => entry.definitionId))],
        ),
      );
    const definitionById = new Map(definitionRows.map((row) => [row.id, row]));

    const wanted: {
      definitionId: number;
      definitionName: string;
      version: number;
      source: CarrySchemaPinSource;
    }[] = [];
    const wantedKeys = new Set<string>();
    for (const entry of pending.values()) {
      const definitionRow = definitionById.get(entry.definitionId);
      const version =
        entry.definitionVersion ?? definitionRow?.deployedVersion ?? null;
      if (
        definitionRow &&
        version === null &&
        seen.has(`${entry.definitionId}@default`)
      ) {
        continue;
      }
      if (!definitionRow || version === null) {
        skipped.push({
          reason: "definition_version_missing",
          definitionId: entry.definitionId,
          definitionVersion: entry.definitionVersion,
          source: entry.source,
          nodeId: null,
          detail: definitionRow
            ? "reachable snapshot pins no version and the definition has none deployed"
            : "reachable snapshot points at a definition that no longer exists",
        });
        continue;
      }
      const key = `${entry.definitionId}@${version}`;
      if (seen.has(key) || wantedKeys.has(key)) continue;
      wantedKeys.add(key);
      wanted.push({
        definitionId: entry.definitionId,
        definitionName: definitionRow.name,
        version,
        source: entry.source,
      });
    }

    if (wanted.length > 0) {
      const versionRows = await db
        .select({
          definitionId: workflowDefinitionVersions.definitionId,
          version: workflowDefinitionVersions.version,
          definition: workflowDefinitionVersions.definition,
        })
        .from(workflowDefinitionVersions)
        .where(
          or(
            ...wanted.map((entry) =>
              and(
                eq(
                  workflowDefinitionVersions.definitionId,
                  entry.definitionId,
                ),
                eq(workflowDefinitionVersions.version, entry.version),
              ),
            ),
          ),
        );
      const definitionByKey = new Map(
        versionRows.map((row) => [`${row.definitionId}@${row.version}`, row]),
      );
      for (const entry of wanted) {
        const versionRow = definitionByKey.get(
          `${entry.definitionId}@${entry.version}`,
        );
        if (!versionRow) {
          skipped.push({
            reason: "definition_version_missing",
            definitionId: entry.definitionId,
            definitionVersion: entry.version,
            source: entry.source,
            nodeId: null,
            detail: "reachable snapshot pins a version row that does not exist",
          });
          continue;
        }
        add({
          definitionId: entry.definitionId,
          definitionName: entry.definitionName,
          definitionVersion: entry.version,
          source: entry.source,
          definition: versionRow.definition,
        });
      }
    }
  }

  return targets;
}

interface EmbedCoordinates {
  definitionId: number;
  definitionName: string;
  definitionVersion: number | null;
  source: CarrySchemaPinSource;
}

/**
 * Pure per-definition walk: every embedded schema in one definition, classified.
 * No database, so it is reused by both the DB walk and the shipped-template
 * completeness test. `outputSchema` is stored as a JSON string; `carry[].schema`
 * as an object.
 */
export function collectDefinitionEmbeds(
  definition: unknown,
  coordinates: EmbedCoordinates,
): { embeds: EmbeddedSchemaFinding[]; skipped: SkippedWalkTarget[] } {
  const embeds: EmbeddedSchemaFinding[] = [];
  const skipped: SkippedWalkTarget[] = [];
  const shapeSkip = (
    reason: SkippedWalkTarget["reason"],
    nodeId: string | null,
    detail: string,
  ): void => {
    skipped.push({
      reason,
      definitionId: coordinates.definitionId,
      definitionVersion: coordinates.definitionVersion,
      source: coordinates.source,
      nodeId,
      detail,
    });
  };

  const value = definition as { schemaVersion?: unknown; nodes?: unknown } | null;
  if (value === null || typeof value !== "object" || !Array.isArray(value.nodes)) {
    shapeSkip(
      "definition_shape",
      null,
      "stored definition is not an object with a nodes array",
    );
    return { embeds, skipped };
  }
  if (value.nodes.length === 0) {
    shapeSkip("definition_has_no_nodes", null, "stored definition has an empty nodes array");
    return { embeds, skipped };
  }
  const containerKey = value.schemaVersion === 2 ? "configuration" : "params";

  const record = (
    nodeId: string,
    field: string,
    kind: EmbeddedSchemaKind,
    schema: unknown,
  ): void => {
    const match = classifyEmbeddedSchema(schema);
    embeds.push({
      definitionId: coordinates.definitionId,
      definitionName: coordinates.definitionName,
      definitionVersion: coordinates.definitionVersion,
      source: coordinates.source,
      nodeId,
      field,
      kind,
      sourceKey: match?.sourceKey ?? null,
      classification: match?.classification ?? "unrecognized",
    });
  };

  for (const raw of value.nodes) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      shapeSkip("node_shape", null, "node entry is not an object");
      continue;
    }
    const node = raw as Record<string, unknown>;
    const nodeId = typeof node.id === "string" ? node.id : null;
    if (nodeId === null) {
      shapeSkip("node_shape", null, "node is missing a string id");
      continue;
    }
    const container = node[containerKey];
    if (container === null || typeof container !== "object" || Array.isArray(container)) {
      continue;
    }
    const config = container as Record<string, unknown>;

    // Carries are a v2-only construct, and the resync migration only rewrites
    // configuration.carry. Surfacing a v1 params carry the migration could never
    // clear would be a permanent false red, so the gate and the migration agree:
    // carry drift is checked on v2 configuration only.
    if (value.schemaVersion === 2 && Array.isArray(config.carry)) {
      config.carry.forEach((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          return;
        }
        const schema = (entry as Record<string, unknown>).schema;
        if (schema === undefined) return;
        record(nodeId, `${containerKey}/carry/${index}/schema`, "carry", schema);
      });
    }

    if (typeof config.outputSchema === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(config.outputSchema);
      } catch {
        shapeSkip(
          "output_schema_unparseable",
          nodeId,
          `block "${nodeId}" outputSchema is not valid JSON`,
        );
        continue;
      }
      record(nodeId, `${containerKey}/outputSchema`, "output_schema", parsed);
    }
  }

  return { embeds, skipped };
}

export async function findCarrySchemaDrift(
  db: Db,
  options: FindCarrySchemaDriftOptions = {},
): Promise<CarrySchemaDriftReport> {
  const skipped: SkippedWalkTarget[] = [];
  const targets = await collectWalkTargets(db, options, skipped);

  const embeds: EmbeddedSchemaFinding[] = [];
  let definitionsWalked = 0;
  for (const target of targets) {
    const result = collectDefinitionEmbeds(target.definition, {
      definitionId: target.definitionId,
      definitionName: target.definitionName,
      definitionVersion: target.definitionVersion,
      source: target.source,
    });
    // A snapshot only counts as walked when it was a readable definition with
    // nodes: a shape skip means nothing was inspected there.
    const unreadable = result.skipped.some(
      (skip) =>
        skip.reason === "definition_shape" ||
        skip.reason === "definition_has_no_nodes",
    );
    if (!unreadable) definitionsWalked += 1;
    embeds.push(...result.embeds);
    skipped.push(...result.skipped);
  }

  return {
    embeds,
    drift: embeds.filter((embed) => embed.classification === "prior"),
    customerDivergent: embeds.filter(
      (embed) => embed.kind === "carry" && embed.classification === "unrecognized",
    ),
    unrecognizedOutputSchemas: embeds.filter(
      (embed) =>
        embed.kind === "output_schema" && embed.classification === "unrecognized",
    ),
    definitionsWalked,
    skipped,
  };
}
