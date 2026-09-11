import {
  BLOCK_TYPE_SPECS,
  WORKFLOW_PROMPT_PARAM_KEYS,
  type PromptReferenceSelector,
  type WorkflowBlockType,
} from "@shared/contracts";
import {
  builtInPromptBodyForSlug,
  parsePromptReferenceTokens,
  promptReferenceTargetLabel,
  type BuiltInPromptDriftReport,
  type BuiltInPromptName,
  type BuiltInPromptPin,
  type BuiltInPromptPinSource,
  type SkippedWalkTarget,
  type UnresolvedPromptReference,
  type WorkflowDefinitionCoordinates,
} from "@shared/prompts";
import type { Db } from "../db/types.js";
import {
  definitionHasAnyVersion,
  listDefinitionDriftMetadata,
  listDefinitionDriftSnapshots,
  listDeployedDefinitionSnapshots,
  listFreshInstallDefinitionCandidates,
  listLiveManualDispatchDefinitionPins,
  listPendingApprovalDefinitionPins,
  listPendingTriggerDeliveryDefinitionPins,
} from "../db/repositories/definitions.js";
import {
  connectedDefinitionHasAnyVersion,
  listConnectedDefinitionDriftMetadata,
  listConnectedDefinitionDriftSnapshots,
  listConnectedDeployedDefinitionSnapshots,
  listConnectedFreshInstallDefinitionCandidates,
  listConnectedLiveManualDispatchDefinitionPins,
  listConnectedPendingApprovalDefinitionPins,
  listConnectedPendingTriggerDeliveryDefinitionPins,
} from "../db/repositories/definitions/drift-reads.js";
import { defaultWorkflowDefinitionV2 } from "../workflow-definition/default.js";
import {
  findPromptBySlug,
  getCurrentPromptVersion,
  getPrompt,
  getPromptVersion,
  type PromptLibraryRow,
  type PromptLibraryVersionRow,
} from "../db/repositories/prompts.js";
import {
  findConnectedPromptBySlug,
  getConnectedCurrentPromptVersion,
  getConnectedPrompt,
  getConnectedPromptVersion,
} from "../db/repositories/prompts.js";

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
const PLATFORM_AUTHOR_ID = "system";
const PLATFORM_AUTHOR_LABEL = "System migration";
const MAX_REFERENCE_DEPTH = 10;
const LIVE_MANUAL_DISPATCH_STATUSES = [
  "pending",
  "reserved",
  "prepared",
  "candidate_started",
];

export interface FindBuiltInPromptDriftOptions {
  includeReview?: boolean;
}

interface BuiltInPromptDriftStore {
  listDeployedDefinitionSnapshots: typeof listDeployedDefinitionSnapshots extends (
    db: Db,
  ) => infer Result ? () => Result : never;
  listFreshInstallDefinitionCandidates: typeof listFreshInstallDefinitionCandidates extends (
    db: Db,
  ) => infer Result ? () => Result : never;
  definitionHasAnyVersion: (definitionId: number) => Promise<boolean>;
  listPendingApprovalDefinitionPins: typeof listPendingApprovalDefinitionPins extends (
    db: Db,
  ) => infer Result ? () => Result : never;
  listPendingTriggerDeliveryDefinitionPins: typeof listPendingTriggerDeliveryDefinitionPins extends (
    db: Db,
  ) => infer Result ? () => Result : never;
  listLiveManualDispatchDefinitionPins: (statuses: readonly string[]) => ReturnType<typeof listLiveManualDispatchDefinitionPins>;
  listDefinitionDriftMetadata: (definitionIds: number[]) => ReturnType<typeof listDefinitionDriftMetadata>;
  listDefinitionDriftSnapshots: (requests: Array<{ definitionId: number; version: number }>) => ReturnType<typeof listDefinitionDriftSnapshots>;
  findPromptBySlug: (slug: string) => ReturnType<typeof findPromptBySlug>;
  getPrompt: (promptId: number) => ReturnType<typeof getPrompt>;
  getCurrentPromptVersion: (promptId: number) => ReturnType<typeof getCurrentPromptVersion>;
  getPromptVersion: (promptId: number, version: number) => ReturnType<typeof getPromptVersion>;
}

function builtInPromptDriftStore(db: Db): BuiltInPromptDriftStore {
  return {
    listDeployedDefinitionSnapshots: () => listDeployedDefinitionSnapshots(db),
    listFreshInstallDefinitionCandidates: () => listFreshInstallDefinitionCandidates(db),
    definitionHasAnyVersion: (definitionId) => definitionHasAnyVersion(db, definitionId),
    listPendingApprovalDefinitionPins: () => listPendingApprovalDefinitionPins(db),
    listPendingTriggerDeliveryDefinitionPins: () => listPendingTriggerDeliveryDefinitionPins(db),
    listLiveManualDispatchDefinitionPins: (statuses) => listLiveManualDispatchDefinitionPins(db, statuses),
    listDefinitionDriftMetadata: (definitionIds) => listDefinitionDriftMetadata(db, definitionIds),
    listDefinitionDriftSnapshots: (requests) => listDefinitionDriftSnapshots(db, requests),
    findPromptBySlug: (slug) => findPromptBySlug(db, slug),
    getPrompt: (promptId) => getPrompt(db, promptId),
    getCurrentPromptVersion: (promptId) => getCurrentPromptVersion(db, promptId),
    getPromptVersion: (promptId, version) => getPromptVersion(db, promptId, version),
  };
}

