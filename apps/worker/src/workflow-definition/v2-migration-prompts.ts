import {
  containsMalformedPromptReference,
  DEFAULT_FIX_PROMPT,
  DEFAULT_PROMPT_NAME_BY_AGENT,
  formatPromptReferenceToken,
  parsePromptReferenceTokens,
  type WorkflowDefinitionV1,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  createPromptReferenceLoader,
  findPromptRowsByNames,
  getPrompt,
} from "../prompt-library/store.js";
import { VARIABLE_PARAM_KEYS } from "../workflows/prompt-vars.js";
import type {
  LoadedPromptReference,
  PromptReferenceLoader,
} from "../workflows/prompt-references.js";
import type { WorkflowV2MigrationDiagnostic } from "./v2-converter.js";

const MAX_PROMPT_REFERENCE_DEPTH = 10;
const MAX_MIGRATED_PROMPT_LENGTH = 200_000;

export interface PreparedWorkflowV1Prompts {
  definition: WorkflowDefinitionV1;
  conversions: WorkflowV2MigrationDiagnostic[];
  blockers: WorkflowV2MigrationDiagnostic[];
}

/**
 * Materializes v1's implicit specialized-agent prompts and freezes every
 * reusable prompt reference to the behavior observed by this preview.
 *
 * Safe prompt references remain references. When an immutable prompt version
 * contains legacy nested composition, only that composition is snapshotted
 * into the workflow so migration never mutates the shared prompt library.
 */
export async function prepareWorkflowV1PromptsForMigration(
  db: Db,
  definition: WorkflowDefinitionV1,
): Promise<PreparedWorkflowV1Prompts> {
  const prepared = structuredClone(definition);
  const conversions: WorkflowV2MigrationDiagnostic[] = [];
  const blockers: WorkflowV2MigrationDiagnostic[] = [];

  await materializeImplicitAgentPrompts(
    db,
    prepared,
    conversions,
    blockers,
  );

  const canonicalizer = new MigrationPromptCanonicalizer(
    createPromptReferenceLoader(db),
    async (promptId) => (await getPrompt(db, promptId))?.slug ?? null,
    conversions,
  );
  for (const [nodeIndex, node] of prepared.nodes.entries()) {
    for (const paramName of VARIABLE_PARAM_KEYS[node.type] ?? []) {
      const current = node.params[paramName];
      const path = `/nodes/${nodeIndex}/params/${pointerSegment(paramName)}`;
      if (typeof current === "string") {
        try {
          node.params[paramName] = await canonicalizer.canonicalize(
            current,
            node.id,
            path,
          );
        } catch (error) {
          blockers.push(promptBlocker(node.id, path, error));
        }
        continue;
      }
      if (!Array.isArray(current)) continue;
      const next = [...current];
      for (const [index, value] of current.entries()) {
        if (typeof value !== "string") continue;
        try {
          next[index] = await canonicalizer.canonicalize(
            value,
            node.id,
            `${path}/${index}`,
          );
        } catch (error) {
          blockers.push(promptBlocker(node.id, `${path}/${index}`, error));
        }
      }
      node.params[paramName] = next;
    }
  }

  return {
    definition: prepared,
    conversions: dedupeDiagnostics(conversions),
    blockers: dedupeDiagnostics(blockers),
  };
}

async function materializeImplicitAgentPrompts(
  db: Db,
  definition: WorkflowDefinitionV1,
  conversions: WorkflowV2MigrationDiagnostic[],
  blockers: WorkflowV2MigrationDiagnostic[],
): Promise<void> {
  const requiredNames = [
    ...new Set(
      definition.nodes.flatMap((node) => {
        const name = DEFAULT_PROMPT_NAME_BY_AGENT[node.type];
        const current = node.params.prompt;
        return name &&
          !(typeof current === "string" && current.trim().length > 0)
          ? [name]
          : [];
      }),
    ),
  ];
  const rows = await findPromptRowsByNames(db, requiredNames);

  for (const [nodeIndex, node] of definition.nodes.entries()) {
    if (node.type === "fix_agent") {
      const current = node.params.instructions;
      if (!(typeof current === "string" && current.trim().length > 0)) {
        node.params.instructions = DEFAULT_FIX_PROMPT;
        conversions.push({
          code: "migration.prompt.default_materialized",
          message: `Added the standard Fix Agent instructions that v1 supplied implicitly.`,
          nodeId: node.id,
          path: `/nodes/${nodeIndex}/params/instructions`,
        });
      }
      continue;
    }

    const name = DEFAULT_PROMPT_NAME_BY_AGENT[node.type];
    if (!name) continue;
    const current = node.params.prompt;
    if (typeof current === "string" && current.trim().length > 0) continue;
    const active = rows.find(
      (row) => row.name === name && row.archivedAt === null,
    );
    const path = `/nodes/${nodeIndex}/params/prompt`;
    if (!active) {
      blockers.push({
        code: "migration.prompt.default_unavailable",
        message: `Block "${node.id}" relies on the v1 default prompt "${name}", but that prompt is missing or archived.`,
        nodeId: node.id,
        path,
      });
      continue;
    }
    node.params.prompt = formatPromptReferenceToken({
      slug: active.slug,
      version: "latest",
    });
    conversions.push({
      code: "migration.prompt.default_materialized",
      message: `Added the standard ${humanAgentName(node.type)} prompt that v1 supplied implicitly.`,
      nodeId: node.id,
      path,
    });
  }
}

