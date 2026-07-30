import {
  BLOCK_TYPE_SPECS,
  DEFAULT_PROMPT_NAME_BY_AGENT,
  parsePromptReferenceTokens,
  promptReferenceTargetLabel,
  WORKFLOW_PROMPT_PARAM_KEYS,
  type PromptReferenceSelector,
  type WorkflowBlockType,
} from "@shared/contracts";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  approvalRequests,
  manualDispatchRequests,
  triggerDeliveries,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { defaultWorkflowDefinition } from "../workflow-definition/default.js";
import {
  builtInPromptBodyForSlug,
  type BuiltInPromptName,
} from "./builtin-prompts.js";
import {
  findPromptBySlug,
  findPromptRowsByNames,
  getCurrentPromptVersion,
  getPrompt,
  getPromptVersion,
  type PromptLibraryRow,
  type PromptLibraryVersionRow,
} from "./store.js";

/**
 * Drift alarm for the built-in agent prompts.
 *
 * Runs never read DEFAULT_AGENT_PROMPTS. A workflow definition carries a pinned
 * {{prompt:<slug>@N}} token inside its own stored JSON and the run resolves that
 * pin against prompt_library_versions (workflows/prompt-references-step.ts ->
 * prompt-library/store.ts createPromptReferenceLoader). Editing a code constant
 * therefore changes nothing until a resync migration moves the stored row, and a
 * resync that only looks at version 1 misses a definition that pins @2.
 * Migrations 0034 and 0036 made exactly that mistake and were inert on
 * production for two of the three built-ins.
 *
 * This walks the other way round, from what a run would actually resolve back to
 * the constant: for every definition snapshot a dispatch can still select, every
 * built-in reference it reaches is resolved through the same store reads the
 * runtime loader uses and its body is compared byte for byte with the constant.
 *
 * A mismatch is only a defect when the stored version is platform-shipped text.
 * A customer who forked a built-in owns their version, so those are reported
 * separately rather than counted as drift or dropped from the walk.
 *
 * `definitionsWalked` and `skipped` exist because the dangerous failure of a
 * check like this is not a wrong answer, it is walking nothing and reporting
 * clean. Every path that cannot read what it expected records a `skipped` entry
 * instead of continuing quietly, so "no drift" is only trustworthy alongside a
 * non-zero walk count and an empty skip list.
 */

/** Why a definition snapshot is reachable, so a finding says which dispatch path
 *  can still serve it. */
export type BuiltInPromptPinSource =
  /** Deployed pointer of a live definition: ordinary trigger selection. */
  | "deployed"
  /**
   * Fresh install. Migration 0013 creates the enabled ticket definition with no
   * version rows at all, and definition-step.ts runs the CODE DEFAULT graph for
   * it rather than a stored snapshot. That graph pins nothing: v1 supplies each
   * specialized agent prompt implicitly by name at `latest`, so the run serves
   * the library HEAD. This is the shape a brand new deployment has.
   */
  | "fresh_install_default"
  /**
   * Version an approved plan pinned. approvals/dispatch.ts resolves it
   * regardless of the definition's enabled flag or archived_at, precisely
   * because archiving must not strand a plan a human already approved.
   */
  | "approval"
  /** Pending provider event waiting to dispatch. */
  | "trigger_delivery"
  /** Manual dispatch request that has not finished starting. */
  | "manual_dispatch";

export type BuiltInPromptAuthorship = "platform" | "customer";

/** Marker migration 0021 and every resync migration write into the version row.
 *  No application path can produce it: createPrompt, savePromptVersion and
 *  restorePromptVersion all stamp actor.id / actor.label from the dashboard
 *  session, so customer text can never carry it. */
const PLATFORM_AUTHOR_ID = "system";
const PLATFORM_AUTHOR_LABEL = "System migration";

/** Matches the runtime resolver's own nesting limit. */
const MAX_REFERENCE_DEPTH = 10;

/** Manual dispatch rows that have not yet produced a started run, so their
 *  pinned version can still be executed. Mirrors the status check constraint. */