const connectedBuiltInPromptDriftStore: BuiltInPromptDriftStore = {
  listDeployedDefinitionSnapshots: listConnectedDeployedDefinitionSnapshots,
  listFreshInstallDefinitionCandidates: listConnectedFreshInstallDefinitionCandidates,
  definitionHasAnyVersion: connectedDefinitionHasAnyVersion,
  listPendingApprovalDefinitionPins: listConnectedPendingApprovalDefinitionPins,
  listPendingTriggerDeliveryDefinitionPins: listConnectedPendingTriggerDeliveryDefinitionPins,
  listLiveManualDispatchDefinitionPins: listConnectedLiveManualDispatchDefinitionPins,
  listDefinitionDriftMetadata: listConnectedDefinitionDriftMetadata,
  listDefinitionDriftSnapshots: listConnectedDefinitionDriftSnapshots,
  findPromptBySlug: findConnectedPromptBySlug,
  getPrompt: getConnectedPrompt,
  getCurrentPromptVersion: getConnectedCurrentPromptVersion,
  getPromptVersion: getConnectedPromptVersion,
};

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
  store: BuiltInPromptDriftStore,
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

  for (const row of await store.listDeployedDefinitionSnapshots()) {
    add({
      definitionId: row.id,
      definitionName: row.name,
      definitionVersion: row.version,
      source: "deployed",
      definition: row.definition,
    });
  }

  // Fresh install: enabled ticket definition with no stored version at all, the
  // exact row migration 0013 leaves behind. definition-step.ts serves the v2
  // code default graph for it, with each built-in pinned to its shipped version.
  for (const row of await store.listFreshInstallDefinitionCandidates()) {
    if (!row.triggerTypes.includes("trigger_ticket_ai")) continue;
    // draftRevision is the head version number, so "draftRevision === 0" is
    // "no version rows exist".
    if (await store.definitionHasAnyVersion(row.id)) continue;
    add({
      definitionId: row.id,
      definitionName: row.name,
      definitionVersion: null,
      source: "fresh_install_default",
      definition: defaultWorkflowDefinitionV2({
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
    ...(await store.listPendingApprovalDefinitionPins()).map((row) =>
      Object.assign({}, row, { source: "approval" as const }),
    ),
    ...(await store.listPendingTriggerDeliveryDefinitionPins()).map((row) =>
      Object.assign({}, row, { source: "trigger_delivery" as const }),
    ),
    ...(await store.listLiveManualDispatchDefinitionPins(LIVE_MANUAL_DISPATCH_STATUSES)).map((row) =>
      Object.assign({}, row, { source: "manual_dispatch" as const }),
    ),
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
    const definitionRows = await store.listDefinitionDriftMetadata(
      [...new Set([...pending.values()].map((entry) => entry.definitionId))],
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
      const versionRows = await store.listDefinitionDriftSnapshots(wanted);
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

/** Every prompt-bearing string of a node, keyed by a locatable field path. They
 *  live under `configuration`, and the key set is the one the runtime itself
 *  resolves through. */
function promptFields(
  node: Record<string, unknown>,
  target: WalkTarget,
  nodeId: string,
  keys: readonly string[],
  skipped: SkippedWalkTarget[],
): { field: string; text: string }[] {
  const containerKey = "configuration";
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
  return findBuiltInPromptDriftWithStore(builtInPromptDriftStore(db), options);
}

export async function findConnectedBuiltInPromptDrift(
  options: FindBuiltInPromptDriftOptions = {},
): Promise<BuiltInPromptDriftReport> {
  return findBuiltInPromptDriftWithStore(connectedBuiltInPromptDriftStore, options);
}

async function findBuiltInPromptDriftWithStore(
  store: BuiltInPromptDriftStore,
  options: FindBuiltInPromptDriftOptions,
): Promise<BuiltInPromptDriftReport> {
  const pins: BuiltInPromptPin[] = [];
  const unresolved: UnresolvedPromptReference[] = [];
  const skipped: SkippedWalkTarget[] = [];
  const targets = await collectWalkTargets(store, options, skipped);

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
          ? await store.findPromptBySlug(slug)
          : await store.getPrompt(legacyPromptId!),
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
          ? await store.getCurrentPromptVersion(promptId)
          : await store.getPromptVersion(promptId, selector),
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
    const definition = target.definition as { nodes?: unknown } | null;
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
          : promptFields(node, target, nodeId, keys, skipped);
      for (const { field, text } of fields) {
        await walk(text, { ...base, field }, []);
      }
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
