import {
  BLOCK_TYPE_SPECS,
  DEFAULT_PROMPT_NAME_BY_AGENT,
  parsePromptReferenceTokens,
  promptReferenceTargetLabel,
  WORKFLOW_PROMPT_PARAM_KEYS,
  type PromptReferenceSelector,
  type WorkflowBlockType,
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
    | "definition_has_no_nodes"
    | "node_shape"
    | "unknown_node_type"
    | "prompt_keys_unknown"
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
  /**
   * Definition snapshots that had at least one node and were read. Diagnostic
   * only: it counts snapshots opened, not references checked, so it is the
   * weaker signal. `pins.length` is what tells you the walk actually reached
   * built-in prompt text, and that is what the gate trusts.
   */
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

/**
 * Whether a block type is one that carries authored prompt text by convention.
 *
 * BLOCK_TYPE_SPECS records only category (trigger/action/control), so there is
 * no structural "is an agent" flag to read. Naming is the available signal, and
 * every prompt-bearing block today is either `*_agent` or `call_llm`. The point
 * is not to classify blocks, it is to notice a block that looks like it should
 * have a prompt-key entry and does not.
 */
function carriesPromptByConvention(blockType: string): boolean {
  return blockType.endsWith("_agent") || blockType === "call_llm";
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

  // Deduplicated in SQL, not afterwards. A queue holds one row per event, not
  // per definition: a wedged dispatcher with thousands of pending deliveries all
  // pointing at one definition is exactly when someone runs this check, and
  // selectDistinct makes that return a single row instead of thousands. The work
  // below is then bounded by the number of distinct pinned snapshots, which is
  // bounded by the number of definition versions that exist.
  const reachable: {
    definitionId: number;
    definitionVersion: number | null;
    source: BuiltInPromptPinSource;
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

  // The three queues can each name the same snapshot, so collapse across them
  // before any further query runs. First source wins, matching the ordering
  // rationale above.
  const pending = new Map<string, (typeof reachable)[number]>();
  for (const entry of reachable) {
    const key = `${entry.definitionId}@${entry.definitionVersion ?? "deployed"}`;
    if (!pending.has(key)) pending.set(key, entry);
  }

  if (pending.size > 0) {
    // One query for every definition the queues name, instead of one per row.
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

    // Resolve each entry to a concrete version and drop everything already
    // collected, before touching workflow_definition_versions at all.
    const wanted: {
      definitionId: number;
      definitionName: string;
      version: number;
      source: BuiltInPromptPinSource;
    }[] = [];
    const wantedKeys = new Set<string>();
    for (const entry of pending.values()) {
      const definitionRow = definitionById.get(entry.definitionId);
      // A legacy approval with no pinned version falls back to the deployed
      // version, exactly as approvals/dispatch.ts does.
      const version =
        entry.definitionVersion ?? definitionRow?.deployedVersion ?? null;
      // Resolving to no concrete version does not automatically mean a gap. A
      // queue row that pins nothing against a definition with nothing deployed
      // targets the very code-default snapshot the fresh-install walk already
      // covers, so reporting it as unread would fail the gate on a healthy
      // fresh install. Dedupe against what was walked before deciding it is a
      // gap; a definition nobody walked still records one below.
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
      // One query for every distinct snapshot still needed.
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
                eq(workflowDefinitionVersions.definitionId, entry.definitionId),
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
    if (definition.nodes.length === 0) {
      // An array is not an inspection. A snapshot with no blocks contributed
      // nothing, so counting it as walked would let an empty result look like a
      // clean one.
      skipped.push({
        reason: "definition_has_no_nodes",
        definitionId: target.definitionId,
        definitionVersion: target.definitionVersion,
        source: target.source,
        nodeId: null,
        detail: "stored definition has an empty nodes array",
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
      const keys = WORKFLOW_PROMPT_PARAM_KEYS[blockType];
      if (keys === undefined && carriesPromptByConvention(blockType)) {
        // The blind spot this whole report exists to prevent, one level down.
        // WORKFLOW_PROMPT_PARAM_KEYS is a Partial record, so a new agent block
        // added without a key entry would silently contribute no fields and no
        // finding, and the walk would still look successful. Naming it is the
        // only way the next person hears about it.
        skipped.push({
          reason: "prompt_keys_unknown",
          definitionId: target.definitionId,
          definitionVersion: target.definitionVersion,
          source: target.source,
          nodeId,
          detail: `block type "${blockType}" looks prompt-bearing but has no WORKFLOW_PROMPT_PARAM_KEYS entry, so its prompt fields cannot be located`,
        });
        continue;
      }
      const fields =
        keys === undefined || keys.length === 0
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
