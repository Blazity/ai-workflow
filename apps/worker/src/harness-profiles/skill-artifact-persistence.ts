import type {
  HarnessSkillArtifact,
  HarnessSkillArtifactFile,
  HarnessSkillSource,
} from "@shared/contracts";
import {
  HarnessSkillArtifactIntegrityError,
  isGitHubSkillSource,
  verifyHarnessSkillArtifact,
} from "@shared/skills";
import { sql } from "drizzle-orm";
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

  const artifactRows = input.artifacts.map((artifact) => {
    const source = artifact.source;
    const columns = isGitHubSkillSource(source)
      ? {
          kind: "github",
          owner: source.owner,
          repository: source.repository,
          path: source.path,
          commitSha: source.commitSha,
          localPath: null,
          localContentSha256: null,
        }
      : {
          kind: "local",
          owner: null,
          repository: null,
          path: null,
          commitSha: null,
          localPath: source.path,
          localContentSha256: source.contentSha256,
        };
    return sql`(
        ${artifact.artifactHash}::text,
        ${artifact.name}::text,
        ${artifact.description}::text,
        ${columns.kind}::text,
        ${columns.owner}::text,
        ${columns.repository}::text,
        ${columns.path}::text,
        ${columns.commitSha}::text,
        ${columns.localPath}::text,
        ${columns.localContentSha256}::text
      )`;
  });
  const fileRows = input.artifacts.flatMap((artifact) =>
    artifact.files.map(
      (file) =>
        sql`(
          ${artifact.artifactHash}::text,
          ${file.path}::text,
          ${file.mode}::integer,
          ${file.sizeBytes}::integer,
          ${file.sha256}::text,
          ${file.contentBase64}::text
        )`,
    ),
  );
  await repository.persistArtifactRows({
    organizationId: input.organizationId,
    actorId: input.actorId,
    artifactRows,
    fileRows,
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