class MigrationPromptCanonicalizer {
  private readonly promptSlugs = new Map<number, Promise<string | null>>();

  constructor(
    private readonly load: PromptReferenceLoader,
    private readonly loadSlug: (promptId: number) => Promise<string | null>,
    private readonly conversions: WorkflowV2MigrationDiagnostic[],
  ) {}

  canonicalize(
    source: string,
    nodeId: string,
    path: string,
  ): Promise<string> {
    return this.expand(source, nodeId, path, []);
  }

  private async expand(
    source: string,
    nodeId: string,
    path: string,
    stack: string[],
  ): Promise<string> {
    if (containsMalformedPromptReference(source)) {
      throw new Error(
        "Malformed reusable-prompt reference; expected {{prompt:<slug>}} or {{prompt:<slug>@<version>}}.",
      );
    }
    const tokens = parsePromptReferenceTokens(source);
    if (tokens.length === 0) {
      assertPromptLength(source);
      return source;
    }

    let output = "";
    let cursor = 0;
    for (const token of tokens) {
      output += source.slice(cursor, token.start);
      if (stack.length >= MAX_PROMPT_REFERENCE_DEPTH) {
        throw new Error(
          `Reusable-prompt nesting exceeds ${MAX_PROMPT_REFERENCE_DEPTH} levels.`,
        );
      }
      const loaded = await this.load(
        token.slug === undefined
          ? { legacyPromptId: token.legacyPromptId }
          : { slug: token.slug },
        token.version,
      );
      const resolvedKey = `${loaded.promptId}@${loaded.resolvedVersion}`;
      if (stack.includes(resolvedKey)) {
        throw new Error(
          `Reusable-prompt cycle: ${[...stack, resolvedKey].join(" -> ")}.`,
        );
      }
      const slug = await this.slugFor(loaded);
      const canonicalBody = await this.expand(
        loaded.body,
        nodeId,
        path,
        [...stack, resolvedKey],
      );
      const canonicalReference = formatPromptReferenceToken({
        slug,
        version: loaded.resolvedVersion,
      });

      if (canonicalBody === loaded.body) {
        output += canonicalReference;
        if (canonicalReference !== token.raw) {
          this.conversions.push({
            code: "migration.prompt.reference_pinned",
            message: `Pinned "${token.raw}" to "${canonicalReference}".`,
            nodeId,
            path,
          });
        }
      } else {
        output += canonicalBody;
        this.conversions.push({
          code: "migration.prompt.nested_snapshot",
          message: `Snapshotted legacy nested prompt composition from "${token.raw}" without changing its resolved content.`,
          nodeId,
          path,
        });
      }
      assertPromptLength(output);
      cursor = token.end;
    }
    output += source.slice(cursor);
    assertPromptLength(output);
    return output;
  }

  private async slugFor(loaded: LoadedPromptReference): Promise<string> {
    let pending = this.promptSlugs.get(loaded.promptId);
    if (!pending) {
      pending = this.loadSlug(loaded.promptId);
      this.promptSlugs.set(loaded.promptId, pending);
    }
    const slug = await pending;
    if (!slug) {
      throw new Error(
        `Reusable prompt #${loaded.promptId} disappeared during migration preview.`,
      );
    }
    return slug;
  }
}

function assertPromptLength(value: string): void {
  if (value.length > MAX_MIGRATED_PROMPT_LENGTH) {
    throw new Error(
      `Resolved prompt exceeds ${MAX_MIGRATED_PROMPT_LENGTH} characters.`,
    );
  }
}

function promptBlocker(
  nodeId: string,
  path: string,
  error: unknown,
): WorkflowV2MigrationDiagnostic {
  return {
    code: "migration.prompt.resolution_failed",
    message: `Block "${nodeId}" prompt could not be migrated safely: ${
      error instanceof Error ? error.message : "Reusable-prompt resolution failed."
    }`,
    nodeId,
    path,
  };
}

function humanAgentName(type: string): string {
  return type
    .replace(/_agent$/, " Agent")
    .replaceAll("_", " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function dedupeDiagnostics(
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