const LIVE_MANUAL_DISPATCH_STATUSES = [
  "pending",
  "reserved",
  "prepared",
  "candidate_started",
];

export interface WorkflowDefinitionCoordinates {
  definitionId: number;
  definitionName: string;
  /** null for the synthetic fresh-install graph, which has no version row. */
  definitionVersion: number | null;
  source: BuiltInPromptPinSource;
  nodeId: string;
  /** Prompt-bearing field the token sits in, with the array index when the field
   *  holds a list. */
  field: string;
}

export interface BuiltInPromptPin extends WorkflowDefinitionCoordinates {
  slug: string;
  promptName: BuiltInPromptName;
  requestedVersion: PromptReferenceSelector;
  resolvedVersion: number;
  authorship: BuiltInPromptAuthorship;
  matchesConstant: boolean;
  /** Whether a resync migration will actually correct this row: its parent must
   *  also be the platform's own, unarchived prompt, which is what 0037's guard
   *  requires. Keeps the check from reporting drift the migration refuses to
   *  fix. */
  resyncCovered: boolean;
}

export interface UnresolvedPromptReference extends WorkflowDefinitionCoordinates {
  target: string;
  requestedVersion: PromptReferenceSelector;
  reason: string;
}

export interface SkippedWalkTarget {
  reason:
    | "definition_version_missing"
    | "definition_shape"
    | "node_shape"
    | "unknown_node_type"
    | "node_container_missing";
  definitionId: number;
  definitionVersion: number | null;
  source: BuiltInPromptPinSource;
  nodeId: string | null;
  detail: string;
}

export interface BuiltInPromptDriftReport {
  /** Every built-in reference reachable from a selectable definition snapshot. */
  pins: BuiltInPromptPin[];
  /** Platform bodies that no longer match their constant and that a resync will
   *  correct. Each one is a prompt fix that shipped in code and never reached a
   *  run. */
  drift: BuiltInPromptPin[];
  /** Platform bodies that drifted but sit under a prompt row a resync will not
   *  touch, so code alone cannot fix them. */
  unfixableDrift: BuiltInPromptPin[];
  /** Pins resolving to a version a real account authored. Not drift: that text
   *  is the customer's. Still surfaced, because a platform prompt fix will not
   *  reach those runs either. */
  customerAuthored: BuiltInPromptPin[];
  /** References a reachable snapshot pins that resolve to nothing. */
  unresolved: UnresolvedPromptReference[];
  /** Definition snapshots whose node list was actually read. Zero means the
   *  report is meaningless, not clean. */
  definitionsWalked: number;
  /** Everything the walk could not read. Non-empty means the report is
   *  incomplete and must not be treated as a pass. */
  skipped: SkippedWalkTarget[];
}

export interface FindBuiltInPromptDriftOptions {
  /**
   * Whether the fresh-install fallback graph is built with its review agent.
   * Defaults to true so the alarm over-covers: checking a built-in an install
   * does not currently run costs nothing, missing one is the defect this exists
   * to catch. Leak review is irrelevant here because leak_review carries no
   * prompt field and no implicit default prompt.
   */
  includeReview?: boolean;
}

