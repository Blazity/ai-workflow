import {
  DEFAULT_AGENT_PROMPTS,
  DEFAULT_PROMPT_NAME_BY_AGENT,
  parsePromptReferenceTokens,
  promptReferenceTargetLabel,
  WORKFLOW_PROMPT_PARAM_KEYS,
  type PromptReferenceSelector,
  type WorkflowDefinition,
} from "@shared/contracts";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowDefinitions, workflowDefinitionVersions } from "../db/schema.js";
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
 * Runs never read DEFAULT_AGENT_PROMPTS. A workflow definition stores a pinned
 * {{prompt:<slug>@N}} token inside its own JSON, and the run resolves that pin
 * against prompt_library_versions (workflows/prompt-references-step.ts ->
 * prompt-library/store.ts createPromptReferenceLoader). Editing a code constant
 * therefore changes nothing until a resync migration moves the stored row, and
 * an assertion that only checks version 1 misses a definition that pins @2.
 * Migrations 0034 and 0036 made exactly that mistake and were inert on
 * production for two of the three built-ins.
 *
 * This walks the other way round, from what a run would actually resolve back to
 * the constant: for every active definition, every built-in reference it pins is
 * resolved through the same store reads the runtime loader uses and its body is
 * compared byte for byte with the constant.
 *
 * A mismatch is only a defect when the stored version is platform-shipped text.
 * A customer who forked a built-in owns their version, so those are reported
 * separately instead of being counted as drift or excluded from the walk.
 */

export type BuiltInPromptSlug = keyof typeof DEFAULT_AGENT_PROMPTS;

const BUILT_IN_SLUGS = Object.keys(DEFAULT_AGENT_PROMPTS) as BuiltInPromptSlug[];

/** Provenance of the version row a pin resolved to.
 *  - "platform": written by migration 0021 or a resync, so the constant owns it.
 *  - "customer": written through a role-gated dashboard route, which always
 *    stamps the authenticated account, so the customer owns it. */
export type BuiltInPromptAuthorship = "platform" | "customer";

/** Marker migration 0021 and every resync migration write. No application code
 *  path can produce it: createPrompt, savePromptVersion and restorePromptVersion
 *  all stamp actor.id / actor.label from the dashboard session. */
const PLATFORM_AUTHOR_ID = "system";
const PLATFORM_AUTHOR_LABEL = "System migration";

/** How deep to follow a reference nested inside another prompt's body. Matches
 *  the runtime resolver's own limit. */
const MAX_REFERENCE_DEPTH = 10;

export interface WorkflowDefinitionCoordinates {
  definitionId: number;
  definitionName: string;
  definitionVersion: number;
  nodeId: string;
  /** Prompt-bearing field the token was found in, plus the array index and the
   *  chain of prompt slugs it was nested under, so a finding is locatable. */
  field: string;
}

export interface BuiltInPromptPin extends WorkflowDefinitionCoordinates {
  slug: BuiltInPromptSlug;
  requestedVersion: PromptReferenceSelector;
  resolvedVersion: number;
  authorship: BuiltInPromptAuthorship;
  matchesConstant: boolean;
}

export interface UnresolvedPromptReference extends WorkflowDefinitionCoordinates {
  target: string;
  requestedVersion: PromptReferenceSelector;
  reason: string;
}

export interface BuiltInPromptDriftReport {
  /** Every built-in reference reachable from an active definition. */
  pins: BuiltInPromptPin[];
  /** Platform-shipped bodies that no longer match their constant. Each one is a
   *  prompt fix that has shipped in code and never reached a run. */
  drift: BuiltInPromptPin[];
  /** Pins resolving to a version a real account authored. Not drift: the
   *  customer's text is theirs. Still surfaced, because a platform prompt fix
   *  will not reach these runs either. */
  customerAuthored: BuiltInPromptPin[];
  /** References an active definition pins that resolve to nothing at all. */
  unresolved: UnresolvedPromptReference[];
}

export function describeBuiltInPromptDrift(
  report: BuiltInPromptDriftReport,
): string {
  return report.drift
    .map(
      (pin) =>
        `${pin.slug}@${pin.resolvedVersion} pinned by definition ${pin.definitionId} ` +
        `("${pin.definitionName}" v${pin.definitionVersion}) block "${pin.nodeId}" ` +
        `field "${pin.field}": stored body differs from DEFAULT_AGENT_PROMPTS.`,
    )
    .join("\n");
}

function isBuiltInSlug(slug: string): slug is BuiltInPromptSlug {
  return (BUILT_IN_SLUGS as string[]).includes(slug);
}

function authorshipOf(
  version: PromptLibraryVersionRow,
): BuiltInPromptAuthorship {
  return version.createdById === PLATFORM_AUTHOR_ID &&
    version.createdByLabel === PLATFORM_AUTHOR_LABEL
    ? "platform"
    : "customer";
}

/** Every prompt-bearing string of a node, keyed by a locatable field path.
 *  v2 stores them under `configuration`, v1 under `params`; the key set is the
 *  same one the runtime substitutes and resolves through. */
function promptFields(
  definition: WorkflowDefinition,
  node: WorkflowDefinition["nodes"][number],
): { field: string; text: string }[] {
  const source: Record<string, unknown> =
    definition.schemaVersion === 2
      ? (node as { configuration: Record<string, unknown> }).configuration
      : (node as { params: Record<string, unknown> }).params;
  const out: { field: string; text: string }[] = [];
  for (const key of WORKFLOW_PROMPT_PARAM_KEYS[node.type] ?? []) {
    const value = source?.[key];
    if (typeof value === "string") {
      out.push({ field: key, text: value });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string") out.push({ field: `${key}/${index}`, text: item });
      });
    }
  }
  return out;
}

export async function findBuiltInPromptDrift(
  db: Db,
): Promise<BuiltInPromptDriftReport> {
  const definitionRows = await db
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
    );

  const pins: BuiltInPromptPin[] = [];
  const unresolved: UnresolvedPromptReference[] = [];
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
      if (isBuiltInSlug(prompt.slug)) {
        pins.push({
          ...coordinates,
          slug: prompt.slug,
          requestedVersion: token.version,
          resolvedVersion: version.version,
          authorship: authorshipOf(version),
          matchesConstant: version.body === DEFAULT_AGENT_PROMPTS[prompt.slug],
        });
      }
      const resolvedKey = `${prompt.id}@${version.version}`;
      if (seen.includes(resolvedKey)) continue;
      await walk(version.body, coordinates, [...seen, resolvedKey]);
    }
  };

  for (const row of definitionRows) {
    const definition = row.definition as WorkflowDefinition;
    if (!Array.isArray(definition?.nodes)) continue;
    for (const node of definition.nodes) {
      const base = {
        definitionId: row.id,
        definitionName: row.name,
        definitionVersion: row.version,
        nodeId: node.id,
      };
      const fields = promptFields(definition, node);
      for (const { field, text } of fields) {
        await walk(text, { ...base, field }, []);
      }
      if (definition.schemaVersion !== 1) continue;
      // v1 supplies a specialized agent's prompt implicitly when the field is
      // blank: the run materializes {{prompt:<slug>}} (latest) from the library
      // row matching the built-in's name, so that body reaches the agent too.
      const implicitName = DEFAULT_PROMPT_NAME_BY_AGENT[node.type];
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

  return {
    pins,
    drift: pins.filter(
      (pin) => pin.authorship === "platform" && !pin.matchesConstant,
    ),
    customerAuthored: pins.filter((pin) => pin.authorship === "customer"),
    unresolved,
  };
}
