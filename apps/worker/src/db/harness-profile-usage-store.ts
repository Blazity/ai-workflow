import { asc, desc, inArray, isNull } from "drizzle-orm";
import type { HarnessProfileUsageDto } from "@shared/contracts";
import { getDb, type Db } from "./client.js";
import {
  workflowDefinitions,
  workflowDefinitionVersions,
} from "./schema.js";

function collectProfileReferenceVersions(
  value: unknown,
  profileId: string,
  versions: Set<number>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProfileReferenceVersions(item, profileId, versions);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.profileId === profileId &&
    typeof record.version === "number" &&
    Number.isSafeInteger(record.version) &&
    record.version > 0
  ) {
    versions.add(record.version);
  }
  for (const nested of Object.values(record)) {
    collectProfileReferenceVersions(nested, profileId, versions);
  }
}

export async function listHarnessProfileUsage(
  db: Db,
  profileId: string,
): Promise<HarnessProfileUsageDto[]> {
  const definitions = await db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      deployedVersion: workflowDefinitions.deployedVersion,
    })
    .from(workflowDefinitions)
    .where(isNull(workflowDefinitions.archivedAt))
    .orderBy(asc(workflowDefinitions.name));
  if (definitions.length === 0) return [];
  const rows = await db
    .select({
      definitionId: workflowDefinitionVersions.definitionId,
      version: workflowDefinitionVersions.version,
      definition: workflowDefinitionVersions.definition,
    })
    .from(workflowDefinitionVersions)
    .where(
      inArray(
        workflowDefinitionVersions.definitionId,
        definitions.map((definition) => definition.id),
      ),
    )
    .orderBy(
      asc(workflowDefinitionVersions.definitionId),
      desc(workflowDefinitionVersions.version),
    );
  const rowsByDefinition = new Map<number, typeof rows>();
  for (const row of rows) {
    const current = rowsByDefinition.get(row.definitionId) ?? [];
    current.push(row);
    rowsByDefinition.set(row.definitionId, current);
  }
  const usage: HarnessProfileUsageDto[] = [];
  for (const definition of definitions) {
    const definitionRows = rowsByDefinition.get(definition.id) ?? [];
    const head = definitionRows[0];
    const deployed = definition.deployedVersion
      ? definitionRows.find(
          (candidate) => candidate.version === definition.deployedVersion,
        )
      : undefined;
    const relevant = [head, deployed].filter(
      (
        candidate,
        index,
        candidates,
      ): candidate is NonNullable<typeof candidate> =>
        Boolean(candidate) &&
        candidates.findIndex(
          (other) => other?.version === candidate?.version,
        ) === index,
    );
    const referencedVersions = new Set<number>();
    for (const candidate of relevant) {
      collectProfileReferenceVersions(
        candidate.definition,
        profileId,
        referencedVersions,
      );
    }
    if (referencedVersions.size > 0) {
      usage.push({
        definitionId: definition.id,
        name: definition.name,
        versions: [...referencedVersions].sort((left, right) => left - right),
        deployed: Boolean(
          deployed &&
            (() => {
              const versions = new Set<number>();
              collectProfileReferenceVersions(
                deployed.definition,
                profileId,
                versions,
              );
              return versions.size > 0;
            })(),
        ),
      });
    }
  }
  return usage;
}

export function listConnectedHarnessProfileUsage(profileId: string) {
  return listHarnessProfileUsage(getDb(), profileId);
}