export function describeBuiltInPromptDrift(
  report: BuiltInPromptDriftReport,
): string {
  const lines = [
    ...report.drift.map(
      (pin) =>
        `${pin.slug}@${pin.resolvedVersion} reached by definition ${pin.definitionId} ` +
        `("${pin.definitionName}" ${
          pin.definitionVersion === null
            ? "code default"
            : `v${pin.definitionVersion}`
        }, via ${pin.source}) block "${pin.nodeId}" field "${pin.field}": ` +
        `stored body differs from DEFAULT_AGENT_PROMPTS.`,
    ),
    ...report.unfixableDrift.map(
      (pin) =>
        `${pin.slug}@${pin.resolvedVersion} drifted and no resync migration can ` +
        `correct it: its prompt row is archived or not platform-owned.`,
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

function isPlatformAuthored(row: {
  createdById: string;
  createdByLabel: string;
}): boolean {
  return (
    row.createdById === PLATFORM_AUTHOR_ID &&
    row.createdByLabel === PLATFORM_AUTHOR_LABEL
  );
}

interface WalkTarget {
  definitionId: number;
  definitionName: string;
  definitionVersion: number | null;
  source: BuiltInPromptPinSource;
  definition: unknown;
}

/** Every definition snapshot a dispatch can still select. Ordered so the
 *  ordinary deployed selection is recorded before the queue-reachable duplicates
 *  of the same version, and deduplicated on definition plus version so one
 *  snapshot is never reported twice. */
async function collectWalkTargets(
  db: Db,
  options: FindBuiltInPromptDriftOptions,
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
        eq(workflowDefinitionVersions.version, workflowDefinitions.deployedVersion),
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

  // Fresh install: enabled ticket definition with no stored version at all, the
  // exact row migration 0013 leaves behind. definition-step.ts serves the code
  // default graph for it, which resolves each built-in implicitly at `latest`.
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
    // draftRevision is the head version number, so "draftRevision === 0" is
    // "no version rows exist".
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
    source: BuiltInPromptPinSource;
  }[] = [
    ...(
      await db
        .select({
          definitionId: approvalRequests.definitionId,
          definitionVersion: approvalRequests.definitionVersion,
        })
        .from(approvalRequests)
        .where(eq(approvalRequests.status, "pending"))
    ).map((row) => ({ ...row, source: "approval" as const })),
    ...(
      await db
        .select({
          definitionId: triggerDeliveries.definitionId,
          definitionVersion: triggerDeliveries.definitionVersion,
        })
        .from(triggerDeliveries)
        .where(eq(triggerDeliveries.pending, true))
    ).map((row) => ({ ...row, source: "trigger_delivery" as const })),
    ...(
      await db
        .select({
          definitionId: manualDispatchRequests.definitionId,
          definitionVersion: manualDispatchRequests.definitionVersion,
        })
        .from(manualDispatchRequests)
        .where(
          inArray(manualDispatchRequests.status, LIVE_MANUAL_DISPATCH_STATUSES),
        )
    ).map((row) => ({ ...row, source: "manual_dispatch" as const })),
  ];

  for (const entry of reachable) {
    const definitionRows = await db
      .select({
        id: workflowDefinitions.id,
        name: workflowDefinitions.name,
        deployedVersion: workflowDefinitions.deployedVersion,
      })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, entry.definitionId))
      .limit(1);
    const definitionRow = definitionRows[0];
    // A legacy approval with no pinned version falls back to the deployed
    // version, exactly as approvals/dispatch.ts does.
    const version = entry.definitionVersion ?? definitionRow?.deployedVersion ?? null;
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
    if (seen.has(`${entry.definitionId}@${version}`)) continue;
    const versionRows = await db
      .select({ definition: workflowDefinitionVersions.definition })
      .from(workflowDefinitionVersions)
      .where(
        and(
          eq(workflowDefinitionVersions.definitionId, entry.definitionId),
          eq(workflowDefinitionVersions.version, version),
        ),
      )
      .limit(1);
    if (versionRows.length === 0) {
      skipped.push({
        reason: "definition_version_missing",
        definitionId: entry.definitionId,
        definitionVersion: version,
        source: entry.source,
        nodeId: null,
        detail: "reachable snapshot pins a version row that does not exist",
      });
      continue;
    }
    add({
      definitionId: entry.definitionId,
      definitionName: definitionRow.name,
      definitionVersion: version,
      source: entry.source,
      definition: versionRows[0]!.definition,
    });
  }

  return targets;
}

/** Every prompt-bearing string of a node, keyed by a locatable field path. v2
 *  keeps them under `configuration`, v1 under `params`; the key set is the one
 *  the runtime itself resolves through. */
