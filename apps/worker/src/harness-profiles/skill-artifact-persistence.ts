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
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  harnessSkillArtifactFiles,
  harnessSkillArtifacts,
} from "../db/schema.js";
import { sha256Digest } from "./skill-artifact-digest.js";
import { HarnessSkillImportError } from "./skill-errors.js";
import { readHarnessSkillArtifactSource } from "./store.js";

export interface PersistableSkillArtifact {
  artifactHash: string;
  name: string;
  description: string;
  source: HarnessSkillSource;
  files: Array<HarnessSkillArtifactFile & { contentBase64: string }>;
}

export async function persistHarnessSkillArtifacts(
  db: Db,
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
  await db.execute(sql`
    WITH imported_artifact (
      artifact_hash,
      name,
      description,
      source_kind,
      source_owner,
      source_repository,
      source_path,
      source_commit_sha,
      local_path,
      local_content_sha256
    ) AS (
      VALUES ${sql.join(artifactRows, sql`, `)}
    ), inserted_artifact AS (
      INSERT INTO harness_skill_artifacts (
        organization_id,
        artifact_hash,
        name,
        description,
        source_kind,
        source_owner,
        source_repository,
        source_path,
        source_commit_sha,
        local_path,
        local_content_sha256,
        created_by_id
      )
      SELECT
        ${input.organizationId},
        artifact_hash,
        name,
        description,
        source_kind,
        source_owner,
        source_repository,
        source_path,
        source_commit_sha,
        local_path,
        local_content_sha256,
        ${input.actorId}
      FROM imported_artifact
      ON CONFLICT (organization_id, artifact_hash) DO NOTHING
      RETURNING id, artifact_hash
    ), stored_artifact AS (
      SELECT inserted.id, inserted.artifact_hash
      FROM inserted_artifact inserted
      UNION ALL
      SELECT artifact.id, artifact.artifact_hash
      FROM harness_skill_artifacts artifact
      INNER JOIN imported_artifact imported
        ON imported.artifact_hash = artifact.artifact_hash
      WHERE artifact.organization_id = ${input.organizationId}
        AND NOT EXISTS (
          SELECT 1
          FROM inserted_artifact inserted
          WHERE inserted.artifact_hash = artifact.artifact_hash
        )
    ), imported_file (
      artifact_hash,
      path,
      mode,
      size_bytes,
      sha256,
      content_base64
    ) AS (
      VALUES ${sql.join(fileRows, sql`, `)}
    )
    INSERT INTO harness_skill_artifact_files (
      artifact_id,
      path,
      mode,
      size_bytes,
      sha256,
      content_base64
    )
    SELECT
      stored.id,
      file.path,
      file.mode,
      file.size_bytes,
      file.sha256,
      file.content_base64
    FROM imported_file file
    INNER JOIN stored_artifact stored
      ON stored.artifact_hash = file.artifact_hash
    ON CONFLICT (artifact_id, path) DO NOTHING
  `);

  const storedArtifacts = await db
    .select()
    .from(harnessSkillArtifacts)
    .where(
      and(
        eq(harnessSkillArtifacts.organizationId, input.organizationId),
        inArray(
          harnessSkillArtifacts.artifactHash,
          input.artifacts.map((artifact) => artifact.artifactHash),
        ),
      ),
  );
  if (storedArtifacts.length !== input.artifacts.length) {
    throw new HarnessSkillImportError(
      409,
      "Could not persist all skill artifacts",
    );
  }

  const storedByHash = new Map(
    storedArtifacts.map((artifact) => [artifact.artifactHash, artifact]),
  );
  const storedFiles = await db
    .select()
    .from(harnessSkillArtifactFiles)
    .where(
      inArray(
        harnessSkillArtifactFiles.artifactId,
        storedArtifacts.map((artifact) => artifact.id),
      ),
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
