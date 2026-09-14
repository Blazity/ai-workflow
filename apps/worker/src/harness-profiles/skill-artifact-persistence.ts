import type {
  HarnessSkillArtifact,
  HarnessSkillArtifactFile,
  HarnessSkillSource,
} from "@shared/contracts";
import {
  HarnessSkillArtifactIntegrityError,
  verifyHarnessSkillArtifact,
} from "@shared/skills";
import { sha256Digest } from "./skill-artifact-digest.js";
import { HarnessSkillImportError } from "./skill-errors.js";
import {
  createHarnessProfileRepository,
  readHarnessSkillArtifactSource,
} from "../db/repositories/harness-profiles.js";

type HarnessProfileRepository = ReturnType<typeof createHarnessProfileRepository>;

export interface PersistableSkillArtifact {
  artifactHash: string;
  name: string;
  description: string;
  source: HarnessSkillSource;
  files: Array<HarnessSkillArtifactFile & { contentBase64: string }>;
}

export async function persistHarnessSkillArtifactsFromRepository(
  repository: HarnessProfileRepository,
  input: {
    organizationId: string;
    actorId: string;
    artifacts: PersistableSkillArtifact[];
  },
): Promise<HarnessSkillArtifact[]> {
  for (const artifact of input.artifacts) {
    verifyHarnessSkillArtifact(
      {
        artifactHash: artifact.artifactHash,
        name: artifact.name,
        description: artifact.description,
        source: artifact.source,
        files: artifact.files,
      },
      sha256Digest,
    );
  }

  await repository.persistArtifacts({
    organizationId: input.organizationId,
    actorId: input.actorId,
    artifacts: input.artifacts,
  });

  const { artifacts: storedArtifacts, files: storedFiles } =
    await repository.getArtifactEnvelope({
      organizationId: input.organizationId,
      artifactHashes: input.artifacts.map((artifact) => artifact.artifactHash),
    });
  if (storedArtifacts.length !== input.artifacts.length) {
    throw new HarnessSkillImportError(
      409,
      "Could not persist all skill artifacts",
    );
  }

  const storedByHash = new Map(
    storedArtifacts.map((artifact) => [artifact.artifactHash, artifact]),
  );
  const filesByArtifactId = new Map<number, typeof storedFiles>();
  for (const file of storedFiles) {
    const files = filesByArtifactId.get(file.artifactId) ?? [];
    files.push(file);
    filesByArtifactId.set(file.artifactId, files);
  }

  return input.artifacts.map((artifact) => {
    const stored = storedByHash.get(artifact.artifactHash);
    if (!stored) {
      throw new HarnessSkillImportError(
        409,
        "Could not persist all skill artifacts",
      );
    }
    const files = filesByArtifactId.get(stored.id) ?? [];
    let source: HarnessSkillSource;
    try {
      source = readHarnessSkillArtifactSource(stored);
      verifyHarnessSkillArtifact(
        {
          artifactHash: stored.artifactHash,
          name: stored.name,
          description: stored.description,
          source,
          files,
        },
        sha256Digest,
      );
    } catch (error) {
      if (!(error instanceof HarnessSkillArtifactIntegrityError)) throw error;
      throw new HarnessSkillImportError(
        409,
        "Stored skill artifact failed integrity verification",
      );
    }
    return {
      artifactHash: stored.artifactHash,
      organizationId: stored.organizationId,
      name: stored.name,
      description: stored.description,
      source,
      files: files
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((file) => ({
          path: file.path,
          mode: file.mode,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
        })),
      createdAt: stored.createdAt.toISOString(),
      createdById: stored.createdById,
    };
  });
}