function promptFields(
  schemaVersion: number,
  node: Record<string, unknown>,
  target: WalkTarget,
  nodeId: string,
  keys: readonly string[],
  skipped: SkippedWalkTarget[],
): { field: string; text: string }[] {
  const containerKey = schemaVersion === 2 ? "configuration" : "params";
  const container = node[containerKey];
  if (
    container === null ||
    typeof container !== "object" ||
    Array.isArray(container)
  ) {
    skipped.push({
      reason: "node_container_missing",
      definitionId: target.definitionId,
      definitionVersion: target.definitionVersion,
      source: target.source,
      nodeId,
      detail: `block carries prompt fields (${keys.join(", ")}) but has no readable "${containerKey}" object`,
    });
    return [];
  }
  const source = container as Record<string, unknown>;
  const out: { field: string; text: string }[] = [];
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      out.push({ field: key, text: value });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string") {
          out.push({ field: `${key}/${index}`, text: item });
        }
      });
    }
  }
  return out;
}

export async function findBuiltInPromptDrift(
  db: Db,
  options: FindBuiltInPromptDriftOptions = {},
): Promise<BuiltInPromptDriftReport> {
  const pins: BuiltInPromptPin[] = [];
  const unresolved: UnresolvedPromptReference[] = [];
  const skipped: SkippedWalkTarget[] = [];
  const targets = await collectWalkTargets(db, options, skipped);

  const promptCache = new Map<string, PromptLibraryRow | null>();
  const versionCache = new Map<string, PromptLibraryVersionRow | null>();

  const promptFor = async (
    slug: string | undefined,
    legacyPromptId: number | undefined,
  ): Promise<PromptLibraryRow | null> => {
    const key = slug ?? `#${legacyPromptId}`;
    if (!promptCache.has(key)) {
      promptCache.set(
        key,
        slug !== undefined
          ? await findPromptBySlug(db, slug)
          : await getPrompt(db, legacyPromptId!),
      );
    }
    return promptCache.get(key)!;
  };

  const versionFor = async (
    promptId: number,
    selector: PromptReferenceSelector,
  ): Promise<PromptLibraryVersionRow | null> => {
    const key = `${promptId}@${selector}`;
    if (!versionCache.has(key)) {
      versionCache.set(
        key,
        selector === "latest"
          ? await getCurrentPromptVersion(db, promptId)
          : await getPromptVersion(db, promptId, selector),
      );
    }
    return versionCache.get(key)!;
  };

  /** Records every built-in reference in `text`, then follows each resolved body
   *  so a built-in nested inside another prompt is covered too. */
  const walk = async (
    text: string,
    coordinates: WorkflowDefinitionCoordinates,
    seen: readonly string[],
  ): Promise<void> => {
    if (seen.length >= MAX_REFERENCE_DEPTH) return;
    for (const token of parsePromptReferenceTokens(text)) {
      const prompt = await promptFor(token.slug, token.legacyPromptId);
      if (!prompt) {
        unresolved.push({
          ...coordinates,
          target: promptReferenceTargetLabel(token),
          requestedVersion: token.version,
          reason: "prompt does not exist",
        });
        continue;
      }
      const version = await versionFor(prompt.id, token.version);
      if (!version) {
        unresolved.push({
          ...coordinates,
          target: promptReferenceTargetLabel(token),
          requestedVersion: token.version,
          reason: `prompt has no version ${token.version}`,
        });
        continue;
      }
      const constant = builtInPromptBodyForSlug(prompt.slug);
      if (constant !== null) {
        pins.push({
          ...coordinates,
          slug: prompt.slug,
          promptName: prompt.name as BuiltInPromptName,
          requestedVersion: token.version,
          resolvedVersion: version.version,
          authorship: isPlatformAuthored(version) ? "platform" : "customer",
          matchesConstant: version.body === constant,
          resyncCovered:
            isPlatformAuthored(prompt) && prompt.archivedAt === null,
        });
      }
      const resolvedKey = `${prompt.id}@${version.version}`;
      if (seen.includes(resolvedKey)) continue;
      await walk(version.body, coordinates, [...seen, resolvedKey]);
    }
  };

  let definitionsWalked = 0;
  for (const target of targets) {
    const definition = target.definition as
      | { schemaVersion?: unknown; nodes?: unknown }
      | null;
    if (
      definition === null ||
      typeof definition !== "object" ||
      !Array.isArray(definition.nodes)
    ) {
      skipped.push({
        reason: "definition_shape",
        definitionId: target.definitionId,
        definitionVersion: target.definitionVersion,
        source: target.source,
        nodeId: null,
        detail: "stored definition is not an object with a nodes array",
      });
      continue;
    }
    definitionsWalked += 1;
    // Anything not explicitly schema 2 is read as v1, which is how the runtime
    // treats a legacy row predating the field.
    const schemaVersion = definition.schemaVersion === 2 ? 2 : 1;

    for (const raw of definition.nodes) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        skipped.push({
          reason: "node_shape",
          definitionId: target.definitionId,
          definitionVersion: target.definitionVersion,
          source: target.source,
          nodeId: null,
          detail: "node entry is not an object",
        });
        continue;
      }
      const node = raw as Record<string, unknown>;
      const nodeId = typeof node.id === "string" ? node.id : null;
      const nodeType = typeof node.type === "string" ? node.type : null;
      if (nodeId === null || nodeType === null) {
        skipped.push({
          reason: "node_shape",
          definitionId: target.definitionId,
          definitionVersion: target.definitionVersion,
          source: target.source,
          nodeId,
          detail: "node is missing a string id or type",
        });
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(BLOCK_TYPE_SPECS, nodeType)) {
        skipped.push({
          reason: "unknown_node_type",
          definitionId: target.definitionId,
          definitionVersion: target.definitionVersion,
          source: target.source,
          nodeId,
          detail: `block type "${nodeType}" is not in the block registry, so its prompt fields are unknown`,
        });
        continue;
      }
      const blockType = nodeType as WorkflowBlockType;
      const base = {
        definitionId: target.definitionId,
        definitionName: target.definitionName,
        definitionVersion: target.definitionVersion,
        source: target.source,
        nodeId,
      };
      const keys = WORKFLOW_PROMPT_PARAM_KEYS[blockType] ?? [];
      const fields =
        keys.length === 0
          ? []
          : promptFields(schemaVersion, node, target, nodeId, keys, skipped);
      for (const { field, text } of fields) {
        await walk(text, { ...base, field }, []);
      }

      // v1 supplies a specialized agent's prompt implicitly when the field is
      // blank: the run materializes {{prompt:<slug>}} at `latest` from the
      // library row matching the built-in's registry name, so the HEAD body
      // reaches the agent. This is also how the fresh-install code default
      // resolves all three built-ins.
      if (schemaVersion !== 1) continue;
      const implicitName = DEFAULT_PROMPT_NAME_BY_AGENT[blockType];
      const authored = fields.find(({ field }) => field === "prompt")?.text;
      if (!implicitName || (authored ?? "").trim().length > 0) continue;
      const coordinates = { ...base, field: "prompt" };
      const candidates = await findPromptRowsByNames(db, [implicitName]);
      const active = candidates.find((candidate) => candidate.archivedAt === null);
      if (!active) {
        unresolved.push({
          ...coordinates,
          target: implicitName,
          requestedVersion: "latest",
          reason: "implicit v1 default prompt is missing or archived",
        });
        continue;
      }
      await walk(`{{prompt:${active.slug}}}`, coordinates, []);
    }
  }

  const driftCandidates = pins.filter(
    (pin) => pin.authorship === "platform" && !pin.matchesConstant,
  );
  return {
    pins,
    drift: driftCandidates.filter((pin) => pin.resyncCovered),
    unfixableDrift: driftCandidates.filter((pin) => !pin.resyncCovered),
    customerAuthored: pins.filter((pin) => pin.authorship === "customer"),
    unresolved,
    definitionsWalked,
    skipped,
  };
}
